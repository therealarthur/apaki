// ApakiViewController.swift: the Apaki app's one screen (apaki/mobile,
// 2026-10-10): Capacitor's WebView with the bundled phone client, and the
// Apaki plugins registered with its bridge (Capacitor's documented way for
// plugins that live in the app itself rather than in an npm package).
// SceneDelegate.swift makes this the window's root.

import Capacitor
import UIKit

class ApakiViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(ApakiKeysPlugin())
        bridge?.registerPluginInstance(ApakiNetPlugin())
        bridge?.registerPluginInstance(ApakiPasskeysPlugin())
        bridge?.registerPluginInstance(ApakiScannerPlugin())
        bridge?.registerPluginInstance(ApakiAppPlugin())
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        // Apaki's ground (light or dark) behind the page from the first frame, so the splash
        // fades into the same colour; the page then keeps it in step with its theme (ApakiApp.setBackground).
        view.backgroundColor = .apakiGround
        if let web = bridge?.webView {
            web.isOpaque = false
            web.backgroundColor = .apakiGround
            web.scrollView.backgroundColor = .apakiGround
            // The shell itself never scrolls or bounces (capacitor.config.json ios.scrollEnabled); inner lists do.
            web.scrollView.bounces = false
            web.scrollView.contentInsetAdjustmentBehavior = .never
        }
    }
}
