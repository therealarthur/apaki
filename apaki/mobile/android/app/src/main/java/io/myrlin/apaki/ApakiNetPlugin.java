// ApakiNetPlugin.java: the Android side of ApakiNet (apaki/mobile, 2026-10-10),
// the same API as ios/App/App/ApakiNetPlugin.swift (JS: src/native-socket.js,
// src/native-http.js).
//
// The page connects to nothing itself (connect-src 'self'); this is the only
// way out, and it goes to one place: WebSockets to
// wss://apaki.myrlin.io/v1/rooms/<22-char room id>/phone, sent with the site's
// Origin (the relay takes phone sockets from the phone page's origin; this
// app is that page, shipped inside it), and HTTPS to
// https://apaki.myrlin.io/v1/... with no cookies and no redirects. OkHttp
// pings open sockets every 15 s, so one the phone's sleep killed is noticed
// and reported closed, and the page reconnects.
//
//   socketOpen({ id, url, protocols }), socketSend({ id, text | data }), socketClose({ id, code, reason })
//   events 'socket': { id, type: open | message | close | error, protocol?, text?, data?, code?, reason? }
//   http({ url, method, headers, body }) -> { status, headers, body }

package io.myrlin.apaki;

import android.net.Uri;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;
import java.util.regex.Pattern;

import okhttp3.Call;
import okhttp3.Callback;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import okio.ByteString;

@CapacitorPlugin(name = "ApakiNet")
public class ApakiNetPlugin extends Plugin {
    static final String HOST = "apaki.myrlin.io";
    static final String SITE_ORIGIN = "https://apaki.myrlin.io";
    private static final Pattern ROOM = Pattern.compile("^[A-Za-z0-9_-]{22}$");
    private static final Pattern TOKEN = Pattern.compile("^[A-Za-z0-9._-]{1,64}$");
    private static final Set<String> HEADERS = new HashSet<>(Arrays.asList("content-type", "authorization", "accept"));
    private static final Set<String> METHODS = new HashSet<>(Arrays.asList("GET", "POST", "PUT", "DELETE"));
    private static final int MAX_BODY = 128 * 1024;

    private final OkHttpClient client = new OkHttpClient.Builder()
        .followRedirects(false)
        .followSslRedirects(false)
        .pingInterval(15, TimeUnit.SECONDS)
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build();
    private final Map<String, WebSocket> sockets = new ConcurrentHashMap<>();

    /* ---------- where the app may go ---------- */

    static boolean socketAllowed(String text) {
        if (text == null) return false;
        Uri u = Uri.parse(text);
        if (!"wss".equals(u.getScheme()) || !HOST.equals(u.getHost()) || u.getPort() != -1 || u.getUserInfo() != null || u.getQuery() != null || u.getFragment() != null) return false;
        java.util.List<String> parts = u.getPathSegments();
        return parts.size() == 4 && "v1".equals(parts.get(0)) && "rooms".equals(parts.get(1)) && ROOM.matcher(parts.get(2)).matches() && "phone".equals(parts.get(3));
    }

    static boolean requestAllowed(String text) {
        if (text == null) return false;
        Uri u = Uri.parse(text);
        String path = u.getPath();
        return "https".equals(u.getScheme()) && HOST.equals(u.getHost()) && u.getPort() == -1 && u.getUserInfo() == null && path != null && path.startsWith("/v1/") && !path.contains("..");
    }

    /* ---------- sockets ---------- */

    private void emit(String id, String type, JSObject extra) {
        JSObject ev = extra != null ? extra : new JSObject();
        ev.put("id", id);
        ev.put("type", type);
        notifyListeners("socket", ev);
    }

    /** Reports a socket closed, once, and forgets it. */
    private void finish(String id, WebSocket ws, int code, String reason) {
        if (!sockets.remove(id, ws)) return;
        JSObject ev = new JSObject();
        ev.put("code", code);
        ev.put("reason", reason == null ? "" : reason);
        emit(id, "close", ev);
    }

