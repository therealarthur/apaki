// ApakiScannerPlugin.swift: the Apaki app's pairing-code scanner (apaki/mobile,
// 2026-10-10). JS: ApakiScanner (src/cap.js), used by src/scan-native.js.
//
// A full-screen camera with a viewfinder, AVFoundation's own QR reader (no
// third-party code, nothing to download), and a Cancel button. It returns
// the first code that is an Apaki pairing link (a link with p=... in its
// fragment, the same test as the web scanner) and closes; anything else
// only changes the hint. The camera runs only while the scanner shows.
//
//   scan({ hint }) -> { value }   rejects with code cancelled or denied
//   cancel()

import AVFoundation
import Capacitor
import UIKit

@objc(ApakiScannerPlugin)
public class ApakiScannerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "ApakiScannerPlugin"
    public let jsName = "ApakiScanner"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "scan", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
    ]

    private var scanner: ScannerViewController?
    private var pending: CAPPluginCall?

    @objc func scan(_ call: CAPPluginCall) {
        let hint = call.getString("hint") ?? "Point at the pairing code"
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            present(call, hint)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { ok in
                DispatchQueue.main.async {
                    if ok { self.present(call, hint) } else { call.reject("The camera is not allowed for Apaki.", "denied") }
                }
            }
        default:
            call.reject("The camera is not allowed for Apaki.", "denied")
        }
    }

    @objc func cancel(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            self.finish(nil)
            call.resolve()
        }
    }

    private func present(_ call: CAPPluginCall, _ hint: String) {
        DispatchQueue.main.async {
            self.finish(nil)
            self.pending = call
            let vc = ScannerViewController(hint: hint) { [weak self] value in self?.finish(value) }
            vc.modalPresentationStyle = .fullScreen
            self.scanner = vc
            self.bridge?.viewController?.present(vc, animated: true)
        }
    }

    /// Closes the scanner and answers the page: the link, or cancelled. On the main thread.
    private func finish(_ value: String?) {
        let vc = scanner
        scanner = nil
        vc?.stop()
        vc?.dismiss(animated: true)
        guard let call = pending else { return }
        pending = nil
        if let value { call.resolve(["value": value]) } else { call.reject("Cancelled.", "cancelled") }
    }
}

final class ScannerViewController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    private let session = AVCaptureSession()
    private let sessionQueue = DispatchQueue(label: "io.myrlin.apaki.scanner")
    private let onDone: (String?) -> Void
    private let hint: String
    private var preview: AVCaptureVideoPreviewLayer?
    private let finder = CAShapeLayer()
    private let hintLabel = UILabel()
    private let cancelButton = UIButton(type: .system)
    private var done = false

    init(hint: String, onDone: @escaping (String?) -> Void) {
        self.hint = hint
        self.onDone = onDone
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not from a storyboard") }

    override var prefersStatusBarHidden: Bool { true }

    /// A link with the pairing payload in its fragment (apaki/web/src/scan.js uses the same test).
    static func looksLikePairing(_ s: String) -> Bool {
        s.range(of: "#(?:[^#]*&)?p=[A-Za-z0-9_-]+", options: .regularExpression) != nil
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black

        finder.strokeColor = UIColor.white.withAlphaComponent(0.92).cgColor
        finder.fillColor = UIColor.clear.cgColor
        finder.lineWidth = 3
        finder.lineCap = .round

        hintLabel.text = hint
        hintLabel.textColor = .white
        hintLabel.font = .systemFont(ofSize: 17, weight: .semibold)
        hintLabel.textAlignment = .center
        hintLabel.numberOfLines = 0
        hintLabel.translatesAutoresizingMaskIntoConstraints = false

        var config = UIButton.Configuration.filled()
        config.title = "Cancel"
        config.baseBackgroundColor = UIColor.white.withAlphaComponent(0.18)
        config.baseForegroundColor = .white
        config.cornerStyle = .capsule
        config.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 28, bottom: 12, trailing: 28)
        cancelButton.configuration = config
        cancelButton.translatesAutoresizingMaskIntoConstraints = false
        cancelButton.addTarget(self, action: #selector(cancelTapped), for: .touchUpInside)

        if let device = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) ?? AVCaptureDevice.default(for: .video),
           let input = try? AVCaptureDeviceInput(device: device), session.canAddInput(input) {
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            if session.canAddOutput(output) {
                session.addOutput(output)
                output.setMetadataObjectsDelegate(self, queue: .main)
                output.metadataObjectTypes = [.qr]
            }
            let layer = AVCaptureVideoPreviewLayer(session: session)
            layer.videoGravity = .resizeAspectFill
            view.layer.addSublayer(layer)
            preview = layer
            view.layer.addSublayer(finder)
            sessionQueue.async { self.session.startRunning() }
        } else {
            // The Simulator, or a phone without a usable camera.
            hintLabel.text = "No camera here. Cancel, then use Paste a pairing link instead."
        }

        view.addSubview(hintLabel)
        view.addSubview(cancelButton)
        NSLayoutConstraint.activate([
            hintLabel.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor, constant: 28),
            hintLabel.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor, constant: -28),
            hintLabel.bottomAnchor.constraint(equalTo: cancelButton.topAnchor, constant: -28),
            cancelButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            cancelButton.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -24),
        ])
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        preview?.frame = view.bounds
        // Four rounded corners of a square in the middle, like the system scanner.
        let side = min(view.bounds.width, view.bounds.height) * 0.64
        let rect = CGRect(x: (view.bounds.width - side) / 2, y: (view.bounds.height - side) / 2 - 40, width: side, height: side)
        let arm: CGFloat = 34
        let r: CGFloat = 18
        let path = UIBezierPath()
        let corners: [(CGPoint, CGFloat, CGFloat)] = [
            (CGPoint(x: rect.minX, y: rect.minY), 1, 1), (CGPoint(x: rect.maxX, y: rect.minY), -1, 1),
            (CGPoint(x: rect.minX, y: rect.maxY), 1, -1), (CGPoint(x: rect.maxX, y: rect.maxY), -1, -1),
        ]
        for (corner, dx, dy) in corners {
            path.move(to: CGPoint(x: corner.x, y: corner.y + dy * arm))
            path.addLine(to: CGPoint(x: corner.x, y: corner.y + dy * r))
            path.addQuadCurve(to: CGPoint(x: corner.x + dx * r, y: corner.y), controlPoint: corner)
            path.addLine(to: CGPoint(x: corner.x + dx * arm, y: corner.y))
        }
        finder.path = path.cgPath
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
        guard !done else { return }
        for case let code as AVMetadataMachineReadableCodeObject in metadataObjects {
            guard let value = code.stringValue else { continue }
            if Self.looksLikePairing(value) {
                done = true
                UIImpactFeedbackGenerator(style: .medium).impactOccurred()
                onDone(value)
                return
            }
            hintLabel.text = "That is not an Apaki pairing code. Open Phone in Apaki on your PC and scan the code there."
        }
    }

    func stop() {
        sessionQueue.async { if self.session.isRunning { self.session.stopRunning() } }
    }

    @objc private func cancelTapped() {
        guard !done else { return }
        done = true
        onDone(nil)
    }
}
