// ApakiKeysPlugin.java: the Android side of ApakiKeys (apaki/mobile, 2026-10-10),
// the same API as ios/App/App/ApakiKeysPlugin.swift (JS: src/native-store.js).
//
// Arthur: "when pairing a phone, the paired phone should be good to go
// forever." Each pairing's device key is an EC P-256 key made in the Android
// Keystore (in StrongBox when the phone has one): it never leaves secure
// hardware; the app only asks it to sign the pairing and reconnect
// transcripts. Pairing records and the account are kept in app-private
// SharedPreferences, each value sealed with AES-256-GCM under a Keystore key,
// so they survive WebView storage being cleared, and a copy taken off the
// phone (backups are off, AndroidManifest.xml) cannot be opened elsewhere.
//
//   createKey() -> { keyId, pub (65-byte point, base64url), secureEnclave: false, hardware, strongBox }
//   sign({ keyId, data }) -> { sig }    ECDSA P-256 / SHA-256, 64 bytes r||s (the Keystore gives DER)
//   deleteKey({ keyId }), pruneKeys({ keep: [keyId] }) -> { removed }
//   vaultGet({ key }) -> { value? }, vaultSet({ key, value }), vaultRemove({ key }),
//   vaultList({ prefix }) -> { items: [{ key, value }] }

package io.myrlin.apaki;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyInfo;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.math.BigInteger;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.interfaces.ECPublicKey;
import java.security.spec.ECGenParameterSpec;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.regex.Pattern;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "ApakiKeys")
public class ApakiKeysPlugin extends Plugin {
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String DEVICE_PREFIX = "io.myrlin.apaki.device.";
    private static final String STORE_KEY = "io.myrlin.apaki.store.key";
    private static final String PREFS = "io.myrlin.apaki.store";
    private static final Pattern KEY_ID = Pattern.compile("^[a-f0-9-]{36}$");
    private static final Pattern STORE_NAME = Pattern.compile("^[A-Za-z0-9:_-]{1,80}$");
    private static final int MAX_VALUE = 64 * 1024;
    private static final int MAX_SIGN = 4096;

    /* ---------- base64url ---------- */

