using Microsoft.Data.Sqlite;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Globalization;
namespace HelloTodo;
public sealed record Record(string Kind,string Id,JsonObject Data,bool Deleted=false,long Version=0,long Seq=0);
public sealed record Op(string Kind,string Id,JsonObject Patch,bool Deleted,string OpId);
public sealed class State
{
    public Dictionary<string,Record> Records {get;set;}=new();
    public List<Op> Pending {get;set;}=new();
    public long Cursor {get;set;}
    public string Theme {get;set;}="system";
    public string AccentColor {get;set;}="#3b82f6";
    public double TextScale {get;set;}=1;
    public bool WelcomeSeen {get;set;}
    public int AppearanceVersion {get;set;}
    public double SidebarWidth {get;set;}=260;
    public double DetailWidth {get;set;}=345;
    public Dictionary<string,JsonObject> Views {get;set;}=new();
}
public sealed record Connection(string Endpoint,string Key,string? AccountId=null);
public sealed record PushResponse(string[] Ack);
public sealed record PullResponse(Record[] Records,long Cursor,bool More);
public sealed class Store : IDisposable
{
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    public State State {get;private set;}=new();
    public Connection? Cloud {get;private set;}
    public string Workspace {get;private set;}="local";
    private readonly SqliteConnection db;
    private readonly HttpClient http=new(){Timeout=TimeSpan.FromSeconds(30)};
    public bool Busy {get;private set;}
    public Store(string? dataDirectory=null)
    {
        var folder=dataDirectory??Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"HelloTodo");Directory.CreateDirectory(folder);
        db=new SqliteConnection(new SqliteConnectionStringBuilder{DataSource=Path.Combine(folder,"hello.sqlite")}.ToString());db.Open();
        using var cmd=db.CreateCommand();cmd.CommandText="CREATE TABLE IF NOT EXISTS kv(k TEXT PRIMARY KEY,v TEXT NOT NULL); CREATE TABLE IF NOT EXISTS files(k TEXT PRIMARY KEY, b BLOB NOT NULL);";cmd.ExecuteNonQuery();
        Workspace=Read("active")??"local";State=Load(Workspace);var c=Read("connection:"+Workspace);if(c!=null)Cloud=JsonSerializer.Deserialize<Connection>(c,Json);
    }
    private string? Read(string k){using var cmd=db.CreateCommand();cmd.CommandText="SELECT v FROM kv WHERE k=$k";cmd.Parameters.AddWithValue("$k",k);return cmd.ExecuteScalar() as string;}
    private void Write(string k,string v){using var cmd=db.CreateCommand();cmd.CommandText="INSERT INTO kv(k,v) VALUES($k,$v) ON CONFLICT(k) DO UPDATE SET v=excluded.v";cmd.Parameters.AddWithValue("$k",k);cmd.Parameters.AddWithValue("$v",v);cmd.ExecuteNonQuery();}
    private State Load(string w)=>Read("state:"+w) is string s?JsonSerializer.Deserialize<State>(s,Json)??new():new();
    public void Save()=>Write("state:"+Workspace,JsonSerializer.Serialize(State,Json));
    public static string NewId()=>Guid.NewGuid().ToString();
    public static string Today()=>DateTime.Now.ToString("yyyy-MM-dd",CultureInfo.InvariantCulture);
    public static string Str(Record? r,string k,string fallback="")=>r?.Data[k] is JsonValue v?v.ToString():fallback;
    public static bool Bool(Record r,string k)=>r.Data[k]?.GetValue<bool>()==true;
    public IEnumerable<Record> All(string k)=>State.Records.Values.Where(r=>r.Kind==k&&!r.Deleted);
    public Record? Get(string k,string id)=>State.Records.TryGetValue(k+":"+id,out var r)&&!r.Deleted?r:null;
    public static JsonObject Merge(JsonObject data,JsonObject patch)
    {
        var n=(JsonObject)data.DeepClone();foreach(var (k,v) in patch){if(v==null)n.Remove(k);else if(v is JsonObject child)n[k]=Merge(n[k] as JsonObject??new(),child);else n[k]=v.DeepClone();}return n;
    }
    private void Apply(Op o){var k=o.Kind+":"+o.Id;var old=State.Records.GetValueOrDefault(k)??new(o.Kind,o.Id,new());State.Records[k]=old with{Data=Merge(old.Data,o.Patch),Deleted=old.Deleted||o.Deleted};}
    public void Edit(string kind,string id,JsonObject patch,bool deleted=false){var o=new Op(kind,id,patch,deleted,NewId());Apply(o);State.Pending.Add(o);Save();}
    public string Add(string title,string list,string view){var id=NewId();var p=new JsonObject{["title"]=title,["listId"]=list,["notes"]="",["completed"]=false,["important"]=view=="important",["createdAt"]=DateTimeOffset.UtcNow.ToString("O"),["position"]=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()};if(view=="day")p["myDay"]=Today();if(view=="planned")p["due"]=Today();Edit("task",id,p);return id;}
    public JsonObject Appearance(string view)=>Get("list",view)?.Data??State.Views.GetValueOrDefault(view)??new();
    public (int Count,bool Pending) AttachmentStatus(Record task){int count=All("attachment").Count(a=>Str(a,"taskId")==task.Id);var info=task.Data["attachmentImport"] as JsonObject;bool pending=info?["status"]?.ToString()=="pending"||(info==null&&task.Data["raw"]?["hasAttachments"]?.ToString().Equals("true",StringComparison.OrdinalIgnoreCase)==true);return (count,pending);}
    public static bool IsAttachmentView(string view)=>view is "attachments" or "attachments-ready" or "attachments-pending";
    public IEnumerable<Record> SortTasks(IEnumerable<Record> tasks,string view){string sort=Appearance(view)["sort"]?.ToString()??"position";return sort switch{"title"=>tasks.OrderBy(t=>Str(t,"title"),StringComparer.CurrentCulture),"due"=>tasks.OrderBy(t=>Str(t,"due","\uffff"),StringComparer.Ordinal),"important"=>tasks.OrderByDescending(t=>Bool(t,"important")),"createdAt"=>tasks.OrderByDescending(t=>Str(t,"createdAt"),StringComparer.Ordinal),_=>tasks.OrderByDescending(t=>long.TryParse(Str(t,"position"),out var n)?n:0)};}
    public IEnumerable<Record> Tasks(string view,string search="")=>All("task").Where(t=>Str(t,"listId")=="inbox"||Get("list",Str(t,"listId"))!=null).Where(t=>(search.Length==0||(Str(t,"title")+" "+Str(t,"notes")).Contains(search,StringComparison.OrdinalIgnoreCase))&&(search.Length>0&&!IsAttachmentView(view)|| (view switch{"day"=>Str(t,"myDay")==Today(),"important"=>Bool(t,"important"),"planned"=>Str(t,"due")!=""||Str(t,"reminder")!="","completed"=>Bool(t,"completed"),"all"=>true,"attachments"=>AttachmentStatus(t) is var a&&(a.Count>0||a.Pending),"attachments-ready"=>AttachmentStatus(t) is var b&&b.Count>0&&!b.Pending,"attachments-pending"=>AttachmentStatus(t).Pending,_=>Str(t,"listId")==view})));
    public void Complete(Record t,bool value){if(Bool(t,"completed")==value)return;Edit("task",t.Id,new(){["completed"]=value,["completedAt"]=value?JsonValue.Create(DateTimeOffset.UtcNow.ToString("O")):null});if(!value)return;var repeat=t.Data["repeat"];string pattern=repeat is JsonObject?repeat["pattern"]?["type"]?.ToString()??"":repeat?.ToString()??"";int interval=repeat is JsonObject?repeat["pattern"]?["interval"]?.GetValue<int>()??1:1;interval=Math.Clamp(interval,1,365);var date=DateOnly.TryParse(Str(t,"due"),out var d)?d:DateOnly.FromDateTime(DateTime.Today);DateOnly? next=pattern switch{"daily"=>date.AddDays(interval),"weekly"=>date.AddDays(7*interval),"monthly" or "absoluteMonthly"=>date.AddMonths(interval),"yearly" or "absoluteYearly"=>date.AddYears(interval),"weekdays"=>date.AddDays(date.DayOfWeek==DayOfWeek.Friday?3:date.DayOfWeek==DayOfWeek.Saturday?2:1),_=>null};if(next==null)return;var due=next.Value.ToString("yyyy-MM-dd",CultureInfo.InvariantCulture);if(repeat is JsonObject r&&r["range"] is JsonObject range){if(range["type"]?.ToString()=="endDate"&&string.CompareOrdinal(due,range["endDate"]?.ToString())>0)return;if(range["type"]?.ToString()=="numbered"&&(range["numberOfOccurrences"]?.GetValue<int>()??0)<=1)return;}var id="repeat-"+(t.Id.Length>80?t.Id[^36..]:t.Id)+"-"+due;if(State.Records.ContainsKey("task:"+id))return;var data=(JsonObject)t.Data.DeepClone();foreach(var k in new[]{"completedAt","myDay","source","sourceListId","raw","attachmentImport"})data.Remove(k);data["completed"]=false;data["due"]=due;data["createdAt"]=DateTimeOffset.UtcNow.ToString("O");data["seriesId"]=Str(t,"seriesId",t.Id);if(data["repeat"] is JsonObject rr&&rr["range"] is JsonObject rg&&rg["type"]?.ToString()=="numbered")rg["numberOfOccurrences"]=(rg["numberOfOccurrences"]?.GetValue<int>()??1)-1;if(DateTimeOffset.TryParse(Str(t,"reminder"),out var reminder))data["reminder"]=reminder.AddDays(next.Value.DayNumber-date.DayNumber).ToString("O");Edit("task",id,data);foreach(var s in All("step").Where(s=>Str(s,"taskId")==t.Id).ToList()){var sid=(id.Length>70?id[^70..]:id)+"-"+(s.Id.Length>36?s.Id[^36..]:s.Id);Edit("step",sid,new(){["taskId"]=id,["title"]=Str(s,"title"),["completed"]=false});}}
    public void DeleteTask(string id){foreach(var k in new[]{"step","attachment","link"})foreach(var r in All(k).Where(x=>Str(x,"taskId")==id).ToList())Edit(k,r.Id,new(),true);Edit("task",id,new(),true);}
    public void PutFile(string id,byte[] b){using var cmd=db.CreateCommand();cmd.CommandText="INSERT INTO files(k,b) VALUES($k,$b) ON CONFLICT(k) DO UPDATE SET b=excluded.b";cmd.Parameters.AddWithValue("$k",Workspace+":"+id);cmd.Parameters.AddWithValue("$b",b);cmd.ExecuteNonQuery();}
    public byte[]? File(string id){using var cmd=db.CreateCommand();cmd.CommandText="SELECT b FROM files WHERE k=$k";cmd.Parameters.AddWithValue("$k",Workspace+":"+id);return cmd.ExecuteScalar() as byte[];}
    private async Task<HttpResponseMessage> Request(Connection c,string path,HttpMethod method,HttpContent? content=null){using var req=new HttpRequestMessage(method,c.Endpoint.TrimEnd('/')+path);req.Headers.Authorization=new AuthenticationHeaderValue("Bearer",c.Key);req.Content=content;var r=await http.SendAsync(req);if(!r.IsSuccessStatusCode){var code=r.StatusCode;r.Dispose();throw new HttpRequestException("Server HTTP "+code);}return r;}
    public async Task Connect(string endpoint,string key){if(Busy)throw new InvalidOperationException("同步进行中");if(!Uri.TryCreate(endpoint,UriKind.Absolute,out var u)||(u.Scheme!="https"&&!u.IsLoopback))throw new ArgumentException("请输入 HTTPS 服务器地址");if(key.Length<43)throw new ArgumentException("工作区密钥不正确");var c=new Connection(endpoint,key);using var response=await Request(c,"/api/pull?cursor=0",HttpMethod.Get);var appearance=State;Save();Workspace=Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(key))).ToLowerInvariant();Cloud=c;State=Load(Workspace);AdoptAppearance(appearance);State.WelcomeSeen=true;Write("active",Workspace);Write("connection:"+Workspace,JsonSerializer.Serialize(c,Json));Save();}
    private void AdoptAppearance(State previous)
    {
        State.Theme=previous.Theme;State.AccentColor=previous.AccentColor;State.TextScale=previous.TextScale;State.AppearanceVersion=1;State.WelcomeSeen|=previous.WelcomeSeen;
    }
    public async Task ConnectAccount(string endpoint,AccountCredentials credentials)
    {
        if(Busy)throw new InvalidOperationException("同步进行中");
        if(!Uri.TryCreate(endpoint,UriKind.Absolute,out var uri)||(uri.Scheme!="https"&&!(uri.Scheme=="http"&&uri.IsLoopback)))throw new ArgumentException("请输入 HTTPS 账号服务地址");
        var connection=new Connection(uri.GetLeftPart(UriPartial.Authority),credentials.Token,credentials.Account.Id);
        using var check=await Request(connection,"/api/auth/me",HttpMethod.Get);
        var info=await check.Content.ReadFromJsonAsync<JsonObject>(Json);
        if(info?["account"]?["id"]?.ToString()!=credentials.Account.Id)throw new InvalidOperationException("账号身份不匹配");
        var appearance=State;Save();Workspace="account:"+Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(connection.Endpoint+"|"+credentials.Account.Id))).ToLowerInvariant();
        Cloud=connection;State=Load(Workspace);AdoptAppearance(appearance);State.WelcomeSeen=true;Write("active",Workspace);Write("connection:"+Workspace,JsonSerializer.Serialize(connection,Json));Save();
    }
    public void MergeLocalIntoAccount()
    {
        if(Busy||Cloud?.AccountId==null)throw new InvalidOperationException("请先登录账号并等待同步完成");
        foreach(var record in Load("local").Records.Values.Where(r=>!r.Deleted))
        {
            if(State.Records.ContainsKey(record.Kind+":"+record.Id))continue;
            if(record.Kind=="attachment")
            {
                using var cmd=db.CreateCommand();cmd.CommandText="SELECT b FROM files WHERE k=$k";cmd.Parameters.AddWithValue("$k","local:"+record.Id);
                if(cmd.ExecuteScalar() is not byte[] bytes)continue;PutFile(record.Id,bytes);
            }
            Edit(record.Kind,record.Id,(JsonObject)record.Data.DeepClone());
        }
    }
    public async Task SignOutAccount()
    {
        if(Busy)throw new InvalidOperationException("同步进行中");
        var current=Cloud;
        if(current?.AccountId!=null){try{using var response=await Request(current,"/api/auth/logout",HttpMethod.Post,JsonContent.Create(new{}));}catch(HttpRequestException){/* Always allow local sign-out when the session expired or the device is offline. */}Write("connection:"+Workspace,"null");}
        Disconnect();
    }
    public void Disconnect(){if(Busy)throw new InvalidOperationException("同步进行中");var appearance=State;Save();Workspace="local";Cloud=null;State=Load(Workspace);AdoptAppearance(appearance);Write("active",Workspace);Save();}
    public async Task Sync(){var c=Cloud;if(c==null||Busy)return;Busy=true;try{while(State.Pending.Count>0){var batch=State.Pending.Take(20).ToArray();foreach(var o in batch.Where(o=>o.Kind=="attachment"&&!o.Deleted)){var bytes=File(o.Id)??throw new IOException("附件不在本地");using var f=await Request(c,"/api/attachments/"+o.Id,HttpMethod.Put,new ByteArrayContent(bytes));}using var push=await Request(c,"/api/push",HttpMethod.Post,JsonContent.Create(new{ops=batch},options:Json));var ack=await push.Content.ReadFromJsonAsync<PushResponse>(Json)??throw new IOException("Invalid ACK");var ids=ack.Ack.ToHashSet();if(batch.Any(o=>!ids.Contains(o.OpId)))throw new IOException("Incomplete ACK");State.Pending.RemoveAll(o=>ids.Contains(o.OpId));Save();}PullResponse result;do{using var pull=await Request(c,"/api/pull?cursor="+State.Cursor,HttpMethod.Get);result=await pull.Content.ReadFromJsonAsync<PullResponse>(Json)??throw new IOException("Invalid response");foreach(var r in result.Records)State.Records[r.Kind+":"+r.Id]=r;foreach(var o in State.Pending)Apply(o);State.Cursor=result.Cursor;Save();}while(result.More);}finally{Busy=false;}}
    public async Task<byte[]> Download(string id){if(File(id) is byte[] b)return b;var cloud=Cloud??throw new IOException("附件未保存本地");var workspace=Workspace;using var r=await Request(cloud,"/api/attachments/"+id,HttpMethod.Get);b=await r.Content.ReadAsByteArrayAsync();if(Workspace!=workspace)throw new IOException("工作区已切换");PutFile(id,b);return b;}
    public void Dispose(){http.Dispose();db.Dispose();}
}
