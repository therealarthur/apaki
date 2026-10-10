// ApakiPasskeysPlugin.java: the Android side of ApakiPasskeys (apaki/mobile, 2026-10-10).
//
// Not yet: Apaki accounts need passkeys with PRF, which Android offers through
// Credential Manager, but a native Android app's passkeys carry the origin
// android:apk-key-hash:<signing certificate hash>, and the account server
// accepts https://apaki.myrlin.io only (relay/src/account.js). Until the relay
// also accepts the app's origin (and assetlinks.json names the app), this
// says so: support() reports no PRF, which apaki/web/src/account.js turns
// into its own "this phone cannot unlock an account" message. Pairing with
// the PC's code works without an account. README.md, Android.

package io.myrlin.apaki;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "ApakiPasskeys")
public class ApakiPasskeysPlugin extends Plugin {
    private static final String NOT_YET = "Apaki accounts come to the Android app in a later version. Pair with the code on your PC instead.";

    @PluginMethod
    public void support(PluginCall call) {
        JSObject out = new JSObject();
        out.put("available", false);
        out.put("prf", false);
        call.resolve(out);
    }

    @PluginMethod
    public void create(PluginCall call) {
        call.reject(NOT_YET, "unsupported");
    }

    @PluginMethod
    public void get(PluginCall call) {
        call.reject(NOT_YET, "unsupported");
    }
}
