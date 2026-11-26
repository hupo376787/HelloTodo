using Avalonia;
using HelloTodo;
using Microsoft.Identity.Client;
internal static class Program
{
    [STAThread] public static void Main(string[] args)
    {
        if(OperatingSystem.IsMacOS())AppBranding.ChangeDockIcon=MacDockIcon.Update;
        IPublicClientApplication? cachedApp=null;string? cachedClient=null;
        async Task<string> Acquire(string clientId,string scope,CancellationToken ct){
            // Public client: no client secret, system browser, authorization code + PKCE.
            var app=cachedApp!=null&&cachedClient==clientId?cachedApp:PublicClientApplicationBuilder.Create(clientId)
                .WithAuthority("https://login.microsoftonline.com/common")
                .WithRedirectUri("http://localhost").Build();
            cachedApp=app;cachedClient=clientId;var scopes=new[]{scope};
            var accounts=(await app.GetAccountsAsync()).ToArray();if(accounts.Length==1){try{return (await app.AcquireTokenSilent(scopes,accounts[0]).ExecuteAsync(ct)).AccessToken;}catch(MsalUiRequiredException){}}
            var result=await app.AcquireTokenInteractive(scopes).WithUseEmbeddedWebView(false).ExecuteAsync(ct);
            return result.AccessToken;
        }
        MicrosoftImport.AcquireToken=(id,ct)=>Acquire(id,"https://graph.microsoft.com/Tasks.Read",ct);
        OutlookRecovery.AcquireToken=(id,ct)=>Acquire(id,"https://outlook.office.com/Tasks.Read",ct);
        AppBuilder.Configure<App>().UsePlatformDetect().WithInterFont().LogToTrace().StartWithClassicDesktopLifetime(args);
    }
}
