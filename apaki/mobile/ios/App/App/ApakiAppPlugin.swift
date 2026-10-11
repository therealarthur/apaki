// ApakiAppPlugin.swift: build facts and the WebView's ground colour for the
// Apaki app's page (apaki/mobile, 2026-10-10). JS: ApakiApp (src/cap.js).
//
//   info() -> { debug, demo?, link?, version, build, secureEnclave }
//     debug is true only in a Debug build (#if DEBUG). demo is the
//     -apakiDemo launch argument (pair, list, chat), read in Debug builds
//     only, so a Release app can never be started as the pretend PC
//     (src/entry.js refuses a demo page without debug). link is the
//     -apakiLink launch argument (a pairing link, for Simulator tests), also
//     Debug only.
//   setBackground({ color: "#rrggbb" })
//     the WebView and its window behind the page follow Apaki's theme, so
//     no light edge shows under a dark page while the keyboard moves.
//     2026-10-11: the UIWindow too. The bridge controller's view IS the
//     WebView, so the old "view behind the page" was the page itself and the
//     window behind it stayed black: that black showed beside the keyboard's
//     rounded corners while Keyboard resize was "native" (Arthur's "black
//     triangles"). Resize is "none" now (src/native-shell.js keyboard());
//     this is the backstop for anything that ever shows behind the WebView.

import Capacitor
import CryptoKit
import Foundation
import UIKit

@objc(ApakiAppPlugin)
public class ApakiAppPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ApakiAppPlugin"
    public let jsName = "ApakiApp"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "info", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setBackground", returnType: CAPPluginReturnPromise),
    ]

    @objc func info(_ call: CAPPluginCall) {
        var out: [String: Any] = [
            "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "",
            "build": Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "",
            "secureEnclave": SecureEnclave.isAvailable,
        ]
        #if DEBUG
        out["debug"] = true
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-apakiDemo"), i + 1 < args.count, ["pair", "list", "chat"].contains(args[i + 1]) {
            out["demo"] = args[i + 1]
        }
        // A pairing link handed over at launch (xcrun simctl launch ... -apakiLink apaki://pair#p=...):
        // opening a custom-scheme link from the command line stops at a system prompt nobody can tap.
        if let i = args.firstIndex(of: "-apakiLink"), i + 1 < args.count {
            out["link"] = args[i + 1]
        }
        #else
        out["debug"] = false
        #endif
        call.resolve(out)
    }

    @objc func setBackground(_ call: CAPPluginCall) {
        guard let hex = call.getString("color"), let color = UIColor(cssHex: hex) else { call.reject("Bad colour.", "args"); return }
        DispatchQueue.main.async {
            self.bridge?.webView?.backgroundColor = color
            self.bridge?.webView?.scrollView.backgroundColor = color
            self.bridge?.viewController?.view.backgroundColor = color
            self.bridge?.viewController?.view.window?.backgroundColor = color
            call.resolve()
        }
    }
}
