# SellerBooks Admin — Windows 10/11 x64

This project creates a separate Windows desktop installer for the live SellerBooks Admin web app.

Live URL:
https://sellerbooks.amasaindonesia.com/

The Windows application does not bundle the SellerBooks HTML. It loads the live website URL above, so HTML/CSS/JavaScript updates can be reflected without reinstalling the Windows application. Changes to the Windows wrapper itself still require a new Windows build and installer.

Target:
- Windows 10 x64
- Windows 11 x64
- .NET 8 self-contained
- Microsoft WebView2 Evergreen Runtime
- Separate persistent WebView2 profile under %LOCALAPPDATA%\\SellerBooks\\Admin\\WebView2

The wrapper provides:
- Friendly offline screen and retry
- Persistent login/session cookies
- Native Save dialog for web downloads such as Excel, CSV, JSON and PDF
- Normal WebView2 file picker for web uploads
- External handling for WhatsApp and email links
- Separate desktop shortcut

OAuth and marketplace sign-in flows should be verified after changing the live domain, especially where marketplace developer settings require a registered callback or redirect URL.
