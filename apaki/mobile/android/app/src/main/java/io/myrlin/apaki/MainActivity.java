// MainActivity.java: the Apaki app on Android (apaki/mobile, 2026-10-10):
// Capacitor's activity with the bundled phone client, and the Apaki plugins
// registered before the bridge starts (Capacitor's way for plugins inside
// the app). The iOS counterpart is ios/App/App/ApakiViewController.swift.

package io.myrlin.apaki;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(ApakiKeysPlugin.class);
        registerPlugin(ApakiNetPlugin.class);
        registerPlugin(ApakiPasskeysPlugin.class);
        registerPlugin(ApakiScannerPlugin.class);
        registerPlugin(ApakiAppPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
