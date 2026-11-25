using System;
using System.Diagnostics;
using Microsoft.Web.WebView2.Core;

static class MediaLinks
{
    static readonly string[] AllowedHosts = {
        "openlibrary.org", "www.netflix.com", "www.youtube.com", "www.teleparty.com",
        "www.imdb.com", "commons.wikimedia.org"
    };

    public static void Configure(CoreWebView2 core)
    {
        core.AddWebResourceRequestedFilter(
            "https://www.youtube-nocookie.com/embed/*",
            CoreWebView2WebResourceContext.Document);
        core.WebResourceRequested += (sender, args) => {
            if (!args.Request.Headers.Contains("Referer"))
                args.Request.Headers.SetHeader("Referer", "https://nosotros.local/");
        };
    }

    public static void Open(string value)
    {
        Uri url;
        if (!Uri.TryCreate(value, UriKind.Absolute, out url)
            || url.Scheme != "https" || !url.IsDefaultPort
            || !String.IsNullOrEmpty(url.UserInfo)
            || Array.IndexOf(AllowedHosts, url.IdnHost) < 0)
            return;

        Process.Start(new ProcessStartInfo(url.AbsoluteUri) { UseShellExecute = true });
    }
}
