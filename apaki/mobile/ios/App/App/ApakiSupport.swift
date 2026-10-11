// ApakiSupport.swift: small helpers the Apaki app's plugins share
// (apaki/mobile, 2026-10-10): the Keychain, base64url, colours.
//
// Every Keychain item the app writes is a generic password, readable after
// the first unlock since boot (so a reconnect works while the phone is
// locked in a pocket), on this device only (never synced to iCloud and never
// restored onto another phone).

import Foundation
import Security
import UIKit

struct KeychainError: Error, LocalizedError {
    let status: OSStatus
    var errorDescription: String? {
        let text = SecCopyErrorMessageString(status, nil) as String? ?? "unknown"
        return "Keychain error \(status) (\(text))"
    }
}

enum Keychain {
    private static func base(_ service: String, _ account: String? = nil) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
        ]
        if let account { q[kSecAttrAccount as String] = account }
        return q
    }

    static func set(service: String, account: String, data: Data) throws {
        let attrs: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(base(service, account) as CFDictionary, attrs as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw KeychainError(status: status) }
        var add = base(service, account)
        for (k, v) in attrs { add[k] = v }
        let added = SecItemAdd(add as CFDictionary, nil)
        guard added == errSecSuccess else { throw KeychainError(status: added) }
    }

    static func get(service: String, account: String) throws -> Data? {
        var q = base(service, account)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        return out as? Data
    }

    static func remove(service: String, account: String) throws {
        let status = SecItemDelete(base(service, account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }

    /// The account names of every item in a service (attributes only; read each value with get).
    static func accounts(service: String) throws -> [String] {
        var q = base(service)
        q[kSecReturnAttributes as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitAll
        var out: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &out)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        let items = out as? [[String: Any]] ?? []
        return items.compactMap { $0[kSecAttrAccount as String] as? String }.sorted()
    }
}

enum Base64URL {
    static func encode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    static func decode(_ text: String) -> Data? {
        var s = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        let pad = (4 - s.count % 4) % 4
        s += String(repeating: "=", count: pad)
        return Data(base64Encoded: s)
    }
}

extension UIColor {
    /// #rgb or #rrggbb, as the page's CSS writes Apaki's grounds.
    convenience init?(cssHex: String) {
        var s = cssHex.trimmingCharacters(in: .whitespaces)
        guard s.hasPrefix("#") else { return nil }
        s.removeFirst()
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(red: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
    }

    /// Apaki's ground: #FDFDFF light, #121120 dark (apaki/ui/app.css).
    static let apakiGround = UIColor { traits in
        traits.userInterfaceStyle == .dark ? UIColor(cssHex: "#121120")! : UIColor(cssHex: "#FDFDFF")!
    }
}
