using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace HelloTodo;

// Desktop uses the same authenticated Worker manifest-index / raw-download protocol as Web.
// Mobile opens the Web migration UI until its native OAuth callbacks are configured and tested.
public static class OutlookRecovery
{
    public static Func<string,CancellationToken,Task<string>>? AcquireToken { get; set; }
    public sealed record Result(int Tasks,int Completed,int Downloaded,int Skipped,int Pending,IReadOnlyList<string> Errors);
    private static string Canonical(string value)=>value.Replace('+','_').Replace('/','-');
    private static bool ValidId(string value)=>value.Length<=1024&&Regex.IsMatch(value,"^[-_A-Za-z0-9+/]+={0,2}$");
    private static string Text(JsonNode? node,string key)=>node?[key]?.ToString()??"";
    private static string Hash(byte[] bytes)=>Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    private static string Stable(string task,string source)=>"msattachment-"+Hash(Encoding.UTF8.GetBytes(task+"/"+source));
    private static JsonObject Status(string status,string? message=null)=>new(){["attachmentImport"]=new JsonObject{["status"]=status,["errors"]=message==null?new JsonArray():new JsonArray(new JsonObject{["stage"]="Outlook 批量补齐",["message"]=message})}};
    public static async Task<Result> Run(Store store,string token,Action<string> progress,CancellationToken ct)
    {
        var cloud=store.Cloud??throw new InvalidOperationException("请先连接云工作区");var workspace=store.Workspace;
        var endpoint=new Uri(cloud.Endpoint.TrimEnd('/')+"/api/outlook/attachment-probe");
        if((endpoint.Scheme!="https"&&!(endpoint.Scheme=="http"&&endpoint.IsLoopback))||endpoint.UserInfo.Length!=0||endpoint.Query.Length!=0||endpoint.Fragment.Length!=0)throw new InvalidOperationException("工作区地址无效");
        using var http=new HttpClient(new HttpClientHandler{AllowAutoRedirect=false}){Timeout=TimeSpan.FromMinutes(3)};
        void Check(){ct.ThrowIfCancellationRequested();if(store.Workspace!=workspace)throw new InvalidOperationException("工作区已切换");}
        async Task<HttpResponseMessage> Request(JsonObject body){Check();body["accessToken"]=token;using var req=new HttpRequestMessage(HttpMethod.Post,endpoint);req.Headers.Authorization=new AuthenticationHeaderValue("Bearer",cloud.Key);req.Content=JsonContent.Create(body,options:Store.Json);var response=await http.SendAsync(req,HttpCompletionOption.ResponseHeadersRead,ct);if(response.StatusCode!=System.Net.HttpStatusCode.OK){var status=(int)response.StatusCode;response.Dispose();throw new IOException("附件服务 HTTP "+status);}return response;}
        var tasks=store.Tasks("attachments-pending").Take(200).ToArray();var ids=tasks.Select(t=>Store.Str(t,"source")).Where(ValidId).Select(Canonical).GroupBy(x=>x).Where(g=>g.Count()==1).Select(g=>g.Key).ToArray();
        var folders=store.All("task").Select(t=>Store.Str(t,"sourceListId")).Concat(store.All("list").Select(l=>Store.Str(l,"source"))).Where(ValidId).Select(Canonical).Distinct().ToArray();
        var index=new Dictionary<string,(string Folder,JsonObject Manifest)>();var errors=new List<string>();int scanned=0,downloaded=0,skipped=0,completed=0,pending=0;
        foreach(var folder in folders){Check();var remaining=ids.Where(id=>!index.ContainsKey(id)).ToArray();if(remaining.Length==0)break;try{using var r=await Request(new(){["mode"]="manifest-index",["folderId"]=folder,["taskIds"]=new JsonArray(remaining.Select(x=>(JsonNode?)JsonValue.Create(x)).ToArray())});var result=JsonNode.Parse(await r.Content.ReadAsStringAsync(ct));if(result?["manifests"] is not JsonArray manifests)throw new IOException("清单索引响应无效");foreach(var m in manifests.OfType<JsonObject>()){var id=Canonical(Text(m,"taskId"));if(remaining.Contains(id)&&m["attachments"] is JsonArray files&&files.Count>0)index.TryAdd(id,(folder,m));}}catch(OperationCanceledException){throw;}catch(Exception e){errors.Add("清单索引："+e.Message);}progress($"Outlook 索引 {++scanned}/{folders.Length} · 匹配 {index.Count}/{tasks.Length}");}
        foreach(var task in tasks){Check();var source=Canonical(Store.Str(task,"source"));var failures=new List<string>();if(!index.TryGetValue(source,out var hit)||hit.Manifest["attachments"] is not JsonArray files){failures.Add("未匹配原始任务 ID（旧数据缺少清单 ID 时，请在网页版补齐）");}else{
                if(files.Count==0||files.Count!=files.OfType<JsonObject>().Count()||files.Count!=hit.Manifest["attachmentCount"]?.GetValue<int>()){failures.Add("附件清单数量不一致");}
                foreach(var file in files.OfType<JsonObject>()){Check();var fileId=Canonical(Text(file,"id"));var name=Text(file,"name");try{
                        if(!ValidId(fileId))throw new IOException("附件 ID 无效");var previous=store.All("attachment").FirstOrDefault(a=>Store.Str(a,"taskId")==task.Id&&Canonical(Store.Str(a,"source"))==fileId);string id=previous?.Id??Stable(task.Id,fileId);
                        if(store.State.Records.TryGetValue("attachment:"+id,out var old)&&old.Deleted)throw new IOException("附件曾被用户删除，未恢复");
                        if(previous!=null){byte[]? existing=store.File(id);if(existing==null){try{existing=await store.Download(id);}catch(HttpRequestException){}catch(IOException){}}if(existing!=null){if(!long.TryParse(Store.Str(previous,"size"),out var size)||size!=existing.Length)throw new IOException("已有附件大小不一致，未覆盖");string hash=Text(previous.Data["raw"],"sha256");if(hash.Length>0&&hash!=Hash(existing))throw new IOException("已有附件 SHA-256 不一致，未覆盖");skipped++;continue;}}
                        using var response=await Request(new(){["mode"]="download-indexed",["folderId"]=hit.Folder,["taskId"]=source,["attachmentId"]=fileId,["attachmentCount"]=hit.Manifest["attachmentCount"]?.DeepClone(),["file"]=file.DeepClone()});
                        string Header(string key)=>response.Headers.TryGetValues(key,out var values)?Uri.UnescapeDataString(values.FirstOrDefault()??""):"";
                        if(Canonical(Header("X-HelloTodo-Attachment-Id"))!=fileId||Header("X-HelloTodo-Stage")!="downloaded"||response.Content.Headers.ContentRange!=null)throw new IOException("附件响应标识不匹配");
                        await using var input=await response.Content.ReadAsStreamAsync(ct);using var ms=new MemoryStream();var buffer=new byte[81920];int n;while((n=await input.ReadAsync(buffer.AsMemory(),ct))>0){if(ms.Length+n>25*1024*1024)throw new IOException("附件超过 25 MiB");ms.Write(buffer,0,n);}if(!long.TryParse(Header("X-HelloTodo-Attachment-Size"),out var expected)||expected!=ms.Length||(response.Content.Headers.ContentLength is long length&&length!=ms.Length))throw new IOException("附件传输不完整");var bytes=ms.ToArray();var digest=Hash(bytes);
                        var previousHash=Text(previous?.Data["raw"],"sha256");if(previousHash.Length>0&&previousHash!=digest)throw new IOException("相同附件 ID 的文件内容已变化，未覆盖");Check();store.PutFile(id,bytes);store.Edit("attachment",id,new(){["taskId"]=task.Id,["name"]=name.Length>0?name:"Outlook 附件",["type"]=Header("X-HelloTodo-Attachment-Type"),["size"]=bytes.Length,["source"]=fileId,["raw"]=new JsonObject{["recovery"]="outlook-raw-download",["sha256"]=digest,["expectedSize"]=file["expectedSize"]?.DeepClone(),["actualSize"]=bytes.Length,["sizeMismatch"]=Header("X-HelloTodo-Size-Mismatch")=="true",["upstreamRequestId"]=Header("X-HelloTodo-Upstream-Request-Id")}});downloaded++;
                    }catch(OperationCanceledException){throw;}catch(Exception e){failures.Add(name+"："+e.Message);}}
            }
            Check();if(failures.Count==0){store.Edit("task",task.Id,Status("complete"));completed++;}else{pending++;var message=string.Join("；",failures);if(message.Length>500)message=message[..500];store.Edit("task",task.Id,Status("pending",message));errors.Add(Store.Str(task,"title")+"："+message);}progress($"Outlook 附件补齐 {completed+pending}/{tasks.Length} · 已下载 {downloaded}");
        }
        return new(tasks.Length,completed,downloaded,skipped,pending,errors);
    }
}