    static String b64(byte[] bytes) {
        return Base64.encodeToString(bytes, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    static byte[] unb64(String text) {
        return Base64.decode(text, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    /* ---------- device keys ---------- */

    private static KeyStore keyStore() throws Exception {
        KeyStore ks = KeyStore.getInstance(KEYSTORE);
        ks.load(null);
        return ks;
    }

    private static KeyGenParameterSpec deviceSpec(String alias, boolean strongBox) {
        KeyGenParameterSpec.Builder b = new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN)
            .setAlgorithmParameterSpec(new ECGenParameterSpec("secp256r1"))
            .setDigests(KeyProperties.DIGEST_SHA256);
        if (strongBox && Build.VERSION.SDK_INT >= 28) b.setIsStrongBoxBacked(true);
        return b.build();
    }

    /** 0x04 || X || Y, each 32 bytes: the uncompressed point WebCrypto and protocol.js use. */
    static byte[] rawPoint(ECPublicKey pub) {
        byte[] out = new byte[65];
        out[0] = 4;
        put32(pub.getW().getAffineX(), out, 1);
        put32(pub.getW().getAffineY(), out, 33);
        return out;
    }

    private static void put32(BigInteger v, byte[] out, int at) {
        byte[] b = v.toByteArray();
        int len = Math.min(b.length, 32);
        System.arraycopy(b, b.length - len, out, at + 32 - len, len);
    }

    /** A DER ECDSA signature (SEQUENCE of two INTEGERs) as 64 bytes r || s. */
    static byte[] derToRaw(byte[] der) {
        int i = 0;
        if (der[i++] != 0x30) throw new IllegalArgumentException("not a DER sequence");
        int seqLen = der[i++] & 0xff;
        if (seqLen == 0x81) i++;
        byte[] out = new byte[64];
        for (int part = 0; part < 2; part++) {
            if (der[i++] != 0x02) throw new IllegalArgumentException("not a DER integer");
            int len = der[i++] & 0xff;
            int start = i;
            int n = len;
            while (n > 32 && der[start] == 0) { start++; n--; }
            if (n > 32) throw new IllegalArgumentException("integer too long");
            System.arraycopy(der, start, out, part * 32 + 32 - n, n);
            i += len;
        }
        return out;
    }

    private static boolean insideSecureHardware(PrivateKey key) {
        try {
            KeyInfo info = KeyFactory.getInstance(key.getAlgorithm(), KEYSTORE).getKeySpec(key, KeyInfo.class);
            if (Build.VERSION.SDK_INT >= 31) return info.getSecurityLevel() != KeyProperties.SECURITY_LEVEL_SOFTWARE;
            return info.isInsideSecureHardware();
        } catch (Exception e) {
            return false;
        }
    }

    @PluginMethod
    public void createKey(PluginCall call) {
        String keyId = UUID.randomUUID().toString();
        String alias = DEVICE_PREFIX + keyId;
        try {
            KeyPairGenerator gen = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE);
            KeyPair pair;
            boolean strongBox = false;
            try {
                gen.initialize(deviceSpec(alias, true));
                pair = gen.generateKeyPair();
                strongBox = Build.VERSION.SDK_INT >= 28;
            } catch (Exception noStrongBox) {
                // No StrongBox on this phone: the Keystore's trusted environment instead.
                gen.initialize(deviceSpec(alias, false));
                pair = gen.generateKeyPair();
            }
            JSObject out = new JSObject();
            out.put("keyId", keyId);
            out.put("pub", b64(rawPoint((ECPublicKey) pair.getPublic())));
            out.put("secureEnclave", false);
            out.put("hardware", insideSecureHardware(pair.getPrivate()));
            out.put("strongBox", strongBox);
            call.resolve(out);
        } catch (Exception e) {
            call.reject("Could not make a device key: " + e.getMessage(), "key");
        }
    }

    @PluginMethod
    public void sign(PluginCall call) {
        String keyId = call.getString("keyId");
        String data = call.getString("data");
        if (keyId == null || !KEY_ID.matcher(keyId).matches() || data == null) { call.reject("Bad sign request.", "args"); return; }
        try {
            byte[] bytes = unb64(data);
            if (bytes.length > MAX_SIGN) { call.reject("Bad sign request.", "args"); return; }
            KeyStore.Entry entry = keyStore().getEntry(DEVICE_PREFIX + keyId, null);
            if (!(entry instanceof KeyStore.PrivateKeyEntry)) {
                call.reject("This phone's key for that PC is gone. Pair again with a new code.", "missing");
                return;
            }
            Signature s = Signature.getInstance("SHA256withECDSA");
            s.initSign(((KeyStore.PrivateKeyEntry) entry).getPrivateKey());
            s.update(bytes);
            JSObject out = new JSObject();
            out.put("sig", b64(derToRaw(s.sign())));
            call.resolve(out);
        } catch (Exception e) {
            call.reject("The device key could not sign: " + e.getMessage(), "sign");
        }
    }

    @PluginMethod
    public void deleteKey(PluginCall call) {
        String keyId = call.getString("keyId");
        if (keyId == null || !KEY_ID.matcher(keyId).matches()) { call.reject("Bad key id.", "args"); return; }
        try {
            keyStore().deleteEntry(DEVICE_PREFIX + keyId);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage(), "keystore");
        }
    }

    /** Deletes every device key not in `keep` (keys of pairings that never finished). */
    @PluginMethod
    public void pruneKeys(PluginCall call) {
        Set<String> keep = new HashSet<>();
        try {
            JSArray list = call.getArray("keep", new JSArray());
            for (int i = 0; i < list.length(); i++) keep.add(list.getString(i));
            KeyStore ks = keyStore();
            List<String> drop = new ArrayList<>();
            for (Enumeration<String> e = ks.aliases(); e.hasMoreElements(); ) {
                String alias = e.nextElement();
                if (alias.startsWith(DEVICE_PREFIX) && !keep.contains(alias.substring(DEVICE_PREFIX.length()))) drop.add(alias);
            }
            for (String alias : drop) ks.deleteEntry(alias);
            JSObject out = new JSObject();
            out.put("removed", drop.size());
            call.resolve(out);
        } catch (Exception e) {
            call.reject(e.getMessage(), "keystore");
        }
    }

    /* ---------- the store ---------- */

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static SecretKey storeKey() throws Exception {
        KeyStore ks = keyStore();
        KeyStore.Entry entry = ks.getEntry(STORE_KEY, null);
        if (entry instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        gen.init(new KeyGenParameterSpec.Builder(STORE_KEY, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return gen.generateKey();
    }

    /** "v1:" + base64url(iv || ciphertext); the record's name is the AAD, so a value cannot be moved to another name. */
    private static String seal(String name, String value) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, storeKey());
        c.updateAAD(name.getBytes(StandardCharsets.UTF_8));
        byte[] ct = c.doFinal(value.getBytes(StandardCharsets.UTF_8));
        byte[] iv = c.getIV();
        byte[] all = new byte[iv.length + ct.length];
        System.arraycopy(iv, 0, all, 0, iv.length);
        System.arraycopy(ct, 0, all, iv.length, ct.length);
        return "v1:" + b64(all);
    }

    private static String open(String name, String sealed) throws Exception {
        if (sealed == null || !sealed.startsWith("v1:")) return null;
        byte[] all = unb64(sealed.substring(3));
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.DECRYPT_MODE, storeKey(), new GCMParameterSpec(128, all, 0, 12));
        c.updateAAD(name.getBytes(StandardCharsets.UTF_8));
        return new String(c.doFinal(all, 12, all.length - 12), StandardCharsets.UTF_8);
    }

    private String storeName(PluginCall call) {
        String key = call.getString("key");
        if (key == null || !STORE_NAME.matcher(key).matches()) { call.reject("Bad store key.", "args"); return null; }
        return key;
    }

    @PluginMethod
    public void vaultGet(PluginCall call) {
        String key = storeName(call);
        if (key == null) return;
        try {
            String value = open(key, prefs().getString(key, null));
            JSObject out = new JSObject();
            if (value != null) out.put("value", value);
            call.resolve(out);
        } catch (Exception e) {
            call.reject(e.getMessage(), "keystore");
        }
    }

    @PluginMethod
    public void vaultSet(PluginCall call) {
        String key = storeName(call);
        if (key == null) return;
        String value = call.getString("value");
        if (value == null || value.getBytes(StandardCharsets.UTF_8).length > MAX_VALUE) { call.reject("Bad store value.", "args"); return; }
        try {
            // commit, not apply: the record is on disk before the page hears it is saved.
            if (!prefs().edit().putString(key, seal(key, value)).commit()) throw new IllegalStateException("not written");
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage(), "keystore");
        }
    }

    @PluginMethod
    public void vaultRemove(PluginCall call) {
        String key = storeName(call);
        if (key == null) return;
        prefs().edit().remove(key).commit();
        call.resolve();
    }

    @PluginMethod
    public void vaultList(PluginCall call) {
        String prefix = call.getString("prefix", "");
        try {
            JSArray items = new JSArray();
            for (Map.Entry<String, ?> e : prefs().getAll().entrySet()) {
                if (!e.getKey().startsWith(prefix) || !(e.getValue() instanceof String)) continue;
                String value = open(e.getKey(), (String) e.getValue());
                if (value == null) continue;
                JSObject item = new JSObject();
                item.put("key", e.getKey());
                item.put("value", value);
                items.put(item);
            }
            JSObject out = new JSObject();
            out.put("items", items);
            call.resolve(out);
        } catch (Exception e) {
            call.reject(e.getMessage(), "keystore");
        }
    }
}
