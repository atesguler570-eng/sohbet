package com.akis.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.URL;

public class MainActivity extends Activity {
    private static final String PREFS = "akis";
    private static final String KEY_SERVER = "server_url";
    private static final String DEFAULT_SERVER = "http://192.168.1.102:3000";
    private static final int SERVER_PORT = 3000;
    private static final int REQ_MEDIA = 100;
    private static final int REQ_FILE = 200;

    private static final int BG = Color.parseColor("#0a0b10");
    private static final int SURFACE = Color.parseColor("#151926");
    private static final int BORDER = Color.parseColor("#262c3d");
    private static final int TEXT = Color.parseColor("#eef1f8");
    private static final int MUTED = Color.parseColor("#8e97ad");
    private static final int ACCENT = Color.parseColor("#f43f8e");
    private static final int ACCENT_2 = Color.parseColor("#8b5cf6");
    private static final int DANGER = Color.parseColor("#ff5d5d");

    private WebView webView;
    private SharedPreferences prefs;
    private String serverUrl;
    private boolean configured;
    private boolean showingSetup;
    private boolean discovering;
    private boolean autoDiscoveryTried;
    private PermissionRequest pendingPermissionRequest;
    private ValueCallback<Uri[]> pendingFileCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window window = getWindow();
        window.setStatusBarColor(BG);
        window.setNavigationBarColor(BG);
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
        configured = prefs.contains(KEY_SERVER);
        serverUrl = prefs.getString(KEY_SERVER, DEFAULT_SERVER);

