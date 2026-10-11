// ApakiNetPlugin.swift: the Apaki app's network (apaki/mobile, 2026-10-10).
// JS: ApakiNet (src/cap.js), used by src/native-socket.js and src/native-http.js.
//
// The page in the WebView connects to nothing itself (its CSP is
// connect-src 'self'). This plugin is the only way out, and it goes to one
// place:
//   - WebSockets to wss://apaki.myrlin.io/v1/rooms/<22-char room id>/phone,
//     the phone side of a relay room. The frames are end-to-end encrypted by
//     the page (apaki/remote/protocol.js); this only moves bytes. The relay
//     takes phone sockets from the phone page's origin only, so the request
//     carries Origin: https://apaki.myrlin.io: this app is that page, built
//     from the same commit and shipped inside it (README.md, Security).
//   - HTTPS requests to https://apaki.myrlin.io/v1/... (the Apaki account
//     API and room presence), with no Origin, cookies or cache, and no
//     redirects anywhere else.
// Back in the foreground, every open socket gets a ping; one that does not
// answer within 4 s is reported closed at once, so the page reconnects
// right away instead of waiting for a timeout.
//
//   socketOpen({ id, url, protocols }), socketSend({ id, text | data }), socketClose({ id, code, reason })
//   events 'socket': { id, type: open | message | close | error, protocol?, text?, data?, code?, reason? }
//   http({ url, method, headers, body }) -> { status, headers, body }

import Capacitor
import Foundation
import UIKit

