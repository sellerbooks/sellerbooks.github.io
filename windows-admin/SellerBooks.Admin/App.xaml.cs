using System.IO;
using System.Windows;
using System.Windows.Threading;

namespace SellerBooks.Admin;

public partial class App : Application
{
    private static readonly string LogDirectory = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "SellerBooks", "Admin");

    private static readonly string LogFile = Path.Combine(LogDirectory, "startup.log");

    public App()
    {
        DispatcherUnhandledException += App_DispatcherUnhandledException;
        AppDomain.CurrentDomain.UnhandledException += CurrentDomain_UnhandledException;
        TaskScheduler.UnobservedTaskException += TaskScheduler_UnobservedTaskException;
    }

    protected override void OnStartup(StartupEventArgs e)
    {
        try
        {
            Directory.CreateDirectory(LogDirectory);
            Log("=== SellerBooks Admin startup ===");
            Log("OS: " + Environment.OSVersion);
            Log("64-bit OS: " + Environment.Is64BitOperatingSystem);
            Log("64-bit process: " + Environment.Is64BitProcess);
            Log("Base directory: " + AppContext.BaseDirectory);
            Log("WebView2 runtime: " + GetWebView2Version());
        }
        catch (Exception ex)
        {
            LogException("Startup logging failed", ex);
        }

        base.OnStartup(e);
    }

    private static string GetWebView2Version()
    {
        try
        {
            var version = Microsoft.Web.WebView2.Core.CoreWebView2Environment.GetAvailableBrowserVersionString();
            return string.IsNullOrWhiteSpace(version) ? "NOT FOUND" : version;
        }
        catch (Exception ex)
        {
            return "ERROR: " + ex.Message;
        }
    }

    private void App_DispatcherUnhandledException(object sender, DispatcherUnhandledExceptionEventArgs e)
    {
        LogException("DispatcherUnhandledException", e.Exception);
        ShowFatalError(e.Exception);
        e.Handled = true;
    }

    private static void CurrentDomain_UnhandledException(object sender, UnhandledExceptionEventArgs e)
    {
        if (e.ExceptionObject is Exception ex)
            LogException("AppDomain.UnhandledException", ex);
    }

    private static void TaskScheduler_UnobservedTaskException(object? sender, UnobservedTaskExceptionEventArgs e)
    {
        LogException("TaskScheduler.UnobservedTaskException", e.Exception);
        e.SetObserved();
    }

    private static void ShowFatalError(Exception ex)
    {
        try
        {
            MessageBox.Show(
                "SellerBooks Admin tidak dapat dijalankan.\n\n" +
                "Detail error:\n" + ex.Message + "\n\n" +
                "Log:\n" + LogFile,
                "SellerBooks Admin",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
        }
        catch
        {
        }
    }

    private static void Log(string message)
    {
        try
        {
            Directory.CreateDirectory(LogDirectory);
            File.AppendAllText(
                LogFile,
                $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss}] {message}{Environment.NewLine}");
        }
        catch
        {
        }
    }

    private static void LogException(string context, Exception ex)
    {
        Log(context + ": " + ex);
    }
}
