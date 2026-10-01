using Microsoft.Web.WebView2.Core;
using System;
using System.IO;
using System.Windows;

namespace SellerBooks.Admin;

public partial class OAuthWindow : Window
{
    private readonly string _launcherUrl;
    private readonly Action<bool, string?> _completed;
    private readonly string _userDataFolder;
    private bool _finished;

    public OAuthWindow(string launcherUrl, Action<bool, string?> completed)
    {
        InitializeComponent();

        _launcherUrl = launcherUrl ?? throw new ArgumentNullException(nameof(launcherUrl));
        _completed = completed ?? throw new ArgumentNullException(nameof(completed));

        _userDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "SellerBooks", "Admin", "OAuthWebView2-v1");

        Loaded += OAuthWindow_Loaded;
        Closed += OAuthWindow_Closed;
    }

    private async void OAuthWindow_Loaded(object sender, RoutedEventArgs e)
    {
        try
        {
            Directory.CreateDirectory(_userDataFolder);

            var environment = await CoreWebView2Environment.CreateAsync(
                browserExecutableFolder: null,
                userDataFolder: _userDataFolder,
                options: null);

            await OAuthBrowser.EnsureCoreWebView2Async(environment);

            var web = OAuthBrowser.CoreWebView2;
            web.Settings.AreDefaultContextMenusEnabled = true;
            web.Settings.AreDevToolsEnabled = false;
            web.Settings.IsStatusBarEnabled = false;
            web.Settings.AreBrowserAcceleratorKeysEnabled = true;
            web.Settings.UserAgent = web.Settings.UserAgent + " SellerBooksAdminOAuth/1.0";

            // Jika marketplace memakai window.open() atau target="_blank",
            // jangan biarkan browser membuat tab/window baru. Navigasikan
            // URL tersebut di WebView yang sama.
            web.NewWindowRequested += OAuth_NewWindowRequested;
            web.NavigationStarting += OAuth_NavigationStarting;
            web.NavigationCompleted += OAuth_NavigationCompleted;

            web.Navigate(_launcherUrl);
        }
        catch (Exception ex)
        {
            Finish(false, "OAUTH_WINDOW_INIT_FAILED: " + ex.Message);
        }
    }

    private void OAuth_NewWindowRequested(
        object? sender,
        CoreWebView2NewWindowRequestedEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(e.Uri))
        {
            e.Handled = true;
            return;
        }

        // Kunci utama perubahan:
        // popup/tab baru dari Lazada/TikTok diarahkan kembali ke
        // WebView OAuth yang sedang aktif.
        e.Handled = true;

        try
        {
            OAuthBrowser.CoreWebView2.Navigate(e.Uri);
        }
        catch (Exception ex)
        {
            Finish(false, "OAUTH_NEW_WINDOW_FAILED: " + ex.Message);
        }
    }

    private void OAuth_NavigationStarting(
        object? sender,
        CoreWebView2NavigationStartingEventArgs e)
    {
        if (string.IsNullOrWhiteSpace(e.Uri))
            return;

        try
        {
            var uri = new Uri(e.Uri);

            // Callback SellerBooks memiliki query sellerbooks_*_oauth.
            // Tangkap sebelum halaman callback sempat membuka deep-link
            // atau mencoba window.close().
            if (!string.Equals(
                    uri.Host,
                    "sellerbooks.github.io",
                    StringComparison.OrdinalIgnoreCase))
                return;

            var hasSellerBooksOAuthResult = false;
            var success = false;
            string? reason = null;
            string? connectionId = null;

            var query = System.Web.HttpUtility.ParseQueryString(uri.Query);
            foreach (var key in query.AllKeys)
            {
                if (string.IsNullOrWhiteSpace(key))
                    continue;

                if (key.StartsWith("sellerbooks_", StringComparison.OrdinalIgnoreCase) &&
                    key.EndsWith("_oauth", StringComparison.OrdinalIgnoreCase))
                {
                    hasSellerBooksOAuthResult = true;
                    var value = query[key] ?? "";
                    success = string.Equals(value, "success", StringComparison.OrdinalIgnoreCase);
                    reason = query["reason"];
                    connectionId = query["connection_id"];
                    break;
                }
            }

            if (!hasSellerBooksOAuthResult)
                return;

            e.Cancel = true;
            Finish(success, reason ?? connectionId);
        }
        catch
        {
            // Biarkan navigasi normal jika URL bukan callback yang dikenali.
        }
    }

    private void OAuth_NavigationCompleted(
        object? sender,
        CoreWebView2NavigationCompletedEventArgs e)
    {
        if (!e.IsSuccess && !_finished)
        {
            // Jangan langsung menganggap OAuth gagal karena beberapa
            // marketplace melakukan redirect bertahap.
        }
    }

    private void Finish(bool success, string? detail)
    {
        if (_finished)
            return;

        _finished = true;

        try
        {
            _completed(success, detail);
        }
        catch
        {
            // Jangan biarkan callback aplikasi menggagalkan penutupan window.
        }

        Dispatcher.BeginInvoke(new Action(() =>
        {
            try { Close(); } catch { }
        }));
    }

    private void OAuthWindow_Closed(object? sender, EventArgs e)
    {
        if (_finished)
            return;

        // Window ditutup manual sebelum OAuth selesai.
        _finished = true;
        try { _completed(false, "OAUTH_WINDOW_CLOSED"); } catch { }
    }
}