    @PluginMethod
    public void socketOpen(PluginCall call) {
        final String id = call.getString("id");
        String url = call.getString("url");
        if (id == null || id.isEmpty() || !socketAllowed(url)) { call.reject("The app connects to the Apaki relay only.", "refused"); return; }
        StringBuilder protocols = new StringBuilder();
        try {
            JSArray list = call.getArray("protocols", new JSArray());
            for (int i = 0; i < list.length(); i++) {
                String p = list.getString(i);
                if (!TOKEN.matcher(p).matches()) continue;
                if (protocols.length() > 0) protocols.append(", ");
                protocols.append(p);
            }
        } catch (Exception e) {
            call.reject("Bad protocols.", "args");
            return;
        }
        Request.Builder req = new Request.Builder().url(url).header("Origin", SITE_ORIGIN);
        if (protocols.length() > 0) req.header("Sec-WebSocket-Protocol", protocols.toString());
        WebSocket old = sockets.remove(id);
        if (old != null) old.cancel();
        final WebSocket[] self = new WebSocket[1];
        self[0] = client.newWebSocket(req.build(), new WebSocketListener() {
            @Override
            public void onOpen(WebSocket ws, Response response) {
                JSObject ev = new JSObject();
                String p = response.header("Sec-WebSocket-Protocol");
                ev.put("protocol", p == null ? "" : p);
                emit(id, "open", ev);
            }

            @Override
            public void onMessage(WebSocket ws, String text) {
                JSObject ev = new JSObject();
                ev.put("text", text);
                emit(id, "message", ev);
            }

            @Override
            public void onMessage(WebSocket ws, ByteString bytes) {
                JSObject ev = new JSObject();
                ev.put("data", ApakiKeysPlugin.b64(bytes.toByteArray()));
                emit(id, "message", ev);
            }

            @Override
            public void onClosing(WebSocket ws, int code, String reason) {
                ws.close(1000, null);
                finish(id, ws, code, reason);
            }

            @Override
            public void onClosed(WebSocket ws, int code, String reason) {
                finish(id, ws, code, reason);
            }

            @Override
            public void onFailure(WebSocket ws, Throwable t, Response response) {
                JSObject ev = new JSObject();
                ev.put("message", t.getMessage() == null ? "connection failed" : t.getMessage());
                emit(id, "error", ev);
                // A refused upgrade (403, 429, 503 from the relay) or a lost network: 1006, as a browser reports it.
                finish(id, ws, 1006, t.getMessage());
            }
        });
        sockets.put(id, self[0]);
        call.resolve();
    }

    @PluginMethod
    public void socketSend(PluginCall call) {
        String id = call.getString("id");
        WebSocket ws = id == null ? null : sockets.get(id);
        if (ws == null) { call.reject("The socket is closed.", "closed"); return; }
        String text = call.getString("text");
        String data = call.getString("data");
        boolean queued;
        if (text != null) queued = ws.send(text);
        else if (data != null) queued = ws.send(ByteString.of(ApakiKeysPlugin.unb64(data)));
        else { call.reject("Bad send.", "args"); return; }
        if (queued) call.resolve(); else call.reject("The socket is closing.", "send");
    }

    @PluginMethod
    public void socketClose(PluginCall call) {
        String id = call.getString("id");
        WebSocket ws = id == null ? null : sockets.get(id);
        if (ws == null) { call.resolve(); return; }
        int code = call.getInt("code", 1000);
        String reason = call.getString("reason", "");
        if (reason.length() > 120) reason = reason.substring(0, 120);
        // Only 1000 and 3000 to 4999 may be sent by a client.
        try { ws.close(code == 1000 || (code >= 3000 && code <= 4999) ? code : 1000, reason); } catch (Exception e) { ws.cancel(); }
        finish(id, ws, code, reason);
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        for (Iterator<WebSocket> it = sockets.values().iterator(); it.hasNext(); ) { it.next().cancel(); it.remove(); }
    }

    /* ---------- the account API ---------- */

    @PluginMethod
    public void http(final PluginCall call) {
        String url = call.getString("url");
        if (!requestAllowed(url)) { call.reject("The app calls apaki.myrlin.io/v1/ only.", "refused"); return; }
        String method = call.getString("method", "GET").toUpperCase(java.util.Locale.ROOT);
        if (!METHODS.contains(method)) { call.reject("Bad method.", "args"); return; }
        Request.Builder req = new Request.Builder().url(url);
        JSObject headers = call.getObject("headers", new JSObject());
        String type = "application/json";
        for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
            String name = it.next();
            String lower = name.toLowerCase(java.util.Locale.ROOT);
            String value = headers.optString(name, null);
            if (value == null || !HEADERS.contains(lower)) continue;
            if (lower.equals("content-type")) type = value; else req.header(name, value);
        }
        String body = call.getString("body");
        RequestBody rb = null;
        if (body != null) {
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            if (bytes.length > MAX_BODY) { call.reject("The request is too large.", "args"); return; }
            rb = RequestBody.create(bytes, MediaType.parse(type));
        } else if (method.equals("POST") || method.equals("PUT")) {
            rb = RequestBody.create(new byte[0], null);
        }
        req.method(method, rb);
        client.newCall(req.build()).enqueue(new Callback() {
            @Override
            public void onFailure(Call c, IOException e) {
                call.reject("No connection to apaki.myrlin.io: " + e.getMessage(), "offline");
            }

            @Override
            public void onResponse(Call c, Response response) {
                try {
                    JSObject out = new JSObject();
                    out.put("status", response.code());
                    JSObject h = new JSObject();
                    String ct = response.header("Content-Type");
                    h.put("content-type", ct == null ? "" : ct);
                    out.put("headers", h);
                    out.put("body", response.body() == null ? "" : response.body().string());
                    call.resolve(out);
                } catch (IOException e) {
                    call.reject("No connection to apaki.myrlin.io: " + e.getMessage(), "offline");
                } finally {
                    response.close();
                }
            }
        });
    }
}
