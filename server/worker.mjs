import {accountRoutes,accountSession} from './accounts.mjs';
const json=(x,status=200)=>new Response(JSON.stringify(x),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const idOk=x=>typeof x==='string'&&/^[a-zA-Z0-9_.:-]{1,128}$/.test(x);
const kinds=new Set(['task','list','group','step','attachment','link']);
const schemas={task:['title','listId','sourceListId','notes','completed','completedAt','createdAt','due','reminder','repeat','important','myDay','position','source','raw','seriesId','attachmentImport'],list:['title','groupId','color','position','source','raw','sort','backgroundId','backgroundOpacity'],group:['title','position'],step:['taskId','title','completed','position','source','raw'],attachment:['taskId','name','type','size','source','raw'],link:['taskId','title','url','raw']};
const enc=new TextEncoder();
async function sha(s){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(s)))].map(x=>x.toString(16).padStart(2,'0')).join('');}
// Personal/workspace mode. Each independently generated 256-bit key owns its own namespace.
// Legacy workspace keys remain supported alongside account sessions.
async function authenticate(req,env){const account=await accountSession(req,env);if(account){if(!['GET','HEAD'].includes(req.method)&&!req.headers.has('authorization')&&req.headers.get('origin')!==new URL(req.url).origin)return null;return account.workspace;}const key=req.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43,128})$/)?.[1];if(!key||!env.WORKSPACE_KEYS)return null;const hash=await sha(key);const allowed=env.WORKSPACE_KEYS.split(',').map(x=>x.trim().toLowerCase());return allowed.includes(hash)?hash:null;}
function opValid(o){return o&&idOk(o.opId)&&idOk(o.id)&&kinds.has(o.kind)&&typeof o.deleted==='boolean'&&o.patch&&typeof o.patch==='object'&&!Array.isArray(o.patch)&&Object.keys(o.patch).every(k=>schemas[o.kind].includes(k))&&JSON.stringify(o.patch).length<=65000;}
function record(row){return {kind:row.kind,id:row.id,data:JSON.parse(row.data),deleted:!!row.deleted,version:row.version,seq:row.seq};}

