using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Microsoft.Win32;
using System.ComponentModel;
using System.IO;
using System.Net.NetworkInformation;
using System.Diagnostics;
using System.Windows;
using System.Windows.Threading;

namespace SellerBooks.Admin;

public partial class MainWindow : Window
{
    private const string AppUrl = "https://sellerbooks.github.io/";
    private readonly string _userDataFolder;
    private readonly DispatcherTimer _networkTimer;
    private bool _offline;
    private OAuthWindow? _oauthWindow;

    public MainWindow()
    {
        InitializeComponent();

        _userDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "SellerBooks", "Admin", "WebView2-v2");

        _networkTimer = new DispatcherTimer
        {
            Interval = TimeSpan.FromSeconds(3)
        };
        _networkTimer.Tick += NetworkTimer_Tick;

        Loaded += MainWindow_Loaded;
        Closing += MainWindow_Closing;
    }

    private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        try
        {
            Directory.CreateDirectory(_userDataFolder);

            string? version = null;
            try
            {
                version = CoreWebView2Environment.GetAvailableBrowserVersionString();
            }
            catch
            {
                // Handled by the user-facing diagnostic below.
            }

            if (string.IsNullOrWhiteSpace(version))
            {
                ShowStartupError(
                    "Microsoft Edge WebView2 Runtime belum tersedia di komputer ini.\n\n" +
                    "Silakan jalankan Windows Update atau instal Microsoft Edge WebView2 Runtime, lalu buka SellerBooks Admin kembali.");
                return;
            }

            var environment = await CoreWebView2Environment.CreateAsync(
                browserExecutableFolder: null,
                userDataFolder: _userDataFolder,
                options: null);

            await Browser.EnsureCoreWebView2Async(environment);
            ConfigureBrowser(Browser.CoreWebView2);
            Browser.CoreWebView2.Navigate(AppUrl);
        }
        catch (Exception ex)
        {
            ShowStartupError(
                "SellerBooks Admin tidak dapat dijalankan.\n\n" +
                "Detail: " + ex.Message);
        }
    }

    private void ShowStartupError(string message)
    {
        Browser.Visibility = Visibility.Collapsed;
        OfflinePanel.Visibility = Visibility.Visible;

        MessageBox.Show(
            this,
            message,
            "SellerBooks Admin",
            MessageBoxButton.OK,
            MessageBoxImage.Warning);
    }

    private void ConfigureBrowser(CoreWebView2 web)
    {
        web.Settings.AreDefaultContextMenusEnabled = true;
        web.Settings.AreDevToolsEnabled = false;
        web.Settings.IsStatusBarEnabled = false;
        web.Settings.AreBrowserAcceleratorKeysEnabled = true;

        // Tandai WebView sebagai aplikasi Windows SellerBooks.
        // Dipakai oleh index.html agar hasil window.open() yang diteruskan
        // ke Chrome/Edge eksternal tidak dianggap sebagai popup terblokir.
        web.Settings.UserAgent = web.Settings.UserAgent + " SellerBooksAdmin/1.0";

        web.AddWebResourceRequestedFilter(
            "https://sellerbooks.github.io/*",
            CoreWebView2WebResourceContext.All);

        web.WebResourceRequested += Web_WebResourceRequested;
        web.NavigationCompleted += Web_NavigationCompleted;
        web.NewWindowRequested += Web_NewWindowRequested;
        web.WebMessageReceived += Web_WebMessageReceived;
        web.DownloadStarting += Web_DownloadStarting;
        web.ProcessFailed += Web_ProcessFailed;
    }

    private void Web_WebResourceRequested(
        object? sender,
        CoreWebView2WebResourceRequestedEventArgs e)
    {
        e.Request.Headers.SetHeader("Cache-Control", "no-cache");
    }

    private void Web_NavigationCompleted(
        object? sender,
        CoreWebView2NavigationCompletedEventArgs e)
    {
        if (e.IsSuccess)
            ShowBrowser();
        else
            ShowOffline();
    }

    private void Web_WebMessageReceived(
        object? sender,
        CoreWebView2WebMessageReceivedEventArgs e)
    {
        /*
           Hanya halaman resmi SellerBooks yang boleh meminta native host
           membuka browser eksternal.
        */
        var source = e.Source ?? string.Empty;

        /*
           WebView2 dapat mengirim Source dengan fragment/query yang berbeda.
           Validasi host resmi SellerBooks, bukan string URL yang harus identik.
        */
        try
        {
            if (!Uri.TryCreate(source, UriKind.Absolute, out var sourceUri) ||
                !string.Equals(
                    sourceUri.Host,
                    "sellerbooks.github.io",
                    StringComparison.OrdinalIgnoreCase))
                return;
        }
        catch
        {
            return;
        }

        string message;
        try
        {
            message = e.TryGetWebMessageAsString();

            /*
               Untuk kompatibilitas, bila payload dikirim sebagai JSON object
               dan bukan JSON string, gunakan WebMessageAsJson.
            */
            if (string.IsNullOrWhiteSpace(message))
                message = e.WebMessageAsJson;
        }
        catch
        {
            message = e.WebMessageAsJson;
        }

        if (string.IsNullOrWhiteSpace(message))
            return;

        try
        {
            using var document = System.Text.Json.JsonDocument.Parse(message);
            var root = document.RootElement;

            // Jika JS mengirim string JSON, unwrap string tersebut.
            if (root.ValueKind == System.Text.Json.JsonValueKind.String)
            {
                var nested = root.GetString();
                if (string.IsNullOrWhiteSpace(nested))
                    return;

                using var nestedDocument = System.Text.Json.JsonDocument.Parse(nested);
                root = nestedDocument.RootElement.Clone();
            }

            if (!root.TryGetProperty("type", out var typeElement) ||
                !string.Equals(
                    typeElement.GetString(),
                    "sellerbooks.oauth.launch",
                    StringComparison.Ordinal))
                return;

            if (!root.TryGetProperty("authorization_url", out var urlElement))
                return;

            var rawUrl = urlElement.GetString();
            if (string.IsNullOrWhiteSpace(rawUrl))
                return;

            if (!Uri.TryCreate(rawUrl, UriKind.Absolute, out var authorizationUri) ||
                !string.Equals(
                    authorizationUri.Scheme,
                    Uri.UriSchemeHttps,
                    StringComparison.OrdinalIgnoreCase))
            {
                MessageBox.Show(
                    this,
                    "URL otorisasi marketplace tidak valid.",
                    "Integrasikan Akun",
                    MessageBoxButton.OK,
                    MessageBoxImage.Warning);
                return;
            }

            var launcherUrl = authorizationUri.AbsoluteUri;

            if (root.TryGetProperty("launcher_url", out var launcherElement))
            {
                var rawLauncherUrl = launcherElement.GetString();

                if (!string.IsNullOrWhiteSpace(rawLauncherUrl) &&
                    Uri.TryCreate(rawLauncherUrl, UriKind.Absolute, out var parsedLauncherUri) &&
                    string.Equals(
                        parsedLauncherUri.Scheme,
                        Uri.UriSchemeHttps,
                        StringComparison.OrdinalIgnoreCase) &&
                    string.Equals(
                        parsedLauncherUri.Host,
                        "sellerbooks.github.io",
                        StringComparison.OrdinalIgnoreCase))
                {
                    launcherUrl = parsedLauncherUri.AbsoluteUri;
                }
            }

            LaunchMarketplaceOAuthWindow(launcherUrl);

            // Hanya satu launch.
            // Launcher akan mengganti URL dirinya dengan authorization_url,
            // sehingga login resmi marketplace tetap berada di TAB/WINDOW yang sama.
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                this,
                "Halaman login marketplace tidak dapat dibuka.\\n\\n" + ex.Message,
                "Integrasikan Akun",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
        }
    }

    private void LaunchMarketplaceOAuthWindow(string launcherUrl)
    {
        // OAuth marketplace sekarang dijalankan di WebView2 native berukuran
        // kecil. Dengan begitu NewWindowRequested dari Lazada/TikTok dapat
        // diarahkan kembali ke WebView yang sama, bukan menjadi tab Chrome baru.
        try
        {
            if (_oauthWindow != null)
            {
                try
                {
                    _oauthWindow.Activate();
                    return;
                }
                catch
                {
                    _oauthWindow = null;
                }
            }

            _oauthWindow = new OAuthWindow(
                launcherUrl,
                (success, detail) =>
                {
                    Dispatcher.BeginInvoke(new Action(() =>
                    {
                        _oauthWindow = null;

                        if (success)
                        {
                            // Koneksi sudah difinalisasi oleh backend OAuth.
                            // Muat ulang halaman Akun Toko agar status integrasi
                            // langsung terlihat tanpa membuka browser baru.
                            Browser.CoreWebView2?.Navigate(AppUrl + "#stores");
                        }
                        else if (!string.Equals(
                                     detail,
                                     "OAUTH_WINDOW_CLOSED",
                                     StringComparison.OrdinalIgnoreCase))
                        {
                            MessageBox.Show(
                                this,
                                "Integrasi akun marketplace tidak berhasil."
                                + (string.IsNullOrWhiteSpace(detail) ? "" : "\n\n" + detail),
                                "Integrasikan Akun",
                                MessageBoxButton.OK,
                                MessageBoxImage.Warning);
                        }
                    }));
                })
            {
                Owner = this
            };

            _oauthWindow.Closed += (_, _) => _oauthWindow = null;
            _oauthWindow.Show();
            _oauthWindow.Activate();
        }
        catch (Exception ex)
        {
            _oauthWindow = null;
            MessageBox.Show(
                this,
                "Jendela autentikasi marketplace tidak dapat dibuka.\n\n" + ex.Message,
                "Integrasikan Akun",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
        }
    }

    private static string? GetDefaultChromiumBrowserPath()
    {
        try
        {
            using var key = Registry.CurrentUser.OpenSubKey(
                @"Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice");

            var progId = key?.GetValue("ProgId") as string;

            if (string.IsNullOrWhiteSpace(progId))
                return null;

            var isChrome = progId.Contains("Chrome", StringComparison.OrdinalIgnoreCase);
            var isEdge = progId.Contains("MSEdge", StringComparison.OrdinalIgnoreCase) ||
                         progId.Contains("Edge", StringComparison.OrdinalIgnoreCase);

            if (!isChrome && !isEdge)
                return null;

            var candidates = isChrome
                ? new[]
                {
                    Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "Google", "Chrome", "Application", "chrome.exe"),
                    Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                        "Google", "Chrome", "Application", "chrome.exe"),
                    Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                        "Google", "Chrome", "Application", "chrome.exe")
                }
                : new[]
                {
                    Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86),
                        "Microsoft", "Edge", "Application", "msedge.exe"),
                    Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                        "Microsoft", "Edge", "Application", "msedge.exe")
                };

            return candidates.FirstOrDefault(File.Exists);
        }
        catch
        {
            return null;
        }
    }

    private void Web_NewWindowRequested(
        object? sender,
        CoreWebView2NewWindowRequestedEventArgs e)
    {
        // OAuth marketplace harus dibuka di browser Windows terpisah.
        // Jangan menavigasikan WebView utama karena popup OAuth dapat
        // kehilangan konteks/session dan berakhir menjadi halaman putih.
        e.Handled = true;

        if (string.IsNullOrWhiteSpace(e.Uri))
            return;

        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = e.Uri,
                UseShellExecute = true
            });
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                this,
                "Jendela autentikasi tidak dapat dibuka.\\n\\n" + ex.Message,
                "Integrasikan Akun",
                MessageBoxButton.OK,
                MessageBoxImage.Warning);
        }
    }

    private void Web_ProcessFailed(
        object? sender,
        CoreWebView2ProcessFailedEventArgs e)
    {
        Dispatcher.Invoke(() =>
            ShowStartupError("WebView2 mengalami kegagalan proses. Silakan tutup SellerBooks Admin dan buka kembali."));
    }

    private void Web_DownloadStarting(
        object? sender,
        CoreWebView2DownloadStartingEventArgs e)
    {
        Dispatcher.Invoke(() =>
        {
            var suggestedName = Path.GetFileName(e.ResultFilePath);
            if (string.IsNullOrWhiteSpace(suggestedName))
                suggestedName = "SellerBooks";

            var dialog = new SaveFileDialog
            {
                Title = "Simpan File SellerBooks",
                FileName = suggestedName,
                Filter = BuildFilter(suggestedName),
                AddExtension = true,
                OverwritePrompt = true
            };

            if (dialog.ShowDialog(this) == true)
            {
                e.ResultFilePath = dialog.FileName;
                e.Handled = true;
            }
            else
            {
                e.Cancel = true;
                e.Handled = true;
            }
        });
    }

    private static string BuildFilter(string fileName)
    {
        var ext = Path.GetExtension(fileName).ToLowerInvariant();
        return ext switch
        {
            ".xlsx" => "Excel Workbook (*.xlsx)|*.xlsx|All files (*.*)|*.*",
            ".xls" => "Excel Workbook (*.xls)|*.xls|All files (*.*)|*.*",
            ".csv" => "CSV (*.csv)|*.csv|All files (*.*)|*.*",
            ".json" => "JSON Backup (*.json)|*.json|All files (*.*)|*.*",
            ".pdf" => "PDF (*.pdf)|*.pdf|All files (*.*)|*.*",
            _ => "All files (*.*)|*.*"
        };
    }

    private void RetryButton_Click(object sender, RoutedEventArgs e)
    {
        TryNavigate();
    }

    private void TryNavigate()
    {
        if (Browser.CoreWebView2 is null)
            return;

        ShowLoading();

        try
        {
            Browser.CoreWebView2.Navigate(AppUrl);
        }
        catch
        {
            ShowOffline();
        }
    }

    private void ShowLoading()
    {
        OfflinePanel.Visibility = Visibility.Collapsed;
        Browser.Visibility = Visibility.Visible;
    }

    private void ShowBrowser()
    {
        _offline = false;
        _networkTimer.Stop();
        OfflinePanel.Visibility = Visibility.Collapsed;
        Browser.Visibility = Visibility.Visible;
    }

    private void ShowOffline()
    {
        _offline = true;
        Browser.Visibility = Visibility.Collapsed;
        OfflinePanel.Visibility = Visibility.Visible;
        _networkTimer.Start();
    }

    private void NetworkTimer_Tick(object? sender, EventArgs e)
    {
        if (!_offline || !NetworkInterface.GetIsNetworkAvailable())
            return;

        TryNavigate();
    }

    private void MainWindow_Closing(object? sender, CancelEventArgs e)
    {
        _networkTimer.Stop();
    }
}
