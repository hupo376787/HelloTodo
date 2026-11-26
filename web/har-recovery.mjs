import {all,get,edit,markAttachmentImport} from './core.mjs';
const MAX=25*1024*1024,MAX_HAR=100*1024*1024;
const enc=new TextEncoder();
export const maxHarSize=MAX_HAR;
// To Do/Graph use the same Exchange identifiers in this capture. Outlook deeplinks use + and /.
export function canonicalId(v){if(typeof v!=='string'||v.length>1024||!v||!/^[-_A-Za-z0-9+/]+={0,2}$/.test(v))return null;return v.replaceAll('+','_').replaceAll('/','-');}
const safeName=v=>typeof v==='string'&&v.length>0&&v.length<=512&&!/[\\/\x00-\x1f\x7f]/.test(v)&&v!=='.'&&v!=='..';
const safeType=v=>typeof v==='string'&&v.length<=128&&/^[\w.+-]+\/[\w.+-]+$/.test(v)?v.toLowerCase():'application/octet-stream';
const hex=async data=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',data))].map(b=>b.toString(16).padStart(2,'0')).join('');
const digest=async b=>hex(await b.arrayBuffer());
const sourceId=async(t,a)=>'msattachment-'+await hex(enc.encode(t+'/'+a));
function validMeta(a){return a&&canonicalId(a.id)===a.id&&safeName(a.name)&&Number.isSafeInteger(a.size)&&a.size>=0&&a.size<=MAX&&typeof a.type==='string';}
function body(c){if(typeof c?.text!=='string'||!c.text)return null;const text=c.encoding==='base64'?new TextDecoder('utf-8',{fatal:true}).decode(Uint8Array.from(atob(c.text),x=>x.charCodeAt(0))):c.text;return JSON.parse(text);}
export function parseTodoHar(har){
 if(!Array.isArray(har?.log?.entries))throw Error('不是有效的 HAR 文件');
 const tasks=new Map();let pages=0,invalid=0,ignored=0;
 for(const e of har.log.entries){let u;try{u=new URL(e.request?.url);}catch{continue;}
  if(u.origin!=='https://substrate.office.com'||e.request.method!=='GET'||e.response?.status!==200||!/^\/todob2\/api\/v1\/taskfolders\/[^/]+\/tasks\/?$/.test(u.pathname))continue;
  let v;try{v=body(e.response.content);}catch{invalid++;continue;}if(!Array.isArray(v?.Value))continue;pages++;
  for(const t of v.Value){const id=canonicalId(t?.Id);if(!id)continue;const prev=tasks.get(id)||{source:id,files:new Map()};for(const a of Array.isArray(t.LinkedEntities)?t.LinkedEntities:[]){if(a?.EntityType!=='file'||a.EntitySubType!=='exchange-file-attachment')continue;const m={id:canonicalId(a.Id),name:a.DisplayName,size:a.Preview?.Size,type:safeType(a.Preview?.ContentType)};if(!validMeta(m)){ignored++;continue;}const old=prev.files.get(m.id);if(old===null)continue;if(old&&(old.name!==m.name||old.size!==m.size||old.type!==m.type)){prev.files.set(m.id,null);ignored++;}else if(!prev.files.has(m.id))prev.files.set(m.id,m);}
   tasks.set(id,prev);
  }
 }
 const rows=[...tasks.values()].map(t=>({source:t.source,files:[...t.files.values()].filter(Boolean)})).filter(t=>t.files.length);return {pages,tasks:tasks.size,rows,files:rows.reduce((n,t)=>n+t.files.length,0),invalid,ignored};
}
export function previewHar(state,parsed){const map=new Map();for(const t of all(state,'task')){const id=canonicalId(t.data.source??t.data.raw?.id);if(!id)continue;if(!map.has(id))map.set(id,[]);map.get(id).push(t);}const matched=[],unmatched=[];for(const row of parsed.rows){const matches=map.get(row.source)||[];if(matches.length!==1){unmatched.push({source:row.source,count:row.files.length,reason:matches.length?'多个本地任务匹配':'未找到原始任务'});continue;}matched.push({taskId:matches[0].id,title:matches[0].data.title,files:row.files});}return {matched,unmatched};}
const existingFor=(state,taskId,m)=>all(state,'attachment').find(a=>a.data.taskId===taskId&&canonicalId(a.data.source)===m.id&&a.data.size===m.size);
function refresh(state,taskId){const t=get(state,'task',taskId);if(!t)return;const manifest=t.data.attachmentImport?.harFiles||[];if(!manifest.length)return;const missing=manifest.filter(m=>!existingFor(state,taskId,m));if(missing.length)markAttachmentImport(state,taskId,'pending',[{stage:'HAR 附件恢复',message:`已发现 ${manifest.length} 个原始附件，尚缺 ${missing.length} 个文件`}]);else markAttachmentImport(state,taskId,'complete');}
export function applyHar(state,parsed){const p=previewHar(state,parsed);for(const row of p.matched){const t=get(state,'task',row.taskId),old=t.data.attachmentImport?.harFiles||[];const by=new Map(old.filter(validMeta).map(m=>[m.id,m]));for(const m of row.files)if(validMeta(m))by.set(m.id,m);const files=[...by.values()];if(files.length>100||JSON.stringify(files).length>45000)throw Error('单条任务附件清单超过限制');if(JSON.stringify(old)!==JSON.stringify(files))edit(state,'task',row.taskId,{attachmentImport:{harFiles:files}});refresh(state,row.taskId);}return p;}
export function harRows(state){const out=[];for(const t of all(state,'task'))for(const m of t.data.attachmentImport?.harFiles||[])if(validMeta(m))out.push({taskId:t.id,title:t.data.title,source:canonicalId(t.data.source??t.data.raw?.id),...m,present:!!existingFor(state,t.id,m)});return out;}
export function outlookPreview(row){const o=v=>encodeURIComponent(canonicalId(v).replaceAll('_','+').replaceAll('-','/'));if(!canonicalId(row.source)||!canonicalId(row.id))throw Error('原始附件 ID 无效');return `https://outlook.live.com/mail/0/deeplink/attachment/${o(row.source)}/${o(row.id)}/false`;}
const fileMatch=(f,m)=>f.name===m.name&&f.size===m.size;
export function matchFiles(state,files){const rows=harRows(state).filter(r=>!r.present),matches=[],unmatched=[],used=new Set();for(const f of files){const candidates=rows.filter(r=>fileMatch(f,r));if(candidates.length!==1){unmatched.push({name:f.name,reason:candidates.length?'存在同名同大小附件，请逐个指定':'未找到同名同大小的待恢复附件'});continue;}const r=candidates[0],k=r.taskId+':'+r.id;if(used.has(k)){unmatched.push({name:f.name,reason:'重复选择'});continue;}used.add(k);matches.push({row:r,file:f});}return {matches,unmatched};}
export async function recoverHarFile(state,row,file,{storeFile,loadFile,save}){const t=get(state,'task',row.taskId),m=t?.data.attachmentImport?.harFiles?.find(x=>x.id===row.id);if(!validMeta(m))throw Error('附件未关联到有效任务');if(file.size!==m.size||file.size>MAX)throw Error(`文件大小不匹配：预期 ${m.size} 字节，实际 ${file.size} 字节`);const type=safeType(file.type);if(type!=='application/octet-stream'&&m.type!=='application/octet-stream'&&type!==m.type&&!(type==='application/zip'&&m.type.includes('officedocument')))throw Error('文件 MIME 类型不匹配');const hash=await digest(file);const aid=await sourceId(t.id,m.id);const old=state.records['attachment:'+aid];if(old?.deleted)throw Error('此附件此前已删除，请先核对是否需要恢复');if(old){const b=await loadFile(aid);if(b&&await digest(b)!==hash)throw Error('已存在相同来源 ID 但文件内容不同，未覆盖');}
 for(const a of all(state,'attachment').filter(a=>a.data.taskId===t.id&&a.data.size===m.size&&(!a.data.source||canonicalId(a.data.source)===m.id))){if(a.data.source&&canonicalId(a.data.source)!==m.id)continue;const b=await loadFile(a.id);if(b&&await digest(b)===hash){if(canonicalId(a.data.source)!==m.id)edit(state,'attachment',a.id,{source:m.id});refresh(state,t.id);await save();return 'existing';}}
 const blob=new Blob([file],{type:m.type});await storeFile(aid,blob);edit(state,'attachment',aid,{taskId:t.id,name:m.name,type:m.type,size:m.size,source:m.id,raw:{recovery:'har',sha256:hash}});refresh(state,t.id);await save();return 'saved';}
