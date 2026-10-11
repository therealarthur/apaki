// ApakiPasskeysPlugin.swift: Apaki account passkeys in the app (apaki/mobile,
// 2026-10-10). JS: ApakiPasskeys (src/cap.js), used by src/passkeys.js, which
// gives apaki/web/src/account.js the navigator.credentials it expects.
//
// The account's vault opens with a key only the user's passkey can produce:
// the WebAuthn PRF extension (apaki/remote/ACCOUNTS.md). iOS 18 offers PRF to
// apps through ASAuthorizationPlatformPublicKeyCredentialProvider. For the
// relying party apaki.myrlin.io the app needs the Associated Domains
// entitlement webcredentials:apaki.myrlin.io and the site's
// apple-app-site-association file listing this app (relay/site/.well-known/;
// README.md says what to fill in). The system then writes client data with
// origin https://apaki.myrlin.io, exactly what the account server checks, so
// one passkey works in Safari and in the app.
//
//   support() -> { available, prf }
//   create({ rpId, challenge, userId, name, prfSalt?, exclude? })
//     -> { id, clientDataJSON, attestationObject, prfSupported, prf? }
//   get({ rpId, challenge, allow?, prfSalt? })
//     -> { id, clientDataJSON, authenticatorData, signature, userHandle, prfSupported, prf? }
// Binary values are base64url. Errors carry a code: cancelled, exists,
// unsupported, webauthn, args.

import AuthenticationServices
import Capacitor
import Foundation
import UIKit

@objc(ApakiPasskeysPlugin)
public class ApakiPasskeysPlugin: CAPPlugin, CAPBridgedPlugin, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    public let identifier = "ApakiPasskeysPlugin"
    public let jsName = "ApakiPasskeys"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "support", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "create", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "get", returnType: CAPPluginReturnPromise),
    ]

    /// The one relying party: the Apaki site. The entitlement and the site's AASA file must name it too.
    static let rpId = "apaki.myrlin.io"

    private var pending: CAPPluginCall?
    private var controller: ASAuthorizationController?

    private func bytes(_ call: CAPPluginCall, _ key: String) -> Data? {
        call.getString(key).flatMap(Base64URL.decode)
    }

    @objc func support(_ call: CAPPluginCall) {
        if #available(iOS 18.0, *) {
            call.resolve(["available": true, "prf": true])
        } else {
            call.resolve(["available": true, "prf": false])
        }
    }

    @objc func create(_ call: CAPPluginCall) {
        guard call.getString("rpId") == Self.rpId else { call.reject("Passkeys in the app are for apaki.myrlin.io only.", "domain"); return }
        guard let challenge = bytes(call, "challenge"), let userId = bytes(call, "userId"), let name = call.getString("name"), !name.isEmpty else {
            call.reject("Bad passkey request.", "args")
            return
        }
        guard #available(iOS 18.0, *) else {
            call.reject("Apaki accounts need iOS 18 or later on this phone (passkeys that can unlock a vault). You can still pair with the code on your PC.", "unsupported")
            return
        }
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: Self.rpId)
        let request = provider.createCredentialRegistrationRequest(challenge: challenge, name: name, userID: userId)
        request.displayName = name
        request.userVerificationPreference = .required
        request.attestationPreference = .none
        if let salt = bytes(call, "prfSalt") {
            request.prf = .inputValues(.init(saltInput1: salt))
        } else {
            request.prf = .checkForSupport
        }
        let exclude = (call.getArray("exclude", String.self) ?? []).compactMap(Base64URL.decode)
        if !exclude.isEmpty {
            request.excludedCredentials = exclude.map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0) }
        }
        perform(request, call)
    }

    @objc func get(_ call: CAPPluginCall) {
        guard call.getString("rpId") == Self.rpId else { call.reject("Passkeys in the app are for apaki.myrlin.io only.", "domain"); return }
        guard let challenge = bytes(call, "challenge") else { call.reject("Bad passkey request.", "args"); return }
        guard #available(iOS 18.0, *) else {
            call.reject("Apaki accounts need iOS 18 or later on this phone (passkeys that can unlock a vault). You can still pair with the code on your PC.", "unsupported")
            return
        }
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: Self.rpId)
        let request = provider.createCredentialAssertionRequest(challenge: challenge)
        request.userVerificationPreference = .required
        let allow = (call.getArray("allow", String.self) ?? []).compactMap(Base64URL.decode)
        if !allow.isEmpty {
            request.allowedCredentials = allow.map { ASAuthorizationPlatformPublicKeyCredentialDescriptor(credentialID: $0) }
        }
        if let salt = bytes(call, "prfSalt") {
            request.prf = .inputValues(.init(saltInput1: salt))
        }
        perform(request, call)
    }

    private func perform(_ request: ASAuthorizationRequest, _ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.pending?.reject("Another passkey request started.", "cancelled")
            self.pending = call
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.controller = controller
            controller.performRequests()
        }
    }

    private func take() -> CAPPluginCall? {
        let call = pending
        pending = nil
        controller = nil
        return call
    }

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        bridge?.webView?.window ?? bridge?.viewController?.view.window ?? UIWindow()
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let call = take() else { return }
        if let reg = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration {
            var out: [String: Any] = [
                "id": Base64URL.encode(reg.credentialID),
                "clientDataJSON": Base64URL.encode(reg.rawClientDataJSON),
                "attestationObject": Base64URL.encode(reg.rawAttestationObject ?? Data()),
                "prfSupported": false,
            ]
            if #available(iOS 18.0, *), let prf = reg.prf {
                out["prfSupported"] = prf.isSupported
                if let first = prf.first { out["prf"] = Base64URL.encode(first.withUnsafeBytes { Data($0) }) }
            }
            call.resolve(out)
        } else if let assertion = authorization.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion {
            var out: [String: Any] = [
                "id": Base64URL.encode(assertion.credentialID),
                "clientDataJSON": Base64URL.encode(assertion.rawClientDataJSON),
                "authenticatorData": Base64URL.encode(assertion.rawAuthenticatorData),
                "signature": Base64URL.encode(assertion.signature),
                "userHandle": Base64URL.encode(assertion.userID),
                "prfSupported": false,
            ]
            if #available(iOS 18.0, *), let prf = assertion.prf {
                out["prfSupported"] = true
                out["prf"] = Base64URL.encode(prf.first.withUnsafeBytes { Data($0) })
            }
            call.resolve(out)
        } else {
            call.reject("That was not a passkey.", "webauthn")
        }
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        guard let call = take() else { return }
        let nsError = error as NSError
        if let code = (error as? ASAuthorizationError)?.code {
            if code == .canceled { call.reject("Cancelled.", "cancelled"); return }
            if #available(iOS 18.0, *), code == .matchedExcludedCredential { call.reject("This phone already has a passkey for that account.", "exists"); return }
        }
        // Without a verified apple-app-site-association the system refuses the domain.
        if nsError.localizedDescription.localizedCaseInsensitiveContains("not associated") {
            call.reject("The app is not linked to apaki.myrlin.io yet (Associated Domains and the site's apple-app-site-association file). Pairing with the code on your PC works without it.", "webauthn")
            return
        }
        call.reject(nsError.localizedDescription, "webauthn")
    }
}
