# SellerBooks Admin — Windows 10/11 x64

This project creates a separate Windows desktop installer for the live SellerBooks Admin web app.

Live URL:
https://sellerbooks.github.io/

The Windows application does not bundle the SellerBooks HTML. It loads the live GitHub Pages URL, so HTML/CSS/JS updates can be reflected without reinstalling the Windows application.

Target:
- Windows 10 x64
- Windows 11 x64
- .NET 8 self-contained
- Microsoft WebView2 Evergreen Runtime
- Separate persistent WebView2 profile under %LOCALAPPDATA%\SellerBooks\Admin\WebView2

The wrapper provides:
- Friendly offline screen and retry
- Persistent login/session cookies
- Native Save dialog for web downloads such as Excel, CSV, JSON and PDF
- Normal WebView2 file picker for web uploads
- Separate desktop shortcut
