// ApakiKeysPlugin.swift: the Apaki app's device keys and its small secure
// store (apaki/mobile, 2026-10-10). JS: ApakiKeys (src/cap.js), used by
// src/native-store.js.
//
// Arthur: "when pairing a phone, the paired phone should be good to go
// forever." So:
//   - Each pairing's device key is a P-256 key made in the Secure Enclave.
//     Its private half never exists outside the chip; the app keeps only the
//     enclave's wrapped handle (dataRepresentation, useless on any other
//     device) in the Keychain, and asks the enclave to sign the pairing and
//     reconnect transcripts (apaki/remote/protocol.js deviceSign). The
//     Simulator has no Secure Enclave: there the key is a CryptoKit key in
//     the Keychain, and createKey says so (secureEnclave: false).
//   - The pairing records (room, PC key, device id, psk) and the signed-in
//     account live in the Keychain, not in WebView storage, which iOS may
//     clear when space runs low.
// Both services are readable after the first unlock, this device only.
//
//   createKey() -> { keyId, pub (65-byte point, base64url), secureEnclave }
//   sign({ keyId, data }) -> { sig }    ECDSA P-256 / SHA-256, 64 bytes r||s
//   deleteKey({ keyId }), pruneKeys({ keep: [keyId] }) -> { removed }
//   vaultGet({ key }) -> { value? }, vaultSet({ key, value }), vaultRemove({ key }),
//   vaultList({ prefix }) -> { items: [{ key, value }] }

import Capacitor
import CryptoKit
import Foundation
import Security

@objc(ApakiKeysPlugin)
public class ApakiKeysPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ApakiKeysPlugin"
    public let jsName = "ApakiKeys"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "createKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sign", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteKey", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pruneKeys", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "vaultGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "vaultSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "vaultRemove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "vaultList", returnType: CAPPluginReturnPromise),
    ]

    static let keysService = "io.myrlin.apaki.keys"
    static let storeService = "io.myrlin.apaki.store"

    /// What a stored key blob starts with: which kind of key follows.
    private enum Kind: UInt8 { case secureEnclave = 1, software = 2 }

    private static let keyIdPattern = try! NSRegularExpression(pattern: "^[a-f0-9-]{36}$")
    private static let storeKeyPattern = try! NSRegularExpression(pattern: "^[A-Za-z0-9:_-]{1,80}$")
    private static let maxValueBytes = 64 * 1024
    private static let maxSignBytes = 4096

    private static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    // MARK: device keys

    @objc func createKey(_ call: CAPPluginCall) {
        do {
            let keyId = UUID().uuidString.lowercased()
            let kind: Kind
            let body: Data
            let pub: Data
            if SecureEnclave.isAvailable {
                var cfError: Unmanaged<CFError>?
                // .privateKeyUsage: signing needs no Face ID prompt (reconnects happen on their own),
                // and AfterFirstUnlock lets them happen while the phone is locked.
                guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly, .privateKeyUsage, &cfError) else {
                    throw cfError!.takeRetainedValue() as Error
                }
                let key = try SecureEnclave.P256.Signing.PrivateKey(compactRepresentable: false, accessControl: access)
                kind = .secureEnclave
                body = key.dataRepresentation
                pub = key.publicKey.x963Representation
            } else {
                let key = P256.Signing.PrivateKey(compactRepresentable: false)
                kind = .software
                body = key.rawRepresentation
                pub = key.publicKey.x963Representation
            }
            try Keychain.set(service: Self.keysService, account: keyId, data: Data([kind.rawValue]) + body)
            call.resolve(["keyId": keyId, "pub": Base64URL.encode(pub), "secureEnclave": kind == .secureEnclave])
        } catch {
            call.reject("Could not make a device key: \(error.localizedDescription)", "key")
        }
    }

    @objc func sign(_ call: CAPPluginCall) {
        guard let keyId = call.getString("keyId"), Self.matches(Self.keyIdPattern, keyId),
              let text = call.getString("data"), let data = Base64URL.decode(text), data.count <= Self.maxSignBytes else {
            call.reject("Bad sign request.", "args")
            return
        }
        do {
            guard let blob = try Keychain.get(service: Self.keysService, account: keyId), let first = blob.first, let kind = Kind(rawValue: first) else {
                call.reject("This phone's key for that PC is gone. Pair again with a new code.", "missing")
                return
            }
            let body = Data(blob.dropFirst())
            let signature: Data
            switch kind {
            case .secureEnclave:
                signature = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: body).signature(for: data).rawRepresentation
            case .software:
                signature = try P256.Signing.PrivateKey(rawRepresentation: body).signature(for: data).rawRepresentation
            }
            call.resolve(["sig": Base64URL.encode(signature)])
        } catch {
            call.reject("The device key could not sign: \(error.localizedDescription)", "sign")
        }
    }

    @objc func deleteKey(_ call: CAPPluginCall) {
        guard let keyId = call.getString("keyId"), Self.matches(Self.keyIdPattern, keyId) else { call.reject("Bad key id.", "args"); return }
        do {
            try Keychain.remove(service: Self.keysService, account: keyId)
            call.resolve()
        } catch {
            call.reject(error.localizedDescription, "keychain")
        }
    }

    /// Deletes every device key not in `keep` (keys of pairings that never finished).
    @objc func pruneKeys(_ call: CAPPluginCall) {
        let keep = Set(call.getArray("keep", String.self) ?? [])
        do {
            var removed = 0
            for keyId in try Keychain.accounts(service: Self.keysService) where !keep.contains(keyId) {
                try Keychain.remove(service: Self.keysService, account: keyId)
                removed += 1
            }
            call.resolve(["removed": removed])
        } catch {
            call.reject(error.localizedDescription, "keychain")
        }
    }

    // MARK: the store

    private func storeKey(_ call: CAPPluginCall) -> String? {
        guard let key = call.getString("key"), Self.matches(Self.storeKeyPattern, key) else {
            call.reject("Bad store key.", "args")
            return nil
        }
        return key
    }

    @objc func vaultGet(_ call: CAPPluginCall) {
        guard let key = storeKey(call) else { return }
        do {
            if let data = try Keychain.get(service: Self.storeService, account: key), let value = String(data: data, encoding: .utf8) {
                call.resolve(["value": value])
            } else {
                call.resolve([:])
            }
        } catch {
            call.reject(error.localizedDescription, "keychain")
        }
    }

    @objc func vaultSet(_ call: CAPPluginCall) {
        guard let key = storeKey(call) else { return }
        guard let value = call.getString("value"), value.utf8.count <= Self.maxValueBytes else { call.reject("Bad store value.", "args"); return }
        do {
            try Keychain.set(service: Self.storeService, account: key, data: Data(value.utf8))
            call.resolve()
        } catch {
            call.reject(error.localizedDescription, "keychain")
        }
    }

    @objc func vaultRemove(_ call: CAPPluginCall) {
        guard let key = storeKey(call) else { return }
        do {
            try Keychain.remove(service: Self.storeService, account: key)
            call.resolve()
        } catch {
            call.reject(error.localizedDescription, "keychain")
        }
    }

    @objc func vaultList(_ call: CAPPluginCall) {
        let prefix = call.getString("prefix") ?? ""
        do {
            var items: [[String: String]] = []
            for key in try Keychain.accounts(service: Self.storeService) where key.hasPrefix(prefix) {
                if let data = try Keychain.get(service: Self.storeService, account: key), let value = String(data: data, encoding: .utf8) {
                    items.append(["key": key, "value": value])
                }
            }
            call.resolve(["items": items])
        } catch {
            call.reject(error.localizedDescription, "keychain")
        }
    }
}