@objc(ApakiNetPlugin)
public class ApakiNetPlugin: CAPPlugin, CAPBridgedPlugin, URLSessionWebSocketDelegate {
    public let identifier = "ApakiNetPlugin"
    public let jsName = "ApakiNet"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "socketOpen", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "socketSend", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "socketClose", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "http", returnType: CAPPluginReturnPromise),
    ]

    static let host = "apaki.myrlin.io"
    static let siteOrigin = "https://apaki.myrlin.io"
    private static let maxMessage = 256 * 1024
    private static let maxBody = 128 * 1024
    private static let headerAllow: Set<String> = ["content-type", "authorization", "accept"]

    /// Everything about sockets happens on this one serial queue (also the session's delegate queue), in order.
    private let queue = DispatchQueue(label: "io.myrlin.apaki.net")
    private var sockets: [String: URLSessionWebSocketTask] = [:]
    private var idsByTask: [Int: String] = [:]

    private lazy var session: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.httpCookieStorage = nil
        cfg.httpShouldSetCookies = false
        cfg.urlCache = nil
        cfg.requestCachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        cfg.timeoutIntervalForRequest = 30
        let ops = OperationQueue()
        ops.maxConcurrentOperationCount = 1
        ops.underlyingQueue = queue
        return URLSession(configuration: cfg, delegate: self, delegateQueue: ops)
    }()

    override public func load() {
        NotificationCenter.default.addObserver(self, selector: #selector(cameForward), name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    // MARK: where the app may go

    static func socketAllowed(_ url: URL) -> Bool {
        guard url.scheme == "wss", url.host == host, url.port == nil, url.user == nil, url.password == nil, url.query == nil, url.fragment == nil else { return false }
        let parts = url.path.split(separator: "/", omittingEmptySubsequences: false)
        // "", "v1", "rooms", <room id>, "phone"
        guard parts.count == 5, parts[0].isEmpty, parts[1] == "v1", parts[2] == "rooms", parts[4] == "phone" else { return false }
        let room = parts[3]
        return room.count == 22 && room.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) && $0.isASCII || $0 == "-" || $0 == "_" }
    }

    static func requestAllowed(_ url: URL) -> Bool {
        url.scheme == "https" && url.host == host && url.port == nil && url.user == nil && url.password == nil && url.path.hasPrefix("/v1/") && !url.path.contains("..")
    }

    // MARK: sockets

    @objc func socketOpen(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty, let text = call.getString("url"), let url = URL(string: text), Self.socketAllowed(url) else {
            call.reject("The app connects to the Apaki relay only.", "refused")
            return
        }
        // Subprotocol tokens only (apaki.v1); anything else is dropped.
        let protocols = (call.getArray("protocols", String.self) ?? []).filter { p in
            !p.isEmpty && p.count <= 64 && p.unicodeScalars.allSatisfy { CharacterSet.alphanumerics.contains($0) && $0.isASCII || ".-_".unicodeScalars.contains($0) }
        }
        var request = URLRequest(url: url)
        request.timeoutInterval = 20
        request.setValue(Self.siteOrigin, forHTTPHeaderField: "Origin")
        if !protocols.isEmpty { request.setValue(protocols.joined(separator: ", "), forHTTPHeaderField: "Sec-WebSocket-Protocol") }
        queue.async {
            if let old = self.sockets[id] { old.cancel(with: .goingAway, reason: nil) }
            let task = self.session.webSocketTask(with: request)
            task.maximumMessageSize = Self.maxMessage
            self.sockets[id] = task
            self.idsByTask[task.taskIdentifier] = id
            task.resume()
            self.receive(id, task)
            call.resolve()
        }
    }

    private func receive(_ id: String, _ task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self else { return }
            self.queue.async {
                guard self.idsByTask[task.taskIdentifier] == id else { return }
                switch result {
                case .success(.string(let text)):
                    self.notifyListeners("socket", data: ["id": id, "type": "message", "text": text])
                case .success(.data(let data)):
                    self.notifyListeners("socket", data: ["id": id, "type": "message", "data": Base64URL.encode(data)])
                case .success:
                    break
                case .failure:
                    // The task's completion reports the close.
                    return
                }
                self.receive(id, task)
            }
        }
    }

    @objc func socketSend(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("Bad send.", "args"); return }
        let message: URLSessionWebSocketTask.Message
        if let text = call.getString("text") {
            message = .string(text)
        } else if let b64 = call.getString("data"), let data = Base64URL.decode(b64) {
            message = .data(data)
        } else {
            call.reject("Bad send.", "args")
            return
        }
        queue.async {
            guard let task = self.sockets[id] else { call.reject("The socket is closed.", "closed"); return }
            task.send(message) { error in
                if let error { call.reject(error.localizedDescription, "send") } else { call.resolve() }
            }
        }
    }

    @objc func socketClose(_ call: CAPPluginCall) {
        guard let id = call.getString("id") else { call.reject("Bad close.", "args"); return }
        let code = call.getInt("code") ?? 1000
        let reason = String((call.getString("reason") ?? "").prefix(120))
        queue.async {
            guard let task = self.sockets[id] else { call.resolve(); return }
            task.cancel(with: URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure, reason: reason.data(using: .utf8))
            self.finish(task, code: code, reason: reason)
            call.resolve()
        }
    }

    /// Reports a socket closed, once, and forgets it. On the queue.
    private func finish(_ task: URLSessionWebSocketTask, code: Int, reason: String) {
        guard let id = idsByTask.removeValue(forKey: task.taskIdentifier) else { return }
        sockets.removeValue(forKey: id)
        notifyListeners("socket", data: ["id": id, "type": "close", "code": code, "reason": reason])
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didOpenWithProtocol protocol: String?) {
        guard let id = idsByTask[webSocketTask.taskIdentifier] else { return }
        notifyListeners("socket", data: ["id": id, "type": "open", "protocol": `protocol` ?? ""])
    }

    public func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask, didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        finish(webSocketTask, code: closeCode.rawValue, reason: reason.flatMap { String(data: $0, encoding: .utf8) } ?? "")
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let ws = task as? URLSessionWebSocketTask, let id = idsByTask[ws.taskIdentifier] else { return }
        if let error { notifyListeners("socket", data: ["id": id, "type": "error", "message": error.localizedDescription]) }
        // A refused upgrade (403, 429, 503 from the relay) or a dropped network: 1006, as a browser reports it.
        let code = ws.closeCode == .invalid ? 1006 : ws.closeCode.rawValue
        finish(ws, code: code, reason: error?.localizedDescription ?? "")
    }

    /// No redirects, for sockets or requests: the app talks to apaki.myrlin.io and nowhere else.
    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }

    /// Back in the foreground: a socket that does not answer a ping in 4 s is closed now.
    @objc private func cameForward() {
        queue.async {
            for (id, task) in self.sockets {
                var answered = false
                task.sendPing { [weak self] error in
                    guard let self else { return }
                    self.queue.async {
                        answered = true
                        if error != nil, self.sockets[id] === task {
                            task.cancel(with: .goingAway, reason: nil)
                            self.finish(task, code: 1006, reason: "the connection did not survive the background")
                        }
                    }
                }
                self.queue.asyncAfter(deadline: .now() + 4) {
                    guard !answered, self.sockets[id] === task else { return }
                    task.cancel(with: .goingAway, reason: nil)
                    self.finish(task, code: 1006, reason: "no answer after the app came back")
                }
            }
        }
    }

    // MARK: the account API

    @objc func http(_ call: CAPPluginCall) {
        guard let text = call.getString("url"), let url = URL(string: text), Self.requestAllowed(url) else {
            call.reject("The app calls apaki.myrlin.io/v1/ only.", "refused")
            return
        }
        let method = (call.getString("method") ?? "GET").uppercased()
        guard ["GET", "POST", "PUT", "DELETE"].contains(method) else { call.reject("Bad method.", "args"); return }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        for (name, value) in call.getObject("headers") ?? [:] where Self.headerAllow.contains(name.lowercased()) {
            if let v = value as? String { request.setValue(v, forHTTPHeaderField: name) }
        }
        if let body = call.getString("body") {
            guard body.utf8.count <= Self.maxBody else { call.reject("The request is too large.", "args"); return }
            request.httpBody = Data(body.utf8)
        }
        session.dataTask(with: request) { data, response, error in
            if let error {
                call.reject("No connection to apaki.myrlin.io: \(error.localizedDescription)", "offline")
                return
            }
            let http = response as? HTTPURLResponse
            call.resolve([
                "status": http?.statusCode ?? 0,
                "headers": ["content-type": http?.value(forHTTPHeaderField: "Content-Type") ?? ""],
                "body": String(data: data ?? Data(), encoding: .utf8) ?? "",
            ])
        }.resume()
    }
}