const outlookMax=25*1024*1024;
const exchangeIdOk=v=>typeof v==='string'&&v.length>0&&v.length<=1024&&/^[-_A-Za-z0-9+/]+={0,2}$/.test(v);
const canonicalExchangeId=v=>typeof v==='string'?v.replaceAll('+','_').replaceAll('/','-'):'';
const substrateId=v=>v.replaceAll('_','+').replaceAll('-','/');
const loopbackOrigin=v=>typeof v==='string'&&/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(v);
async function upstreamFailure(stage,response,token=''){
 let code=null,message=`Microsoft 返回 HTTP ${response.status}`;
 try{const v=await response.clone().json();const e=v?.error||v?.Error||v;code=e?.code||e?.Code||null;message=String(e?.message||e?.Message||message);if(token)message=message.replaceAll(token,'[redacted]');message=message.slice(0,400);}catch{}
 return json({ok:false,stage,status:response.status,code,requestId:response.headers.get('request-id')||response.headers.get('x-ms-request-id')||null,message},response.status);
}
const substrateBase='https://substrate.office.com';
function attachmentDownloadUrl(link,taskId,attachmentId){try{if(typeof link!=='string'||!link)return null;const u=new URL(link,substrateBase),p=u.pathname.split('/');return u.origin===substrateBase&&!u.username&&!u.password&&!u.search&&!u.hash&&p.length===9&&p.slice(0,5).join('/')==='/todob2/api/v1/tasks'&&p[6]==='attachments'&&p[8]==='$value'&&canonicalExchangeId(decodeURIComponent(p[5]))===canonicalExchangeId(taskId)&&canonicalExchangeId(decodeURIComponent(p[7]))===canonicalExchangeId(attachmentId)?u:null;}catch{return null;}}
const linkedFiles=task=>(Array.isArray(task?.LinkedEntities)?task.LinkedEntities:[]).filter(x=>x?.EntityType==='file'&&x?.EntitySubType==='exchange-file-attachment'&&exchangeIdOk(x?.Id));
function manifestFor(taskId,files,includeLinks=false){return {ok:true,taskId:canonicalExchangeId(taskId),attachmentCount:files.length,attachments:files.map((x,index)=>({index,id:canonicalExchangeId(x.Id),name:typeof x.DisplayName==='string'&&x.DisplayName.length<=512?x.DisplayName:'Outlook 附件',type:typeof x.Preview?.ContentType==='string'?x.Preview.ContentType:null,expectedSize:Number.isSafeInteger(x.Preview?.Size)?x.Preview.Size:null,...(includeLinks?{webLink:attachmentDownloadUrl(x.WebLink,taskId,x.Id)?.pathname||null}:{})}))};}
// A full initial To Do sync can return DeltaLink before historical pages become visible.
// Follow the initial delta continuation, then NextLink pages, until an empty/terminal delta.
// Each folder is scanned once for all requested IDs; never follow a cross-origin link.
async function scanOutlookFolder(token,folderId,taskIds){
 const base=substrateBase,headers={Authorization:'Bearer '+token,Accept:'application/json'};
 const wanted=new Set(taskIds.map(canonicalExchangeId)),matches=new Map();let pages=0,rowsRead=0,lastStatus=404,seenPayload=false,deltaPages=0;
 const allowedPage=(url,current)=>{try{const u=new URL(url,current);const p=u.pathname.split('/');return u.origin===base&&!u.username&&!u.password&&!u.hash&&p.length===7&&p.slice(0,5).join('/')==='/todob2/api/v1/taskfolders'&&p[6]==='tasks'&&canonicalExchangeId(decodeURIComponent(p[5]))===canonicalExchangeId(folderId)?u:null;}catch{return null;}};
 for(const folder of [...new Set([substrateId(folderId),folderId])]){
  const first=new URL(base+'/todob2/api/v1/taskfolders/'+encodeURIComponent(folder)+'/tasks');first.searchParams.set('$expand','LinkedEntity');first.searchParams.set('$select','*,AllExtensions/com_microsoft_uno_richplannertask');first.searchParams.set('maxpagesize','50');
  let next=first,seen=new Set(),isDelta=false,deltaRound=0,formRows=0;
  while(next){
   if(seen.has(next.href)||pages>=40)return {error:json({ok:false,stage:'Substrate 任务分页',message:'分页重复或超过单次扫描 40 页上限',pages,rowsRead},502)};
   const current=next;seen.add(current.href);pages++;if(isDelta)deltaPages++;
   let response;try{response=await fetch(current.href,{headers,redirect:'manual'});}catch{return {error:json({ok:false,stage:'Substrate 任务列表',message:'网络请求失败'},502)};}
   lastStatus=response.status;
   if(response.status>=300&&response.status<400)return {error:json({ok:false,stage:'Substrate 任务列表',status:response.status,message:'接口返回重定向，本次未跟随'},502)};
   if(!response.ok){if(seen.size===1&&[400,404].includes(response.status))break;return {error:await upstreamFailure('Substrate 任务列表',response,token)};}
   let payload;try{payload=await response.json();}catch{return {error:json({ok:false,stage:'Substrate 任务列表',message:'响应不是有效 JSON'},502)};}
   const rows=Array.isArray(payload?.Value)?payload.Value:Array.isArray(payload?.value)?payload.value:null;
   if(!rows)return {error:json({ok:false,stage:'Substrate 任务列表',message:'响应中没有 Value 任务数组'},502)};
   seenPayload=true;rowsRead+=rows.length;formRows+=rows.length;
   for(const row of rows){const id=canonicalExchangeId(row?.Id||row?.id);if(wanted.has(id)){const files=linkedFiles(row);if(!matches.has(id)||files.length)matches.set(id,row);}}
   if([...wanted].every(id=>linkedFiles(matches.get(id)).length))break;
   const continuation=payload.NextLink||payload['@odata.nextLink'];const delta=payload.DeltaLink||payload['@odata.deltaLink'];
   // Follow the initial DeltaLink once, then all NextLink pages. The terminal DeltaLink is a sync checkpoint, not another page.
   const followDelta=!continuation&&delta&&deltaRound===0;
   const link=continuation||(followDelta?delta:null);next=link?allowedPage(link,current.href):null;
   if(link&&!next)return {error:json({ok:false,stage:'Substrate 任务分页',message:'分页链接不是同一微软清单接口，已停止'},502)};
   if(followDelta){deltaRound++;isDelta=true;if(seen.has(next.href))next=null;}else if(continuation){isDelta=false;}
  }
  if(formRows>0||[...wanted].every(id=>matches.has(id)))break;
 }
 return {matches,pages,rowsRead,deltaPages,lastStatus,seenPayload};
}
async function outlookAttachmentProbe(req){
 let body;try{const raw=await req.text();if(raw.length>240000)return json({ok:false,stage:'请求校验',message:'请求体过大'},413);body=JSON.parse(raw);}catch{return json({ok:false,stage:'请求校验',message:'JSON 格式无效'},400);}
 const token=body?.accessToken,folderId=body?.folderId,taskId=body?.taskId,metadataOnly=body?.metadataOnly===true,attachmentId=body?.attachmentId;
 if(typeof token!=='string'||token.length<100||token.length>16000||/\s/.test(token))return json({ok:false,stage:'请求校验',message:'Outlook access token 缺失或格式无效'},400);
 if(!exchangeIdOk(folderId))return json({ok:false,stage:'请求校验',message:'清单标识无效'},400);
 const base=substrateBase;
 if(body.mode==='manifest-index'){
  const ids=body.taskIds;if(!Array.isArray(ids)||!ids.length||ids.length>200||!ids.every(exchangeIdOk))return json({ok:false,stage:'请求校验',message:'任务索引参数无效'},400);
  const scan=await scanOutlookFolder(token,folderId,ids);if(scan.error)return scan.error;
  const manifests=[];for(const [id,task] of scan.matches){const files=linkedFiles(task);if(files.length&&files.length<=200)manifests.push(manifestFor(id,files,true));}
  return json({ok:true,folderId,manifests,pages:scan.pages,rowsRead:scan.rowsRead,deltaPages:scan.deltaPages,unmatched:ids.map(canonicalExchangeId).filter(id=>!manifests.some(m=>m.taskId===id))});
 }
 if(!exchangeIdOk(taskId))return json({ok:false,stage:'请求校验',message:'任务标识无效'},400);
 if(attachmentId!==undefined&&!exchangeIdOk(attachmentId))return json({ok:false,stage:'请求校验',message:'附件标识无效'},400);
 let files,a,attachmentCount,attachmentIndex;
 if(body.mode==='download-indexed'){
  // The descriptor comes from the folder index, but is untrusted input. The same-origin,
  // exact task/attachment path is checked below; Microsoft still authorizes every GET.
  const f=body.file;if(!f||!exchangeIdOk(f.id)||canonicalExchangeId(f.id)!==canonicalExchangeId(attachmentId)||!Number.isSafeInteger(f.index)||!Number.isSafeInteger(body.attachmentCount)||body.attachmentCount<1||body.attachmentCount>200||f.index<0||f.index>=body.attachmentCount)return json({ok:false,stage:'请求校验',message:'附件索引参数无效'},400);
  a={Id:f.id,WebLink:f.webLink,DisplayName:f.name,Preview:{Size:f.expectedSize,ContentType:f.type}};attachmentCount=body.attachmentCount;attachmentIndex=f.index;
 }else{
  const scan=await scanOutlookFolder(token,folderId,[taskId]);if(scan.error)return scan.error;
  const task=scan.matches.get(canonicalExchangeId(taskId));
  if(!task)return json({ok:false,stage:'Substrate 任务匹配',status:scan.lastStatus,message:scan.seenPayload?`已读取 ${scan.pages} 页 / ${scan.rowsRead} 条任务（Delta ${scan.deltaPages} 页），但没有匹配到目标任务`:'两种清单 ID 编码均未能读取任务列表'},404);
  files=linkedFiles(task);
  if(!files.length)return json({ok:false,stage:'附件元数据',status:404,message:'Substrate 找到了任务，但 LinkedEntities 中没有 exchange-file-attachment'},404);
  if(files.length>200)return json({ok:false,stage:'附件元数据',status:413,message:'单个任务附件数量超过 200 个安全上限'},413);
  if(metadataOnly)return json(manifestFor(taskId,files));
  a=attachmentId?files.find(x=>canonicalExchangeId(x.Id)===canonicalExchangeId(attachmentId)):files[Number.isSafeInteger(body?.attachmentIndex)?body.attachmentIndex:0];
  if(!a)return json({ok:false,stage:'附件选择',status:404,message:attachmentId?'未找到指定的 Outlook 附件':'附件序号超出范围',attachmentCount:files.length},404);
  attachmentCount=files.length;attachmentIndex=files.indexOf(a);
 }
 const name=typeof a.DisplayName==='string'&&a.DisplayName.length<=512?a.DisplayName:'Outlook 附件';
 const expected=Number.isSafeInteger(a.Preview?.Size)?a.Preview.Size:null;
 // Preview.Size describes Outlook's preview metadata. Enforce the 25 MiB limit on downloaded bytes below, not on this hint.
 // In batch mode the manifest descriptor comes back from the client. Revalidate the exact
 // same-origin task/attachment path on every request; Microsoft authorizes the actual GET.
 // Never synthesize Outlook session/CSRF parameters or forward the bearer to another host.
 const downloadUrl=attachmentDownloadUrl(a.WebLink,taskId,a.Id);
 if(!downloadUrl)return json({ok:false,stage:'附件下载地址',message:'微软未返回可验证的同源附件 WebLink，未尝试下载'},502);
 let fileResponse;try{fileResponse=await fetch(downloadUrl.href,{headers:{Authorization:'Bearer '+token,Accept:'*/*'},redirect:'manual'});}catch{return json({ok:false,stage:'Substrate 原始附件',message:'下载请求失败',attachmentName:name},502);}
 if(fileResponse.status>=300&&fileResponse.status<400){let host=null;try{host=new URL(fileResponse.headers.get('location')||'',base).host||null;}catch{}return json({ok:false,stage:'Substrate 原始附件',upstreamStatus:fileResponse.status,redirectHost:host,message:'下载接口返回重定向；本次未自动跟随'},502);}
 if(!fileResponse.ok){const failure=await upstreamFailure('Substrate 原始附件',fileResponse,token);const detail=await failure.json();return json({...detail,attachmentName:name,expectedSize:expected},fileResponse.status);}
 if(fileResponse.status!==200||fileResponse.headers.has('content-range'))return json({ok:false,stage:'传输完整性校验',status:502,upstreamStatus:fileResponse.status,message:'附件接口未返回完整 HTTP 200 响应'},502);
 const type=(fileResponse.headers.get('content-type')||a.Preview?.ContentType||'application/octet-stream').split(';')[0].slice(0,128);
 let bytes;try{bytes=await fileResponse.arrayBuffer();}catch{return json({ok:false,stage:'传输完整性校验',status:502,upstreamStatus:fileResponse.status,message:'读取附件响应体失败，可能是连接中断或响应被截断',attachmentName:name,expectedSize:expected,upstreamContentLength:fileResponse.headers.get('content-length')||null,upstreamContentType:fileResponse.headers.get('content-type')||null,requestId:fileResponse.headers.get('request-id')||fileResponse.headers.get('x-ms-request-id')||null},502);}
 if(bytes.byteLength>outlookMax)return json({ok:false,stage:'文件校验',status:413,message:'下载文件超过 25 MiB 测试上限',attachmentName:name,actualSize:bytes.byteLength},413);
 const upstreamLengthRaw=fileResponse.headers.get('content-length');
 const upstreamLength=upstreamLengthRaw&&/^\d+$/.test(upstreamLengthRaw)?Number(upstreamLengthRaw):null;
 const encoding=(fileResponse.headers.get('content-encoding')||'').slice(0,80);
 const upstreamType=(fileResponse.headers.get('content-type')||'').slice(0,160);
 const disposition=(fileResponse.headers.get('content-disposition')||'').slice(0,320);
 const requestId=fileResponse.headers.get('request-id')||fileResponse.headers.get('x-ms-request-id')||fileResponse.headers.get('client-request-id')||null;
 const signature=[...new Uint8Array(bytes.slice(0,16))].map(x=>x.toString(16).padStart(2,'0')).join(' ');
 const prefix=new TextDecoder().decode(bytes.slice(0,512)).trimStart().toLowerCase();
 // Accept legitimate HTML/JSON attachments, regardless of filename. Reject probable service/login responses only when there is no attachment disposition and no matching MIME metadata.
 const declaredMime=String(a.Preview?.ContentType||'').split(';')[0].trim().toLowerCase();
 const responseMime=type.toLowerCase();const declaredFile=/^attachment(?:\s*;|\s*$)/i.test(disposition);
 const html=responseMime==='text/html'||prefix.startsWith('<!doctype html')||prefix.startsWith('<html');
 const jsonBody=responseMime==='application/json'||responseMime==='text/json'||/^\s*\{\s*"(?:error|code)"/i.test(prefix);
 const expectedHtml=declaredMime==='text/html'||declaredMime==='application/xhtml+xml';
 const expectedJson=declaredMime==='application/json'||declaredMime==='text/json'||declaredMime.endsWith('+json');
 if(!declaredFile&&((html&&!expectedHtml)||(jsonBody&&!expectedJson)))return json({ok:false,stage:'文件内容校验',status:502,upstreamStatus:fileResponse.status,message:'收到疑似 HTML/JSON 服务响应，且无附件响应标记或匹配的 MIME 元数据',attachmentName:name,expectedSize:expected,actualSize:bytes.byteLength,upstreamContentType:upstreamType,signatureHex:signature,requestId},502);
 if(bytes.byteLength===0&&!declaredFile&&expected!==0)return json({ok:false,stage:'传输完整性校验',status:502,upstreamStatus:fileResponse.status,message:'空响应缺少有效附件标记'},502);
 // A mismatching Content-Length (without content-encoding) means the transport itself may be incomplete.
 if(upstreamLength!==null&&(!encoding||encoding.toLowerCase()==='identity')&&upstreamLength!==bytes.byteLength)return json({ok:false,stage:'传输完整性校验',status:502,upstreamStatus:fileResponse.status,message:'HTTP Content-Length 与实际接收字节数不一致，疑似传输不完整，拒绝保存',attachmentName:name,expectedSize:expected,actualSize:bytes.byteLength,upstreamContentLength:upstreamLength,upstreamContentType:upstreamType,upstreamContentDisposition:disposition,upstreamContentEncoding:encoding,signatureHex:signature,requestId},502);
 // Preview.Size is preview metadata, not a reliable authoritative size for the original attachment.
 // A mismatch is recorded as a warning; only transport truncation above is a hard failure.
 const sizeMismatch=expected!==null&&bytes.byteLength!==expected;
 return new Response(bytes,{status:200,headers:{
  'Content-Type':'application/octet-stream','Content-Disposition':'attachment','Content-Length':String(bytes.byteLength),'Cache-Control':'no-store',
  'X-Content-Type-Options':'nosniff','X-HelloTodo-Stage':'downloaded',
  'X-HelloTodo-Attachment-Id':encodeURIComponent(canonicalExchangeId(a.Id)),'X-HelloTodo-Attachment-Name':encodeURIComponent(name),
  'X-HelloTodo-Attachment-Type':encodeURIComponent(type),'X-HelloTodo-Attachment-Size':String(bytes.byteLength),
  'X-HelloTodo-Attachment-Count':String(attachmentCount),'X-HelloTodo-Attachment-Index':String(attachmentIndex),'X-HelloTodo-Size-Mismatch':String(sizeMismatch),
  'X-HelloTodo-Expected-Size':expected===null?'':String(expected),'X-HelloTodo-Size-Status':expected===null?'unknown':sizeMismatch?'metadata-differs':'match','X-HelloTodo-Upstream-Content-Length':upstreamLength===null?'':String(upstreamLength),
  'X-HelloTodo-Upstream-Content-Encoding':encodeURIComponent(encoding),'X-HelloTodo-Upstream-Content-Type':encodeURIComponent(upstreamType),
  'X-HelloTodo-Upstream-Content-Disposition':encodeURIComponent(disposition),'X-HelloTodo-Upstream-Request-Id':encodeURIComponent(requestId||''),
  'X-HelloTodo-File-Signature':encodeURIComponent(signature)
 }});
}

export default {async fetch(req,env){try{
 const u=new URL(req.url),p=u.pathname;
 if(!p.startsWith('/api/'))return env.ASSETS?env.ASSETS.fetch(req):json({error:'Not found'},404);
 if(p.startsWith('/api/auth/'))return await accountRoutes(req,env);
 if(p==='/api/health'&&req.method==='GET')return json({ok:true,protocol:1});
 if(p==='/api/outlook/attachment-probe'&&req.method==='POST'){
  const user=await authenticate(req,env),origin=req.headers.get('Origin');
  const localAllowed=env.LOCAL_OUTLOOK_PROBE===true&&loopbackOrigin(origin);
  if(!user&&!localAllowed)return json({error:'Unauthorized'},401);
  return await outlookAttachmentProbe(req);
 }
 const user=await authenticate(req,env);if(!user)return json({error:'Unauthorized'},401);
 if(p==='/api/push'&&req.method==='POST'){
   const raw=await req.text();if(raw.length>1800000)return json({error:'Batch too large'},413);
   let body;try{body=JSON.parse(raw)}catch{return json({error:'Invalid JSON'},400)}
   const ops=body.ops;if(!Array.isArray(ops)||ops.length>40||!ops.every(opValid))return json({error:'Invalid operations'},400);
   if(ops.length)await env.DB.batch(ops.map(o=>env.DB.prepare('INSERT INTO changes(user_id,op_id,kind,id,patch,deleted) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,op_id) DO NOTHING').bind(user,o.opId,o.kind,o.id,JSON.stringify(o.patch),o.deleted?1:0)));
   return json({ack:ops.map(o=>o.opId)});
 }
 if(p==='/api/pull'&&req.method==='GET'){
   const cursor=Number(u.searchParams.get('cursor')??0);if(!Number.isSafeInteger(cursor)||cursor<0)return json({error:'Invalid cursor'},400);
   const q=await env.DB.prepare('SELECT kind,id,data,deleted,version,seq FROM records WHERE user_id=? AND seq>? ORDER BY seq LIMIT 201').bind(user,cursor).all();
   const rows=q.results.slice(0,200);return json({records:rows.map(record),cursor:rows.at(-1)?.seq??cursor,more:q.results.length>200});
 }
 const match=p.match(/^\/api\/attachments\/([a-zA-Z0-9_.:-]{1,128})$/);
 if(match){if(!env.FILES)return json({error:'R2 not configured'},503);const key=user+'/'+match[1];
   if(req.method==='PUT'){const data=await req.arrayBuffer();if(data.byteLength>25*1024*1024)return json({error:'Max 25 MiB'},413);await env.FILES.put(key,data,{httpMetadata:{contentType:'application/octet-stream'}});return json({ok:true});}
   if(req.method==='GET'){const obj=await env.FILES.get(key);if(!obj)return json({error:'Not found'},404);return new Response(obj.body,{headers:{'Content-Type':'application/octet-stream','Content-Disposition':'attachment','X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'}});}
   if(req.method==='DELETE'){await env.FILES.delete(key);return json({ok:true});}
 }
 return json({error:'Not found'},404);
 }catch(e){console.error('API failure',e?.message);return json({error:'Service unavailable; retry later'},503)}}};
