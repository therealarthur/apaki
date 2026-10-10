// ApakiScannerPlugin.java: the Android side of ApakiScanner (apaki/mobile, 2026-10-10),
// the same API as ios/App/App/ApakiScannerPlugin.swift (JS: src/scan-native.js).
//
// Google's code scanner (play-services-code-scanner): the system shows the
// camera in its own screen and hands back only the code, so the app needs no
// camera permission at all. It returns the first code that is an Apaki
// pairing link (p=... in the fragment, the same test as the web scanner).
//
//   scan({ hint }) -> { value }   rejects with code cancelled or scan
//   cancel()                      (the scanner screen itself closes with Back)

package io.myrlin.apaki;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanner;
import com.google.mlkit.vision.codescanner.GmsBarcodeScannerOptions;
import com.google.mlkit.vision.codescanner.GmsBarcodeScanning;

import java.util.regex.Pattern;

@CapacitorPlugin(name = "ApakiScanner")
public class ApakiScannerPlugin extends Plugin {
    private static final Pattern PAIRING = Pattern.compile("#(?:[^#]*&)?p=[A-Za-z0-9_-]+");

    @PluginMethod
    public void scan(final PluginCall call) {
        GmsBarcodeScannerOptions options = new GmsBarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build();
        GmsBarcodeScanner scanner = GmsBarcodeScanning.getClient(getActivity(), options);
        scanner.startScan()
            .addOnSuccessListener(code -> {
                String value = code.getRawValue();
                if (value != null && PAIRING.matcher(value).find()) {
                    JSObject out = new JSObject();
                    out.put("value", value);
                    call.resolve(out);
                } else {
                    call.reject("That is not an Apaki pairing code. Open Phone in Apaki on your PC and scan the code there.", "scan");
                }
            })
            .addOnCanceledListener(() -> call.reject("Cancelled.", "cancelled"))
            .addOnFailureListener(e -> call.reject("The scanner did not open: " + e.getMessage(), "scan"));
    }

    @PluginMethod
    public void cancel(PluginCall call) {
        call.resolve();
    }
}
