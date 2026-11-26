import {uuid,edit,all,get,now,attachmentStatus,attachmentIndex,markAttachmentImport} from './core.mjs';
const enc=new TextEncoder(),b64url=a=>btoa(String.fromCharCode(...a)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
export const GRAPH_TASKS_SCOPE='https://graph.microsoft.com/Tasks.Read';
export const GRAPH_USER_SCOPE='https://graph.microsoft.com/User.Read';
export function graphScopesForMode(_mode){return GRAPH_TASKS_SCOPE;}
export const OUTLOOK_TASKS_SCOPE='https://outlook.office.com/Tasks.Read';
const OFFLINE_SCOPE='offline_access';
const TOKEN_ENDPOINT='https://login.microsoftonline.com/common/oauth2/v2.0/token';
const TOKEN_PREFIX='hellotodo.microsoft.token.v1.';
const memoryTokens=new Map(),refreshFlights=new Map();
const canonicalExchangeId=v=>typeof v==='string'?v.replaceAll('+','_').replaceAll('/','-'):'';
export function validateClientId(value){const id=typeof value==='string'?value.trim():'';if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)||id==='00000000-0000-0000-0000-000000000000')throw Error('HelloTodo 发布者尚未配置 Microsoft 登录，请联系开发者。');return id;}
export async function configuredClientId(request=fetch){const r=await request(new URL('./microsoft-config.json',import.meta.url),{cache:'no-store'});if(!r.ok)throw Error('无法读取 Microsoft 登录配置');return validateClientId((await r.json()).clientId);}
function tokenKey(resource,clientId){return TOKEN_PREFIX+resource+'.'+clientId.toLowerCase();}
function getStorage(){try{return globalThis.localStorage||null;}catch{return null;}}
function readToken(resource,clientId){const key=tokenKey(resource,clientId);try{const raw=getStorage()?.getItem(key);if(raw){const value=JSON.parse(raw);if(value&&value.clientId===clientId&&typeof value==='object')return value;}}catch{}return memoryTokens.get(key)||null;}
function writeToken(resource,clientId,response,previous=null){const key=tokenKey(resource,clientId),expires=Number(response.expires_in);const value={clientId,access_token:response.access_token,refresh_token:response.refresh_token||previous?.refresh_token||null,expires_at:Date.now()+(Number.isFinite(expires)&&expires>0?expires:3600)*1000,scope:response.scope||previous?.scope||null,token_type:response.token_type||'Bearer'};memoryTokens.set(key,value);try{getStorage()?.setItem(key,JSON.stringify(value));}catch{}return value;}
function clearToken(resource,clientId){const key=tokenKey(resource,clientId);memoryTokens.delete(key);try{getStorage()?.removeItem(key);}catch{}}
async function cachedToken(resource,scope){const clientId=await configuredClientId(),cached=readToken(resource,clientId);if(!cached)return null;const now=Date.now();if(cached.access_token&&Number(cached.expires_at)>now+90_000)return cached.access_token;if(!cached.refresh_token){if(cached.access_token&&Number(cached.expires_at)>now+10_000)return cached.access_token;clearToken(resource,clientId);return null;}const key=tokenKey(resource,clientId);if(refreshFlights.has(key))return refreshFlights.get(key);const flight=(async()=>{try{const r=await fetch(TOKEN_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:clientId,grant_type:'refresh_token',refresh_token:cached.refresh_token,scope:scope+' '+OFFLINE_SCOPE})});let value={};try{value=await r.json();}catch{}if(!r.ok||!value.access_token){if(['invalid_grant','interaction_required','invalid_request'].includes(value.error)){clearToken(resource,clientId);return null;}if(cached.access_token&&Number(cached.expires_at)>Date.now()+10_000)return cached.access_token;throw Error(value.error_description||'Microsoft 静默续期失败');}return writeToken(resource,clientId,value,cached).access_token;}catch(e){if(cached.access_token&&Number(cached.expires_at)>Date.now()+10_000)return cached.access_token;throw Error('无法静默续期 Microsoft 登录：'+String(e?.message||e));}finally{refreshFlights.delete(key);}})();refreshFlights.set(key,flight);return flight;}
export function getCachedGraphToken(mode='full'){return cachedToken('graph',graphScopesForMode(mode));}
export function getCachedOutlookToken(){return cachedToken('outlook',OUTLOOK_TASKS_SCOPE);}
export function clearMicrosoftTokenCache(){for(const resource of ['graph','outlook']){for(const key of [...memoryTokens.keys()])if(key.startsWith(TOKEN_PREFIX+resource+'.'))memoryTokens.delete(key);try{const storage=getStorage();if(storage)for(let i=storage.length-1;i>=0;i--){const key=storage.key(i);if(key?.startsWith(TOKEN_PREFIX+resource+'.'))storage.removeItem(key);}}catch{}}}
async function exchangeAuthorizationCode(resource,scope,sessionKey){const q=new URLSearchParams(location.search),s=JSON.parse(sessionStorage.getItem(sessionKey)||'null');if(!q.has('code')&&!q.has('error'))return null;if(!s)return null;sessionStorage.removeItem(sessionKey);history.replaceState(null,'',location.pathname);if(q.get('state')!==s.state)throw Error('Microsoft 登录状态校验失败');if(q.has('error'))throw Error(q.get('error')==='access_denied'?'用户取消登录或拒绝授权':q.get('error_description')||q.get('error'));const requestedScope=scope+' '+OFFLINE_SCOPE;const r=await fetch(TOKEN_ENDPOINT,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:s.clientId,grant_type:'authorization_code',code:q.get('code'),redirect_uri:s.redirect,code_verifier:s.verifier,scope:requestedScope})});const v=await r.json();if(!r.ok||!v.access_token)throw Error(v.error_description||'Microsoft 授权失败');writeToken(resource,s.clientId,v);return v.access_token;}
function createAuthorizationUrl(clientId,scope,redirect){const verifier=b64url(crypto.getRandomValues(new Uint8Array(48))),state=uuid();return crypto.subtle.digest('SHA-256',enc.encode(verifier)).then(digest=>({verifier,state,challenge:b64url(new Uint8Array(digest)),url:null})).then(x=>{const params=new URLSearchParams({client_id:clientId,response_type:'code',redirect_uri:redirect,scope:scope+' '+OFFLINE_SCOPE,code_challenge:x.challenge,code_challenge_method:'S256',state,response_mode:'query'});x.url='https://login.microsoftonline.com/common/oauth2/v2.0/authorize?'+params;return x;});}
export async function signIn(mode='full'){sessionStorage.removeItem('graph.importMode');sessionStorage.removeItem('outlook.pkce');sessionStorage.removeItem('outlook.probe.target');sessionStorage.removeItem('outlook.action');const clientId=await configuredClientId(),redirect=location.origin+'/index.html',auth=await createAuthorizationUrl(clientId,graphScopesForMode(mode),redirect);sessionStorage.setItem('graph.pkce',JSON.stringify({verifier:auth.verifier,state:auth.state,clientId,redirect,mode}));location.href=auth.url;}
export async function signInOutlook(action='probe-single'){sessionStorage.removeItem('graph.pkce');sessionStorage.removeItem('graph.importMode');const clientId=await configuredClientId(),redirect=location.origin+'/index.html',auth=await createAuthorizationUrl(clientId,OUTLOOK_TASKS_SCOPE,redirect);sessionStorage.setItem('outlook.pkce',JSON.stringify({verifier:auth.verifier,state:auth.state,clientId,redirect,action}));sessionStorage.setItem('outlook.action',action);location.href=auth.url;}
export async function outlookCallback(){const token=await exchangeAuthorizationCode('outlook',OUTLOOK_TASKS_SCOPE,'outlook.pkce');return token;}
export function localOutlookProbeTarget(state,localTaskId){const local=get(state,'task',localTaskId),data=local?.data;if(!data?.source)return null;const folderId=data.sourceListId||get(state,'list',data.listId)?.data?.source;if(!folderId)return null;return {folderId,taskId:data.source,localTaskId,taskTitle:data.title||'未命名任务'};}
export async function resolveOutlookProbeTarget(state,token,localTaskId,request=graphFetch){const local=get(state,'task',localTaskId);if(!local?.data?.source)throw Error('所选任务没有 Microsoft 原始任务 ID，请先重新导入该任务');const lists=await pages(token,'me/todo/lists',request);const preferred=local.data.sourceListId||get(state,'list',local.data.listId)?.data?.source||null;const ordered=[...lists].sort((a,b)=>Number(b.id===preferred)-Number(a.id===preferred)||Number(b.wellknownListName==='defaultList')-Number(a.wellknownListName==='defaultList'));for(const list of ordered){if(preferred&&list.id!==preferred&&ordered.some(x=>x.id===preferred))continue;const tasks=await pages(token,'me/todo/lists/'+encodeURIComponent(list.id)+'/tasks',request);const found=tasks.find(x=>canonicalExchangeId(x.id)===canonicalExchangeId(local.data.source));if(found)return {folderId:list.id,taskId:local.data.source,localTaskId,taskTitle:local.data.title||found.title||'未命名任务'};}throw Error('在 Microsoft To Do 清单中找不到所选任务。请确认登录的是导入任务时使用的微软账户。');}
export async function callback(){const s=JSON.parse(sessionStorage.getItem('graph.pkce')||'null');if(!s)return null;const token=await exchangeAuthorizationCode('graph',graphScopesForMode(s.mode),'graph.pkce');if(token&&s.mode&&s.mode!=='full')sessionStorage.setItem('graph.importMode',s.mode);return token;}
export function retryDelay(value,attempt=0){if(value!=null&&value.trim()!==''&&Number.isFinite(Number(value)))return Math.max(0,Number(value))*1000;const d=Date.parse(value);return Number.isFinite(d)?Math.max(0,d-Date.now()):1000*2**attempt;}
export async function graphFetch(token,path){let u=new URL(path,'https://graph.microsoft.com/v1.0/');if(u.origin!=='https://graph.microsoft.com'||!u.pathname.startsWith('/v1.0/')&&!u.pathname.startsWith('/beta/me/todo/'))throw Error('Invalid Graph URL');for(let i=0;i<4;i++){const r=await fetch(u,{headers:{Authorization:'Bearer '+token}});if([429,503,504].includes(r.status)&&i<3){await new Promise(x=>setTimeout(x,retryDelay(r.headers.get('Retry-After'),i)));continue;}if(!r.ok){let v={};try{v=(await r.json()).error||{};}catch{}const e=new Error(`Graph ${r.status}${v.code?' '+v.code:''}${v.message?': '+String(v.message).slice(0,300):''}`);Object.assign(e,{status:r.status,code:v.code||null,requestId:r.headers.get('request-id')||v.innerError?.['request-id']||null});throw e;}return r;}throw Error('Graph unavailable');}
export async function pages(token,path,request=graphFetch){let next=path,out=[];while(next){const r=await request(token,next),v=await r.json();out.push(...(v.value||[]));next=v['@odata.nextLink'];}return out;}
const sourceId=async(prefix,s)=>prefix+'-'+[...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(s)))].map(b=>b.toString(16).padStart(2,'0')).join('');
const date=x=>x?.dateTime?.slice(0,10)||null;
// Preserve the original dateTimeTimeZone object in raw; non-UTC reminder is interpreted only when browser supports its zone.
export function graphInstant(x){if(!x?.dateTime)return null;const dt=x.dateTime;if(/Z$|[+-]\d\d:\d\d$/.test(dt))return new Date(dt).toISOString();const zone=x.timeZone||'UTC',zones={'China Standard Time':'Asia/Shanghai','Tokyo Standard Time':'Asia/Tokyo','Pacific Standard Time':'America/Los_Angeles','Eastern Standard Time':'America/New_York','GMT Standard Time':'Europe/London','W. Europe Standard Time':'Europe/Berlin'};try{const target=new Date(dt+'Z').valueOf();let candidate=target;for(let i=0;i<3;i++){const parts=new Intl.DateTimeFormat('en-CA',{timeZone:zones[zone]||zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(new Date(candidate));const p=Object.fromEntries(parts.map(p=>[p.type,p.value]));const guess=Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second);candidate+=Math.floor(target/1000)*1000-guess;}return new Date(candidate).toISOString();}catch{return null;}}
const MAX_ATTACHMENT=25*1024*1024;
function errorInfo(e){return {status:e.status||null,code:e.code||null,requestId:e.requestId||null,message:String(e.message||e).slice(0,500)};}
async function attachmentBlob(token,tp,a,request){
 const base=tp+'/attachments/'+encodeURIComponent(a.id);
 const decode=(v)=>new Blob([Uint8Array.from(atob(v.contentBytes),c=>c.charCodeAt(0))],{type:v.contentType||a.contentType||'application/octet-stream'});
 const check=b=>{if(b.size>MAX_ATTACHMENT)throw Error('附件超过 25 MiB');if(Number.isInteger(a.size)&&a.size>=0&&b.size!==a.size)throw Error(`附件长度不匹配：预期 ${a.size}，实际 ${b.size}`);return b;};
 if(Number.isInteger(a.size)&&a.size>MAX_ATTACHMENT)throw Error('附件超过 25 MiB');
 if(typeof a.contentBytes==='string')return check(decode(a));
 try{const r=await request(token,base+'/$value');const b=await r.blob();return check(a.contentType?new Blob([b],{type:a.contentType}):b);}
 catch(rawError){try{const detail=await (await request(token,base)).json();if(typeof detail.contentBytes!=='string')throw Error('附件详情没有 contentBytes');return check(decode(detail));}catch(detailError){const e=new Error('原始文件：'+rawError.message+'；附件详情：'+detailError.message);Object.assign(e,{status:detailError.status||rawError.status,code:detailError.code||rawError.code,requestId:detailError.requestId||rawError.requestId});throw e;}}
}
export async function importGraph(state,token,{storeFile,loadFile,save,progress=()=>{},request=graphFetch,mode='full',concurrency=6}){
 const counts={lists:0,listsScanned:0,tasks:0,tasksScanned:0,steps:0,attachments:0,attachmentSkipped:0,attachmentTasksFailed:0,attachmentFilesFailed:0,links:0,skipped:0,errors:[],attachmentErrors:[]};
 const pending=state.settings.msAttachmentPending??={};
 const initialAttachmentIndex=attachmentIndex(state);const jobs=[];counts.phase='tasks';counts.detailsDone=0;
 const report=(t,id,stage,e,a)=>{const info={taskId:id,taskTitle:t.title||'未命名任务',stage,attachmentName:a?.name||null,...errorInfo(e)};counts.attachmentErrors.push(info);return info;};
 const lists=await pages(token,'me/todo/lists',request);
 for(const l of lists){
  const lp='me/todo/lists/'+encodeURIComponent(l.id),lid=l.wellknownListName==='defaultList'?'inbox':await sourceId('mslist',l.id);
  counts.listsScanned++;
  if(state.records['list:'+lid]?.deleted)continue;
  if(mode==='full'&&lid!=='inbox'&&!get(state,'list',lid)){edit(state,'list',lid,{title:l.displayName||'未命名清单',source:l.id,position:Date.now(),raw:l});counts.lists++;}
  let ts;try{ts=await pages(token,lp+'/tasks',request);}catch(e){counts.errors.push(`${l.displayName||'清单'} / tasks: ${e.message}`);await save();progress(counts);continue;}
  for(const t of ts){
   const tp=lp+'/tasks/'+encodeURIComponent(t.id),id=await sourceId('mstask',l.id+'/'+t.id);counts.tasksScanned++;
   if(state.records['task:'+id]?.deleted){counts.skipped++;delete pending[id];continue;}
   if(mode!=='full'&&(!get(state,'task',id)||!attachmentStatus(state,get(state,'task',id),initialAttachmentIndex).pending))continue;
   if(!get(state,'task',id)){edit(state,'task',id,{title:t.title||'未命名任务',listId:lid,sourceListId:l.id,notes:t.body?.content||'',completed:t.status==='completed',completedAt:graphInstant(t.completedDateTime),createdAt:t.createdDateTime||now(),due:date(t.dueDateTime),reminder:t.isReminderOn?graphInstant(t.reminderDateTime):null,repeat:t.recurrence||null,important:t.importance==='high',position:Date.parse(t.createdDateTime)||Date.now(),source:t.id,raw:t});counts.tasks++;}else{if(!get(state,'task',id).data.sourceListId)edit(state,'task',id,{sourceListId:l.id});counts.skipped++;}
   jobs.push({t,tp,id});
  }
  await save();progress(counts);
 }
 counts.phase='details';progress(counts);
 async function enrich({t,tp,id}){
   if(!get(state,'task',id))return;
   if(mode==='full')for(const [endpoint,kind] of [['checklistItems','step'],['linkedResources','link']]){try{const items=Array.isArray(t[endpoint])?[...t[endpoint],...(t[endpoint+'@odata.nextLink']?await pages(token,t[endpoint+'@odata.nextLink'],request):[])]:await pages(token,tp+'/'+endpoint,request);for(const a of items){const aid=await sourceId('ms'+kind,id+'/'+a.id);if(state.records[kind+':'+aid])continue;if(kind==='step'){edit(state,kind,aid,{taskId:id,title:a.displayName,completed:!!a.isChecked,position:Date.now(),source:a.id,raw:a});counts.steps++;}else{edit(state,kind,aid,{taskId:id,title:a.displayName||a.applicationName||'链接',url:a.webUrl||'',raw:a});counts.links++;}}}catch(e){counts.errors.push(`${t.title} / ${endpoint}: ${e.message}`);}}
   const failures=[];
   const attachmentRequest=mode==='attachments-beta'?(tok,path)=>{const u=new URL(path,'https://graph.microsoft.com/beta/');if(u.origin!=='https://graph.microsoft.com'||!u.pathname.startsWith('/beta/me/todo/'))throw Error('Invalid Graph beta URL');return request(tok,u.href);}:request;
   // Undefined is not false: older responses may omit hasAttachments.
   if(t.hasAttachments!==false||attachmentStatus(state,get(state,'task',id),initialAttachmentIndex).pending){
    let items=null;
    try{items=Array.isArray(t.attachments)?[...t.attachments,...(t['attachments@odata.nextLink']?await pages(token,t['attachments@odata.nextLink'],attachmentRequest):[])]:await pages(token,tp+'/attachments',attachmentRequest);}catch(e){
     // Optional read-only alternative; not all Graph tenants support $expand on To Do.
     if(e.status===401&&(t.hasAttachments===true||attachmentStatus(state,get(state,'task',id),initialAttachmentIndex).pending)){try{const expanded=await (await attachmentRequest(token,tp+'?$expand=attachments')).json();if(!Array.isArray(expanded.attachments)||!expanded.attachments.length)throw Error('扩展查询未返回附件');const rest=expanded['attachments@odata.nextLink']?await pages(token,expanded['attachments@odata.nextLink'],attachmentRequest):[];items=[...expanded.attachments,...rest];}catch(fallback){failures.push(report(t,id,'附件列表',e));failures.push(report(t,id,'附件扩展查询',fallback));}}
     else failures.push(report(t,id,'附件列表',e));
    }
    if(items&&(t.hasAttachments===true||attachmentStatus(state,get(state,'task',id),initialAttachmentIndex).pending)&&!items.length)failures.push(report(t,id,'附件列表',Error('微软标记有附件，但附件列表为空')));
    if(items)for(const a of items){
     try{
      if(!a.id)throw Error('微软返回的附件没有 ID');
      const aid=await sourceId('msattachment',id+'/'+a.id),existing=state.records['attachment:'+aid];
      if(existing?.deleted){counts.attachmentSkipped++;continue;}
      if(existing&&(!loadFile||await loadFile(aid))){counts.attachmentSkipped++;continue;}
      const recovered=all(state,'attachment').filter(x=>x.data.taskId===id&&x.data.raw?.recovery==='outlook'&&x.data.name===a.name&&x.data.size===a.size);
      if(loadFile){const matched=recovered.find(x=>x.data.source===a.id);if(matched&&await loadFile(matched.id)){counts.attachmentSkipped++;continue;}}
      const blob=await attachmentBlob(token,tp,a,attachmentRequest);
      if(loadFile&&recovered.length){const hash=async b=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',await b.arrayBuffer()))].map(x=>x.toString(16).padStart(2,'0')).join('');const digest=await hash(blob);let found=false;for(const candidate of recovered){if(candidate.data.source&&candidate.data.source!==a.id)continue;const local=await loadFile(candidate.id);if(local&&await hash(local)===digest){edit(state,'attachment',candidate.id,{source:a.id});counts.attachmentSkipped++;found=true;break;}}if(found)continue;}
      await storeFile(aid,blob);
      const {contentBytes,...raw}=a;
      edit(state,'attachment',aid,{taskId:id,name:a.name||'附件',type:blob.type||a.contentType||'application/octet-stream',size:blob.size,source:a.id,raw});counts.attachments++;
     }catch(e){counts.attachmentFilesFailed++;failures.push(report(t,id,'附件下载',e,a));}
    }
   }
   if(failures.length){markAttachmentImport(state,id,'pending',failures);counts.attachmentTasksFailed++;}else if(t.hasAttachments===true||pending[id]||get(state,'task',id)?.data.attachmentImport?.status==='pending')markAttachmentImport(state,id,'complete');
   counts.detailsDone++;
 }
 const width=Math.max(1,Math.min(8,Number(concurrency)||6));
 for(let i=0;i<jobs.length;i+=width){await Promise.all(jobs.slice(i,i+width).map(enrich));await save();progress(counts);}
 counts.phase='done';
 const finalAttachmentIndex=attachmentIndex(state);counts.attachmentPending=all(state,'task').filter(t=>attachmentStatus(state,t,finalAttachmentIndex).pending).length;await save();return counts;
}
