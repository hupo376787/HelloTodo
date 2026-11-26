using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Globalization;
namespace HelloTodo;

public static class MicrosoftImport
{
    // Desktop registers its MSAL public client; mobile can register platform-specific handlers later.
    public static Func<string,CancellationToken,Task<string>>? AcquireToken { get; set; }
    public static string ClientId()
    {
        using var s=typeof(MicrosoftImport).Assembly.GetManifestResourceStream("HelloTodo.MicrosoftConfig.json") ?? throw new InvalidOperationException("缺少微软登录配置");
        var id=JsonNode.Parse(s)?["clientId"]?.ToString();
        if(!Guid.TryParseExact(id,"D",out var guid)||guid==Guid.Empty)throw new InvalidOperationException("HelloTodo 发布者尚未配置 Microsoft 登录，请联系开发者。");
        return guid.ToString("D");
    }
    private static string Val(JsonNode? j,string k,string fallback="")=>j?[k]?.ToString()??fallback;
    private static string Stable(string prefix,string s)=>prefix+"-"+Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(s))).ToLowerInvariant();
    private static string Esc(string s)=>Uri.EscapeDataString(s);
    private static JsonNode? Clone(JsonNode? j)=>j?.DeepClone();
    private static string? Date(JsonNode? j){var s=Val(j,"dateTime");return s.Length>=10?s[..10]:null;}
    private static string? Instant(JsonNode? j)
    {
        var s=Val(j,"dateTime");if(s.Length==0)return null;
        if((s.EndsWith("Z",StringComparison.OrdinalIgnoreCase)||System.Text.RegularExpressions.Regex.IsMatch(s,@"[+-]\d\d:\d\d$"))&&DateTimeOffset.TryParse(s,CultureInfo.InvariantCulture,DateTimeStyles.None,out var dto))return dto.ToUniversalTime().ToString("O");
        if(!DateTime.TryParse(s,CultureInfo.InvariantCulture,DateTimeStyles.None,out var local))return null;
        try {var zone=TimeZoneInfo.FindSystemTimeZoneById(Val(j,"timeZone","UTC"));return TimeZoneInfo.ConvertTimeToUtc(DateTime.SpecifyKind(local,DateTimeKind.Unspecified),zone).ToString("O");}catch{return null;}
    }
    public sealed class Counts
    {
        public int Lists,Tasks,Steps,Links,Attachments,Skipped;
        public List<string> Errors {get;}=new();
        public override string ToString()=> $"清单 {Lists} · 任务 {Tasks} · 步骤 {Steps} · 附件 {Attachments} · 链接 {Links} · 已存在 {Skipped} · 错误 {Errors.Count}";
    }
    public static async Task<Counts> Run(Store store,string token,Action<string> progress,CancellationToken ct)
    {
        using var http=new HttpClient(new HttpClientHandler{AllowAutoRedirect=false}){Timeout=TimeSpan.FromSeconds(60)};
        var counts=new Counts();var workspace=store.Workspace;
        void Check(){ct.ThrowIfCancellationRequested();if(store.Workspace!=workspace)throw new InvalidOperationException("工作区已切换，导入停止");}
        async Task<HttpResponseMessage> Request(string path)
        {
            var u=new Uri(new Uri("https://graph.microsoft.com/v1.0/"),path);
            if(u.Scheme!="https"||u.Host!="graph.microsoft.com"||!u.IsDefaultPort||!u.AbsolutePath.StartsWith("/v1.0/",StringComparison.Ordinal))throw new InvalidOperationException("Invalid Graph URL");
            for(int i=0;;i++){
                Check();using var req=new HttpRequestMessage(HttpMethod.Get,u);req.Headers.Authorization=new AuthenticationHeaderValue("Bearer",token);
                var r=await http.SendAsync(req,HttpCompletionOption.ResponseHeadersRead,ct);
                if(((int)r.StatusCode is 429 or 503 or 504) && i<3){var delay=r.Headers.RetryAfter?.Delta??TimeSpan.FromSeconds(Math.Pow(2,i));r.Dispose();await Task.Delay(TimeSpan.FromSeconds(Math.Clamp(delay.TotalSeconds,1,30)),ct);continue;}
                if(!r.IsSuccessStatusCode){var status=(int)r.StatusCode;r.Dispose();throw new HttpRequestException("Graph HTTP "+status+": "+u.AbsolutePath);}
                return r;
            }
        }
        async Task<List<JsonObject>> Pages(string path)
        {
            var list=new List<JsonObject>();var seen=new HashSet<string>();string? next=path;
            while(!string.IsNullOrEmpty(next)){if(!seen.Add(next))throw new InvalidOperationException("Graph 分页循环");using var r=await Request(next);var j=JsonNode.Parse(await r.Content.ReadAsStringAsync(ct));if(j?["value"] is not JsonArray values)throw new InvalidOperationException("Graph 列表响应不正确");foreach(var v in values.OfType<JsonObject>())list.Add(v);next=j["@odata.nextLink"]?.ToString();}
            return list;
        }
        async Task<byte[]> Attachment(JsonObject a,string path)
        {
            const int max=25*1024*1024;var content=Val(a,"contentBytes");if(content.Length>0){if(content.Length>((max+2)/3)*4)throw new IOException("附件超过 25 MiB");var b=Convert.FromBase64String(content);if(b.Length>max)throw new IOException("附件超过 25 MiB");return b;}
            using var r=await Request(path);if(r.Content.Headers.ContentLength>max)throw new IOException("附件超过 25 MiB");await using var stream=await r.Content.ReadAsStreamAsync(ct);using var ms=new MemoryStream();var buffer=new byte[81920];int n;while((n=await stream.ReadAsync(buffer.AsMemory(),ct))>0){if(ms.Length+n>max)throw new IOException("附件超过 25 MiB");ms.Write(buffer,0,n);}if(r.Content.Headers.ContentLength is long length&&length!=ms.Length)throw new IOException("附件传输不完整");return ms.ToArray();
        }
        foreach(var l in await Pages("me/todo/lists")){
            Check();var source=Val(l,"id");if(source.Length==0)continue;var lp="me/todo/lists/"+Esc(source);var lid=Val(l,"wellknownListName")=="defaultList"?"inbox":Stable("mslist",source);
            if(lid!="inbox"&&!store.State.Records.ContainsKey("list:"+lid)){store.Edit("list",lid,new(){["title"]=Val(l,"displayName","未命名清单"),["source"]=source,["position"]=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),["raw"]=Clone(l)});counts.Lists++;}
            if(lid!="inbox"&&store.Get("list",lid)==null)continue;
            foreach(var t in await Pages(lp+"/tasks")){
                Check();var ts=Val(t,"id");if(ts.Length==0)continue;var tp=lp+"/tasks/"+Esc(ts);var id=Stable("mstask",source+"/"+ts);
                if(!store.State.Records.ContainsKey("task:"+id)){
                    var created=Val(t,"createdDateTime",DateTimeOffset.UtcNow.ToString("O"));var pos=DateTimeOffset.TryParse(created,out var dt)?dt.ToUnixTimeMilliseconds():DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
                    store.Edit("task",id,new(){["title"]=Val(t,"title","未命名任务"),["listId"]=lid,["sourceListId"]=source,["notes"]=Val(t["body"],"content"),["completed"]=Val(t,"status")=="completed",["completedAt"]=Instant(t["completedDateTime"]),["createdAt"]=created,["due"]=Date(t["dueDateTime"]),["reminder"]=Val(t,"isReminderOn").Equals("true",StringComparison.OrdinalIgnoreCase)?Instant(t["reminderDateTime"]):null,["repeat"]=Clone(t["recurrence"]),["important"]=Val(t,"importance")=="high",["position"]=pos,["source"]=ts,["raw"]=Clone(t)});counts.Tasks++;
                }else counts.Skipped++;
                if(store.Get("task",id)==null)continue;
                var local=store.Get("task",id)!;if(Store.Str(local,"sourceListId")=="")store.Edit("task",id,new(){["sourceListId"]=source});
                var attachmentExpected=Val(t,"hasAttachments").Equals("true",StringComparison.OrdinalIgnoreCase);
                foreach(var (endpoint,kind) in new[]{("checklistItems","step"),("linkedResources","link"),("attachments","attachment")}){
                    if(kind=="attachment"&&(!attachmentExpected||local.Data["attachmentImport"]?["status"]?.ToString()=="complete"&&store.AttachmentStatus(local).Count>0))continue;
                    try{var items=await Pages(tp+"/"+endpoint);if(kind=="attachment"&&items.Count==0)throw new IOException("微软标记有附件，但附件列表为空");foreach(var a in items){
                        Check();var aidSource=Val(a,"id");if(aidSource.Length==0)continue;var aid=Stable("ms"+kind,id+"/"+aidSource);if(store.State.Records.TryGetValue(kind+":"+aid,out var saved)&&(saved.Deleted||kind!="attachment"||store.File(aid)!=null))continue;
                        if(kind=="step"){store.Edit(kind,aid,new(){["taskId"]=id,["title"]=Val(a,"displayName"),["completed"]=Val(a,"isChecked").Equals("true",StringComparison.OrdinalIgnoreCase),["position"]=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),["source"]=aidSource,["raw"]=Clone(a)});counts.Steps++;}
                        else if(kind=="link"){store.Edit(kind,aid,new(){["taskId"]=id,["title"]=Val(a,"displayName",Val(a,"applicationName","链接")),["url"]=Val(a,"webUrl"),["raw"]=Clone(a)});counts.Links++;}
                        else{var b=await Attachment(a,tp+"/attachments/"+Esc(aidSource)+"/$value");Check();var raw=(JsonObject)a.DeepClone();raw.Remove("contentBytes");store.PutFile(aid,b);store.Edit(kind,aid,new(){["taskId"]=id,["name"]=Val(a,"name","附件"),["type"]=Val(a,"contentType","application/octet-stream"),["size"]=b.Length,["source"]=aidSource,["raw"]=raw});counts.Attachments++;}
                    }if(kind=="attachment")store.Edit("task",id,new(){["attachmentImport"]=new JsonObject{["status"]="complete",["errors"]=new JsonArray()}});
                    }catch(OperationCanceledException){throw;}catch(Exception e){Check();counts.Errors.Add(Val(t,"title")+" / "+endpoint+": "+e.Message);if(kind=="attachment")store.Edit("task",id,new(){["attachmentImport"]=new JsonObject{["status"]="pending",["errors"]=new JsonArray(new JsonObject{["stage"]="附件列表或下载",["message"]="微软附件未全部恢复，请在网页版重试"})}});}
                }
                progress(counts.ToString());
            }
        }
        return counts;
    }
}
