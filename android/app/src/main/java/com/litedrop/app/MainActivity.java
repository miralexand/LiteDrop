package com.litedrop.app;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
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
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

public class MainActivity extends Activity {

    private static final String PREFS = "litedrop";
    private static final String KEY_URL = "server_url";
    private static final String KEY_TO = "upload_subdir";
    private static final int REQUEST_FILE_CHOOSER = 1001;
    private static final int REQUEST_STORAGE_PERMISSION = 1002;

    private WebView webView;
    private ProgressBar progressBar;
    private TextView addressLabel;
    private ValueCallback<Uri[]> fileCallback;
    private String currentUrl = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.web_view);
        progressBar = findViewById(R.id.progress_bar);
        addressLabel = findViewById(R.id.address_label);
        Button settingsButton = findViewById(R.id.settings_button);

        setupWebView();
        settingsButton.setOnClickListener(v -> showServerDialog(true));
        requestStoragePermission();

        String savedUrl = prefs().getString(KEY_URL, "");
        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
            updateAddressLabel();
        } else if (savedUrl == null || savedUrl.trim().isEmpty()) {
            showServerDialog(false);
        } else {
            loadServer();
        }
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private void setupWebView() {
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return handleExternalUrl(request.getUrl());
            }

            @SuppressWarnings("deprecation")
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return handleExternalUrl(Uri.parse(url));
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    Toast.makeText(MainActivity.this, R.string.page_error, Toast.LENGTH_LONG).show();
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progressBar.setProgress(newProgress);
                progressBar.setVisibility(newProgress >= 100 ? View.INVISIBLE : View.VISIBLE);
            }

            @Override
            public boolean onShowFileChooser(
                    WebView view,
                    ValueCallback<Uri[]> callback,
                    FileChooserParams params
            ) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = callback;

                Intent intent = params.createIntent();
                if (intent == null) {
                    intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                }
                if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
                try {
                    startActivityForResult(Intent.createChooser(intent, getString(R.string.app_name)), REQUEST_FILE_CHOOSER);
                    return true;
                } catch (ActivityNotFoundException error) {
                    fileCallback = null;
                    Toast.makeText(MainActivity.this, R.string.no_file_picker, Toast.LENGTH_SHORT).show();
                    return false;
                }
            }
        });
    }

    private boolean handleExternalUrl(Uri uri) {
        if (uri == null) {
            return false;
        }
        String scheme = uri.getScheme();
        if ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme)) {
            return false;
        }
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException ignored) {
            // Ignore unknown schemes.
        }
        return true;
    }

    private void requestStoragePermission() {
        String[] permissions;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissions = new String[]{
                    Manifest.permission.READ_MEDIA_IMAGES,
                    Manifest.permission.READ_MEDIA_VIDEO,
                    Manifest.permission.READ_MEDIA_AUDIO
            };
        } else {
            permissions = new String[]{Manifest.permission.READ_EXTERNAL_STORAGE};
        }
        for (String permission : permissions) {
            if (checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(permissions, REQUEST_STORAGE_PERMISSION);
                return;
            }
        }
    }

    private String normalizeServerUrl(String input) {
        String value = input == null ? "" : input.trim();
        if (value.isEmpty()) {
            return "";
        }
        if (!value.matches("^[a-zA-Z][a-zA-Z0-9+.-]*://.*$")) {
            value = "http://" + value;
        }
        return value.replaceAll("/+$", "");
    }

    private boolean isValidServerUrl(String url) {
        try {
            Uri uri = Uri.parse(url);
            String scheme = uri.getScheme();
            return uri.getHost() != null
                    && ("http".equalsIgnoreCase(scheme) || "https".equalsIgnoreCase(scheme));
        } catch (RuntimeException error) {
            return false;
        }
    }

    private String buildShareUrl(String serverUrl, String subdir) {
        int queryIndex = serverUrl.indexOf('?');
        String base = queryIndex >= 0 ? serverUrl.substring(0, queryIndex) : serverUrl;
        Uri.Builder builder = Uri.parse(base).buildUpon();
        builder.appendQueryParameter("mode", "upload");
        String to = subdir == null ? "" : subdir.trim();
        if (!to.isEmpty()) {
            builder.appendQueryParameter("to", to);
        }
        return builder.build().toString();
    }

    private void saveServer(String url, String to) {
        prefs().edit()
                .putString(KEY_URL, url)
                .putString(KEY_TO, to == null ? "" : to.trim())
                .apply();
    }

    private void updateAddressLabel() {
        String saved = prefs().getString(KEY_URL, "");
        String to = prefs().getString(KEY_TO, "");
        if (saved == null || saved.trim().isEmpty()) {
            addressLabel.setText(R.string.not_connected);
            return;
        }
        currentUrl = buildShareUrl(saved, to);
        addressLabel.setText(currentUrl);
    }

    private void loadServer() {
        updateAddressLabel();
        if (currentUrl.isEmpty()) {
            return;
        }
        webView.loadUrl(currentUrl);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private void showServerDialog(boolean canCancel) {
        String savedUrl = prefs().getString(KEY_URL, "");
        String savedTo = prefs().getString(KEY_TO, "");

        LinearLayout container = new LinearLayout(this);
        container.setOrientation(LinearLayout.VERTICAL);
        container.setPadding(dp(20), dp(8), dp(20), 0);

        TextView urlLabel = new TextView(this);
        urlLabel.setText(R.string.server_url_label);
        urlLabel.setTextColor(Color.parseColor("#5D7089"));
        urlLabel.setTextSize(12);
        container.addView(urlLabel);

        EditText urlInput = new EditText(this);
        urlInput.setHint(R.string.server_url_hint);
        urlInput.setText(savedUrl);
        urlInput.setSingleLine(true);
        urlInput.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        urlInput.setSelectAllOnFocus(true);
        container.addView(urlInput, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        TextView subdirLabel = new TextView(this);
        subdirLabel.setText(R.string.subdir_label);
        subdirLabel.setTextColor(Color.parseColor("#5D7089"));
        subdirLabel.setTextSize(12);
        LinearLayout.LayoutParams labelParams = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT);
        labelParams.topMargin = dp(14);
        container.addView(subdirLabel, labelParams);

        EditText subdirInput = new EditText(this);
        subdirInput.setText(savedTo);
        subdirInput.setSingleLine(true);
        subdirInput.setInputType(InputType.TYPE_CLASS_TEXT);
        container.addView(subdirInput, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.WRAP_CONTENT));

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(R.string.server_dialog_title)
                .setView(container)
                .setPositiveButton(R.string.open, null)
                .setNegativeButton(canCancel ? R.string.cancel : R.string.exit, null)
                .create();
        dialog.setCanceledOnTouchOutside(false);
        dialog.setOnShowListener(ignored -> {
            dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
                String url = normalizeServerUrl(urlInput.getText().toString());
                if (!isValidServerUrl(url)) {
                    Toast.makeText(this, R.string.invalid_url, Toast.LENGTH_SHORT).show();
                    return;
                }
                saveServer(url, subdirInput.getText().toString());
                dialog.dismiss();
                loadServer();
            });
            dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setOnClickListener(v -> {
                dialog.dismiss();
                if (!canCancel) {
                    finish();
                }
            });
        });
        dialog.show();
        urlInput.requestFocus();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_FILE_CHOOSER) {
            if (fileCallback == null) {
                return;
            }
            Uri[] results = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            fileCallback.onReceiveValue(results);
            fileCallback = null;
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        // The WebView file chooser uses the system document picker, so a denied
        // storage permission does not block uploads.
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null) {
            webView.saveState(outState);
        }
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onDestroy() {
        if (fileCallback != null) {
            fileCallback.onReceiveValue(null);
            fileCallback = null;
        }
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
