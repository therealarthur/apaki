// ApakiAppPlugin.java: the Android side of ApakiApp (apaki/mobile, 2026-10-10),
// the same API as ios/App/App/ApakiAppPlugin.swift.
//
//   info() -> { debug, demo?, link?, version, build, secureEnclave: false }
//     debug: the app is debuggable (a debug build). demo and link come from
//     the launching intent's extras, read in debug builds only:
//       adb shell am start -n io.myrlin.apaki/.MainActivity --es apakiDemo chat
//   setBackground({ color: "#rrggbb" })   the WebView's ground follows Apaki's theme

package io.myrlin.apaki;

import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.graphics.Color;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.Arrays;

@CapacitorPlugin(name = "ApakiApp")
public class ApakiAppPlugin extends Plugin {

    private boolean debuggable() {
        return (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    @PluginMethod
    public void info(PluginCall call) {
        JSObject out = new JSObject();
        boolean debug = debuggable();
        out.put("debug", debug);
        out.put("secureEnclave", false);
        try {
            PackageInfo p = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            out.put("version", p.versionName == null ? "" : p.versionName);
            long build = Build.VERSION.SDK_INT >= 28 ? p.getLongVersionCode() : p.versionCode;
            out.put("build", String.valueOf(build));
        } catch (Exception e) {
            out.put("version", "");
            out.put("build", "");
        }
        Intent intent = getActivity() == null ? null : getActivity().getIntent();
        if (debug && intent != null) {
            String demo = intent.getStringExtra("apakiDemo");
            if (demo != null && Arrays.asList("pair", "list", "chat").contains(demo)) out.put("demo", demo);
            String link = intent.getStringExtra("apakiLink");
            if (link != null) out.put("link", link);
        }
        call.resolve(out);
    }

    @PluginMethod
    public void setBackground(final PluginCall call) {
        String hex = call.getString("color");
        final int color;
        try {
            if (hex == null || !hex.matches("^#[0-9A-Fa-f]{6}$")) throw new IllegalArgumentException("bad colour");
            color = Color.parseColor(hex);
        } catch (Exception e) {
            call.reject("Bad colour.", "args");
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (getBridge() != null && getBridge().getWebView() != null) getBridge().getWebView().setBackgroundColor(color);
            getActivity().getWindow().getDecorView().setBackgroundColor(color);
            call.resolve();
        });
    }
}
