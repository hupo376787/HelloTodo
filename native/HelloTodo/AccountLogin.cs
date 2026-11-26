using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace HelloTodo;

public sealed record UserAccount(string Id,string? Email,string Workspace);
public sealed record AccountCredentials(string Token,UserAccount Account,long Expires);
public static class AccountLogin
{
    public static string ServerUrl()
    {
        var value=Environment.GetEnvironmentVariable("HELLOTODO_SERVER_URL");
        if(string.IsNullOrWhiteSpace(value))
        {
            using var stream=typeof(AccountLogin).Assembly.GetManifestResourceStream("HelloTodo.AccountConfig.json");
            using var config=stream==null?null:JsonDocument.Parse(stream);
            value=config?.RootElement.GetProperty("serverUrl").GetString();
        }
        return value?.Trim().TrimEnd('/')??"";
    }
    private sealed record DeviceRequest(string Id,string Secret,string VerificationUrl,long Expires);
    public static async Task<AccountCredentials> SignIn(string server,string? provider,Func<Uri,Task<bool>> launch,CancellationToken cancellationToken)
    {
        if(!Uri.TryCreate(server,UriKind.Absolute,out var origin)||(origin.Scheme!="https"&&!(origin.Scheme=="http"&&origin.IsLoopback)))throw new InvalidOperationException("发布者尚未配置账号服务地址，可先使用本地模式。");
        using var client=new HttpClient(new HttpClientHandler{AllowAutoRedirect=false,UseCookies=false}){BaseAddress=new Uri(origin.GetLeftPart(UriPartial.Authority)),Timeout=TimeSpan.FromSeconds(30)};
        using var start=await client.PostAsJsonAsync("/api/auth/device/start",new{label="HelloTodo · "+System.Runtime.InteropServices.RuntimeInformation.OSDescription},cancellationToken);
        await EnsureSuccess(start,cancellationToken);
        var request=await start.Content.ReadFromJsonAsync<DeviceRequest>(Store.Json,cancellationToken)??throw new IOException("账号服务未返回连接信息");
        if(!Uri.TryCreate(request.VerificationUrl,UriKind.Absolute,out var url)||url.GetLeftPart(UriPartial.Authority)!=origin.GetLeftPart(UriPartial.Authority))throw new IOException("账号服务返回了不同来源的登录地址");
        if(provider is "microsoft" or "google" or "apple")url=new Uri(url.AbsoluteUri+"&provider="+provider);
        if(!await launch(url))throw new IOException("无法打开系统浏览器");
        using var timeout=CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);timeout.CancelAfter(TimeSpan.FromMinutes(10));
        while(true)
        {
            await Task.Delay(TimeSpan.FromSeconds(3),timeout.Token);
            using var poll=await client.PostAsJsonAsync("/api/auth/device/poll",new{id=request.Id,secret=request.Secret},timeout.Token);
            if(poll.StatusCode==HttpStatusCode.Accepted)continue;
            await EnsureSuccess(poll,timeout.Token);
            return await poll.Content.ReadFromJsonAsync<AccountCredentials>(Store.Json,timeout.Token)??throw new IOException("账号服务未返回登录信息");
        }
    }
    private static async Task EnsureSuccess(HttpResponseMessage response,CancellationToken token)
    {
        if(response.IsSuccessStatusCode)return;
        try{var data=await response.Content.ReadFromJsonAsync<JsonElement>(cancellationToken:token);if(data.TryGetProperty("error",out var error))throw new InvalidOperationException(error.GetString());}
        catch(JsonException){ }
        throw new HttpRequestException("账号服务 HTTP "+(int)response.StatusCode);
    }
}