        if (configured) {
            loadServer();
        } else {
            loadOffline();
        }
    }

    private void loadOffline() {
        ensureWebView();
        showingSetup = false;
        setContentView(webView);
        webView.loadUrl("file:///android_asset/index.html?apk=1&offline=1");
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void ensureWebView() {
        if (webView != null) return;

        webView = new WebView(this);
        webView.setBackgroundColor(BG);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setLoadsImagesAutomatically(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(true);
        settings.setCacheMode(WebSettings.LOAD_CACHE_ELSE_NETWORK);
        settings.setOffscreenPreRaster(true);
        settings.setRenderPriority(WebSettings.RenderPriority.HIGH);
        settings.setUserAgentString(settings.getUserAgentString() + " AkisApp/1.0");

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, true);

        WebView.setWebContentsDebuggingEnabled(true);
        webView.setWebViewClient(new AppWebViewClient());
        webView.setWebChromeClient(new AppWebChromeClient());
        webView.addJavascriptInterface(new Bridge(), "AkisAndroid");
    }

    private void loadServer() {
        ensureWebView();
        showingSetup = false;
        setContentView(webView);
        webView.loadUrl(serverUrl + "/?apk=1");
    }

    /* ------------------------------------------------------------------ */
    /*  Ağda sunucu bulma (bilgisayarın IP'si değişince uygulama kırılmasın) */
    /* ------------------------------------------------------------------ */

    /** Telefonun bağlı olduğu ağların /24 önekleri, örn. "192.168.1." */
    private List<String> localPrefixes() {
        List<String> prefixes = new ArrayList<>();
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            while (ifaces != null && ifaces.hasMoreElements()) {
                NetworkInterface nif = ifaces.nextElement();
                if (!nif.isUp() || nif.isLoopback()) continue;
                Enumeration<InetAddress> addrs = nif.getInetAddresses();
                while (addrs.hasMoreElements()) {
                    InetAddress addr = addrs.nextElement();
                    if (!(addr instanceof Inet4Address) || addr.isLoopbackAddress()) continue;
                    String ip = addr.getHostAddress();
                    int dot = ip.lastIndexOf('.');
                    if (dot <= 0) continue;
                    String prefix = ip.substring(0, dot + 1);
                    if (!prefixes.contains(prefix)) prefixes.add(prefix);
                }
            }
        } catch (Exception ignored) {
        }
        if (prefixes.isEmpty()) prefixes.add("192.168.1.");
        return prefixes;
    }

    /** Verilen adres gerçekten Akış sunucusu mu? */
    private boolean isAkisServer(String host) {
        HttpURLConnection conn = null;
        try {
            URL url = new URL("http", host, SERVER_PORT, "/api/me");
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(900);
            conn.setReadTimeout(1500);
            conn.setRequestMethod("GET");
            conn.setUseCaches(false);
            int code = conn.getResponseCode();
            if (code != HttpURLConnection.HTTP_OK && code != HttpURLConnection.HTTP_UNAUTHORIZED) return false;
            java.io.InputStream in = code == HttpURLConnection.HTTP_OK ? conn.getInputStream() : conn.getErrorStream();
            if (in == null) return false;
            byte[] buffer = new byte[512];
            int read = in.read(buffer);
            in.close();
            if (read <= 0) return false;
            String body = new String(buffer, 0, read, "UTF-8");
            return body.contains("\"user\"") || body.contains("\"error\"");
        } catch (Exception ignored) {
            return false;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    /** Daha önce kullanılan son sekizli (aynı ağdaysa) önce denenir. */
    private int preferredOctet(String prefix) {
        String host = Uri.parse(serverUrl == null ? "" : serverUrl).getHost();
        if (host != null && host.startsWith(prefix)) {
            try {
                return Integer.parseInt(host.substring(prefix.length()));
            } catch (Exception ignored) {
            }
        }
        String fallback = Uri.parse(DEFAULT_SERVER).getHost();
        if (fallback != null && fallback.startsWith(prefix)) {
            try {
                int octet = Integer.parseInt(fallback.substring(prefix.length()));
                if (octet > 0 && octet < 255) return octet;
            } catch (Exception ignored) {
            }
        }
        return -1;
    }

    /** Yerel ağı tarar, bulduğu Akış sunucusuna bağlanır. */
    private void discoverServer(final boolean manual) {
        if (discovering) return;
        discovering = true;
        if (manual) {
            Toast.makeText(this, "Ağda NOX sunucusu aranıyor…", Toast.LENGTH_SHORT).show();
        }

        final List<String> prefixes = localPrefixes();
        new Thread(() -> {
            String found = null;
            for (String prefix : prefixes) {
                if (found != null) break;

                List<String> hosts = new ArrayList<>();
                int preferred = preferredOctet(prefix);
                if (preferred > 0 && preferred < 255) hosts.add(prefix + preferred);
                for (int i = 1; i < 255; i++) {
                    if (i == preferred) continue;
                    hosts.add(prefix + i);
                }

                final AtomicReference<String> hit = new AtomicReference<>(null);
                ExecutorService pool = Executors.newFixedThreadPool(32);
                for (final String host : hosts) {
                    try {
                        pool.submit(() -> {
                            if (hit.get() != null) return;
                            if (isAkisServer(host)) hit.compareAndSet(null, host);
                        });
                    } catch (Exception ignored) {
                    }
                }
                pool.shutdown();
                try {
                    pool.awaitTermination(15, TimeUnit.SECONDS);
                } catch (InterruptedException ignored) {
                }
                pool.shutdownNow();
                found = hit.get();
            }

            final String result = found;
            discovering = false;
            runOnUiThread(() -> {
                if (result == null) {
                    if (manual) {
                        Toast.makeText(
                                MainActivity.this,
                                "Ağda NOX sunucusu bulunamadı. Sunucu adresini elle gir.",
                                Toast.LENGTH_LONG
                        ).show();
                    }
                    return;
                }
                serverUrl = "http://" + result + ":" + SERVER_PORT;
                configured = true;
                autoDiscoveryTried = true;
                prefs.edit().putString(KEY_SERVER, serverUrl).apply();
                Toast.makeText(MainActivity.this, "Sunucu bulundu: " + result, Toast.LENGTH_SHORT).show();
                loadServer();
            });
        }, "akis-discovery").start();
    }

    private void showSetup(String errorMessage) {
        showingSetup = true;
        setContentView(buildSetup(errorMessage));
    }

    private int dp(float value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private GradientDrawable rounded(int fill, int stroke, float radiusDp) {
        GradientDrawable drawable = new GradientDrawable();
        drawable.setColor(fill);
        drawable.setCornerRadius(dp(radiusDp));
        if (stroke != Color.TRANSPARENT) {
            drawable.setStroke(dp(1), stroke);
        }
        return drawable;
    }

    private GradientDrawable accentButton() {
        GradientDrawable drawable = new GradientDrawable(
                GradientDrawable.Orientation.LEFT_RIGHT,
                new int[]{ACCENT, ACCENT_2}
        );
        drawable.setCornerRadius(dp(14));
        return drawable;
    }

    private TextView text(String value, float sizeSp, int color, boolean bold) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextSize(sizeSp);
        view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.DEFAULT_BOLD);
        return view;
    }

    private View buildSetup(String errorMessage) {
        ScrollView scroll = new ScrollView(this);
        scroll.setFillViewport(true);
        scroll.setBackgroundColor(BG);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER_HORIZONTAL);
        root.setPadding(dp(26), dp(42), dp(26), dp(30));
        scroll.addView(root, new ScrollView.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));

        TextView logo = text("NO", 42, ACCENT, true);
        logo.setGravity(Gravity.CENTER);
        root.addView(logo, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        ));

        TextView subtitle = text("Telefon uygulaması", 14, MUTED, false);
        subtitle.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams subParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        subParams.topMargin = dp(4);
        subParams.bottomMargin = dp(30);
        root.addView(subtitle, subParams);

        TextView label = text("Sunucu adresi", 12, MUTED, false);
        label.setPadding(dp(4), 0, 0, dp(6));
        root.addView(label);

        final EditText input = new EditText(this);
        input.setText(serverUrl == null || serverUrl.isEmpty() ? DEFAULT_SERVER : serverUrl);
        input.setSingleLine(true);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setTextColor(TEXT);
        input.setHintTextColor(MUTED);
        input.setHint("http://192.168.1.100:3000");
        input.setTextSize(16);
        input.setPadding(dp(14), dp(13), dp(14), dp(13));
        input.setBackground(rounded(SURFACE, BORDER, 14));
        LinearLayout.LayoutParams inputParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        root.addView(input, inputParams);

        TextView help = text(
                "Aynı Wi-Fi ağındaki bilgisayarda NOX sunucusu açık olmalı.\n"
                        + "Bilgisayarın adresini bilmiyorsan aşağıdaki “Ağı tara” düğmesini kullan.\n"
                        + "Sesli/görüntülü arama için https:// adresi gerekir.\n"
                        + "Mobil veride: bilgisayarda start-all.ps1'in yazdığı https://…trycloudflare.com adresi",
                12,
                MUTED,
                false
        );
        help.setLineSpacing(dp(3), 1f);
        LinearLayout.LayoutParams helpParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        helpParams.topMargin = dp(10);
        helpParams.bottomMargin = dp(16);
        root.addView(help, helpParams);

        final TextView error = text(errorMessage == null ? "" : errorMessage, 12.5f, DANGER, false);
        error.setVisibility(errorMessage == null ? View.GONE : View.VISIBLE);
        LinearLayout.LayoutParams errorParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        errorParams.bottomMargin = dp(10);
        root.addView(error, errorParams);

        Button connect = new Button(this);
        connect.setText("Bağlan");
        connect.setTextSize(15);
        connect.setTextColor(Color.WHITE);
        connect.setAllCaps(false);
        connect.setTypeface(Typeface.DEFAULT_BOLD);
        connect.setBackground(accentButton());
        connect.setPadding(dp(16), 0, dp(16), 0);
        LinearLayout.LayoutParams buttonParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(50)
        );
        root.addView(connect, buttonParams);
        connect.setOnClickListener(v -> {
            String normalized = normalizeServer(input.getText().toString());
            if (normalized == null) {
                error.setText("Geçerli bir sunucu adresi gir. Örnek: http://192.168.1.100:3000");
                error.setVisibility(View.VISIBLE);
                return;
            }
            serverUrl = normalized;
            configured = true;
            prefs.edit().putString(KEY_SERVER, normalized).apply();
            loadServer();
        });

        Button scan = new Button(this);
        scan.setText("Ağı tara ve bul");
        scan.setTextSize(14);
        scan.setTextColor(TEXT);
        scan.setAllCaps(false);
        scan.setBackground(rounded(Color.TRANSPARENT, BORDER, 14));
        LinearLayout.LayoutParams scanParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                dp(46)
        );
        scanParams.topMargin = dp(10);
        root.addView(scan, scanParams);
        scan.setOnClickListener(v -> discoverServer(true));

        if (configured && webView != null) {
            Button cancel = new Button(this);
            cancel.setText("Vazgeç");
            cancel.setTextSize(14);
            cancel.setTextColor(MUTED);
            cancel.setAllCaps(false);
            cancel.setBackground(rounded(Color.TRANSPARENT, BORDER, 14));
            LinearLayout.LayoutParams cancelParams = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    dp(46)
            );
            cancelParams.topMargin = dp(10);
            root.addView(cancel, cancelParams);
            cancel.setOnClickListener(v -> {
                showingSetup = false;
                setContentView(webView);
            });
        }

        TextView note = text(
                "İpucu: Sunucu adresini daha sonra uygulama içindeki Ayarlar → Uygulama bölümünden değiştirebilirsin.",
                11.5f,
                MUTED,
                false
        );
        note.setGravity(Gravity.CENTER);
        note.setLineSpacing(dp(2), 1f);
        LinearLayout.LayoutParams noteParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
        );
        noteParams.topMargin = dp(22);
        root.addView(note, noteParams);

        return scroll;
    }

    private String normalizeServer(String raw) {
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) return null;
        if (!value.matches("^[a-zA-Z][a-zA-Z0-9+.-]*://.*")) value = "http://" + value;

        Uri uri = Uri.parse(value);
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (host == null) return null;
        if (!"http".equalsIgnoreCase(scheme) && !"https".equalsIgnoreCase(scheme)) return null;

        String authority = uri.getAuthority();
        if (authority == null) return null;
        if (uri.getPort() == -1 && "http".equalsIgnoreCase(scheme)
                && host.matches("\\d+(\\.\\d+){3}")) {
            authority = host + ":3000";
        }
        return scheme.toLowerCase() + "://" + authority;
    }

    private boolean hasPermission(String permission) {
        return checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED;
    }

    private boolean isLocalHost(String url) {
        String host = Uri.parse(url).getHost();
        if (host == null) return false;
        host = host.toLowerCase();
        if (host.equals("localhost") || host.equals("127.0.0.1") || host.endsWith(".local")) return true;
        if (host.startsWith("10.") || host.startsWith("192.168.")) return true;
        if (host.startsWith("172.")) {
            try {
                int second = Integer.parseInt(host.split("\\.")[1]);
                return second >= 16 && second <= 31;
            } catch (Exception ignored) {
                return false;
            }
        }
        return false;
    }

    private boolean isServerHost(String host) {
        if (host == null) return false;
        String serverHost = Uri.parse(serverUrl == null ? "" : serverUrl).getHost();
        return host.equalsIgnoreCase(serverHost);
    }

    private class AppWebViewClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String scheme = uri.getScheme();
            if ("file".equalsIgnoreCase(scheme)) return false;
            if (("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme))
                    && isServerHost(uri.getHost())) {
                return false;
            }
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            } catch (Exception ignored) {
            }
            return true;
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            if (isLocalHost(error.getUrl())) {
                handler.proceed();
            } else {
                handler.cancel();
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            // Sunucuya ulaşılamadı: yerel (çevrimdışı) uygulamayı aç.
            CharSequence description = error.getDescription();
            String message = description != null && description.length() > 0 ? description.toString() : "bilinmeyen hata";
            Toast.makeText(MainActivity.this, "Sunucuya ulaşılamadı, yerel mod açıldı (" + message + ")", Toast.LENGTH_LONG).show();
            view.loadUrl("file:///android_asset/index.html?apk=1&offline=1");
        }
    }

    private class AppWebChromeClient extends WebChromeClient {
        @Override
        public void onPermissionRequest(final PermissionRequest request) {
            boolean needsCamera = false;
            boolean needsAudio = false;
            for (String resource : request.getResources()) {
                if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) needsCamera = true;
                if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) needsAudio = true;
            }
            if (!needsCamera && !needsAudio) {
                request.deny();
                return;
            }

            boolean cameraOk = !needsCamera || hasPermission(Manifest.permission.CAMERA);
            boolean audioOk = !needsAudio || hasPermission(Manifest.permission.RECORD_AUDIO);
            if (cameraOk && audioOk) {
                request.grant(request.getResources());
                return;
            }

            if (pendingPermissionRequest != null) pendingPermissionRequest.deny();
            pendingPermissionRequest = request;

            ArrayList<String> permissions = new ArrayList<>();
            if (!cameraOk) permissions.add(Manifest.permission.CAMERA);
            if (!audioOk) permissions.add(Manifest.permission.RECORD_AUDIO);
            requestPermissions(permissions.toArray(new String[0]), REQ_MEDIA);
        }

        @Override
        public boolean onShowFileChooser(
                WebView view,
                ValueCallback<Uri[]> callback,
                FileChooserParams params
        ) {
            if (pendingFileCallback != null) {
                pendingFileCallback.onReceiveValue(null);
            }
            pendingFileCallback = callback;

            Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            String[] acceptTypes = params.getAcceptTypes();
            if (acceptTypes != null && acceptTypes.length > 0) {
                intent.putExtra(Intent.EXTRA_MIME_TYPES, acceptTypes);
            }
            try {
                startActivityForResult(Intent.createChooser(intent, "Dosya seç"), REQ_FILE);
                return true;
            } catch (Exception exception) {
                pendingFileCallback = null;
                callback.onReceiveValue(null);
                return false;
            }
        }

        @Override
        public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) {
            callback.invoke(origin, false, false);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_MEDIA || pendingPermissionRequest == null) return;

        boolean granted = grantResults.length > 0;
        for (int result : grantResults) {
            if (result != PackageManager.PERMISSION_GRANTED) granted = false;
        }
        if (granted) {
            pendingPermissionRequest.grant(pendingPermissionRequest.getResources());
        } else {
            pendingPermissionRequest.deny();
            Toast.makeText(this, "Kamera ve mikrofon izni verilmedi.", Toast.LENGTH_SHORT).show();
        }
        pendingPermissionRequest = null;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (pendingFileCallback == null) return;
            Uri[] result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            pendingFileCallback.onReceiveValue(result);
            pendingFileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (showingSetup) {
            if (webView != null && configured) {
                showingSetup = false;
                setContentView(webView);
                return;
            }
            super.onBackPressed();
            return;
        }
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onPause() {
        if (webView != null) {
            webView.onPause();
            CookieManager.getInstance().flush();
        }
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) webView.onResume();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    public class Bridge {
        @JavascriptInterface
        public String getServerUrl() {
            return serverUrl == null ? "" : serverUrl;
        }

        @JavascriptInterface
        public void changeServer() {
            runOnUiThread(() -> showSetup(null));
        }
    }
}
