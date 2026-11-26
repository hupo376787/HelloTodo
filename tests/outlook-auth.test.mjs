import {test} from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../web/core.mjs';
import {
  OUTLOOK_TASKS_SCOPE,GRAPH_TASKS_SCOPE,GRAPH_USER_SCOPE,graphScopesForMode,
  signIn,callback,signInOutlook,outlookCallback,resolveOutlookProbeTarget,
  localOutlookProbeTarget,getCachedGraphToken,getCachedOutlookToken,clearMicrosoftTokenCache
} from '../web/graph.mjs';

class MemoryStorage {
  constructor(){this.values=new Map();}
  getItem(k){return this.values.has(k)?this.values.get(k):null;}
  setItem(k,v){this.values.set(k,String(v));}
  removeItem(k){this.values.delete(k);}
  key(i){return [...this.values.keys()][i]??null;}
  get length(){return this.values.size;}
}

function globals(){return {fetch:globalThis.fetch,location:globalThis.location,sessionStorage:globalThis.sessionStorage,localStorage:globalThis.localStorage,history:globalThis.history};}
function restore(prior){Object.assign(globalThis,prior);}

 test('Exchange Online authorization uses PKCE, offline_access, and no forced consent prompt',async()=>{
  const prior=globals(),session=new MemoryStorage(),local=new MemoryStorage();let posts=0;
  try{
   globalThis.location={origin:'http://localhost:8787',pathname:'/index.html',search:'',href:''};
   globalThis.sessionStorage=session;globalThis.localStorage=local;globalThis.history={replaceState(){}};
   globalThis.fetch=async(url,opts)=>{
    if(url instanceof URL)return Response.json({clientId:'12345678-1234-1234-1234-123456789abc'});
    assert.equal(url,'https://login.microsoftonline.com/common/oauth2/v2.0/token');
    posts++;assert.equal(opts.body.get('scope'),OUTLOOK_TASKS_SCOPE+' offline_access');assert.equal(opts.body.get('client_secret'),null);
    return Response.json({access_token:'outlook-token',refresh_token:'outlook-refresh',expires_in:3600});
   };
   await signInOutlook('batch-attachments');
   const auth=new URL(location.href);
   assert.equal(auth.origin,'https://login.microsoftonline.com');
   assert.equal(auth.searchParams.get('scope'),OUTLOOK_TASKS_SCOPE+' offline_access');
   assert.equal(auth.searchParams.get('code_challenge_method'),'S256');
   assert.equal(auth.searchParams.has('code_challenge'),true);
   assert.equal(auth.searchParams.has('prompt'),false);
   assert.equal(session.getItem('outlook.action'),'batch-attachments');
   assert.equal(session.getItem('graph.pkce'),null);
   assert.ok(session.getItem('outlook.pkce'));
   location.search='?code=ok&state='+auth.searchParams.get('state');
   assert.equal(await outlookCallback(),'outlook-token');
   assert.equal(posts,1);assert.equal(session.getItem('outlook.pkce'),null);
   const cache=JSON.parse(local.getItem('hellotodo.microsoft.token.v1.outlook.12345678-1234-1234-1234-123456789abc'));
   assert.equal(cache.access_token,'outlook-token');assert.equal(cache.refresh_token,'outlook-refresh');
   location.search='';
   assert.equal(await getCachedOutlookToken(),'outlook-token');
   assert.equal(posts,1,'a valid cached access token must not trigger another OAuth exchange');
  }finally{restore(prior);clearMicrosoftTokenCache();}
 });

test('Graph authorization does not force account selection and requests offline_access',async()=>{
 const prior=globals(),session=new MemoryStorage(),local=new MemoryStorage();
 try{
  globalThis.location={origin:'http://localhost:8787',pathname:'/index.html',search:'',href:''};globalThis.sessionStorage=session;globalThis.localStorage=local;globalThis.history={replaceState(){}};
  globalThis.fetch=async url=>Response.json({clientId:'12345678-1234-1234-1234-123456789abc'});
  await signIn('full');const auth=new URL(location.href);
  assert.equal(auth.searchParams.get('scope'),GRAPH_TASKS_SCOPE+' offline_access');assert.equal(auth.searchParams.has('prompt'),false);
  assert.equal(graphScopesForMode('outlook-probe:task'),GRAPH_TASKS_SCOPE);assert.notEqual(GRAPH_USER_SCOPE,GRAPH_TASKS_SCOPE);
 }finally{restore(prior);clearMicrosoftTokenCache();}
});

test('expired cached Graph token silently refreshes and rotates the refresh token',async()=>{
 const prior=globals(),local=new MemoryStorage();let refreshCalls=0;
 try{
  globalThis.localStorage=local;
  local.setItem('hellotodo.microsoft.token.v1.graph.12345678-1234-1234-1234-123456789abc',JSON.stringify({clientId:'12345678-1234-1234-1234-123456789abc',access_token:'old-access',refresh_token:'old-refresh',expires_at:Date.now()-1000}));
  globalThis.fetch=async(url,opts)=>{
   if(url instanceof URL)return Response.json({clientId:'12345678-1234-1234-1234-123456789abc'});
   assert.equal(url,'https://login.microsoftonline.com/common/oauth2/v2.0/token');refreshCalls++;
   assert.equal(opts.body.get('grant_type'),'refresh_token');assert.equal(opts.body.get('refresh_token'),'old-refresh');assert.equal(opts.body.get('scope'),GRAPH_TASKS_SCOPE+' offline_access');
   return Response.json({access_token:'new-access',refresh_token:'rotated-refresh',expires_in:3600});
  };
  assert.equal(await getCachedGraphToken(),'new-access');assert.equal(refreshCalls,1);
  const cache=JSON.parse(local.getItem('hellotodo.microsoft.token.v1.graph.12345678-1234-1234-1234-123456789abc'));
  assert.equal(cache.refresh_token,'rotated-refresh');assert.equal(cache.access_token,'new-access');
 }finally{restore(prior);clearMicrosoftTokenCache();}
});

test('Graph task mapping finds the original folder using Tasks.Read only',async()=>{
 const state=C.fresh();C.edit(state,'task','local-task',{title:'来永福樱花园共赴一场浪漫之约',listId:'inbox',source:'task+1=='});
 const calls=[];
 const request=async(token,path)=>{calls.push(path);if(path==='me/todo/lists')return Response.json({value:[{id:'folder+1==',wellknownListName:'defaultList'}]});if(path.endsWith('/tasks'))return Response.json({value:[{id:'task_1=='},{id:'task+1==',title:'target'}]});throw Error(path);};
 const target=await resolveOutlookProbeTarget(state,'graph-token','local-task',request);
 assert.deepEqual(target,{folderId:'folder+1==',taskId:'task+1==',localTaskId:'local-task',taskTitle:'来永福樱花园共赴一场浪漫之约'});assert.equal(calls.length,2);
});

test('Graph task mapping refuses a local task without original Microsoft ID',async()=>{
 const state=C.fresh();C.task(state,'local only');
 await assert.rejects(resolveOutlookProbeTarget(state,'graph-token',C.all(state,'task')[0].id,async()=>Response.json({})),/没有 Microsoft 原始任务 ID/);
});

test('local source folder allows direct Outlook authorization without Graph lookup',()=>{
 const state=C.fresh();C.edit(state,'task','legacy',{title:'legacy',source:'task_1==',listId:'inbox'});assert.equal(localOutlookProbeTarget(state,'legacy'),null);
 C.edit(state,'task','legacy',{sourceListId:'folder_1=='});assert.deepEqual(localOutlookProbeTarget(state,'legacy'),{folderId:'folder_1==',taskId:'task_1==',localTaskId:'legacy',taskTitle:'legacy'});
});

test('expired Outlook token silently refreshes against the Exchange resource, not Graph',async()=>{
 const prior=globals(),local=new MemoryStorage();let refreshCalls=0;
 try{
  globalThis.localStorage=local;
  local.setItem('hellotodo.microsoft.token.v1.outlook.12345678-1234-1234-1234-123456789abc',JSON.stringify({clientId:'12345678-1234-1234-1234-123456789abc',access_token:'old-outlook',refresh_token:'outlook-refresh',expires_at:Date.now()-1000}));
  globalThis.fetch=async(url,opts)=>{
   if(url instanceof URL)return Response.json({clientId:'12345678-1234-1234-1234-123456789abc'});
   refreshCalls++;assert.equal(opts.body.get('grant_type'),'refresh_token');assert.equal(opts.body.get('refresh_token'),'outlook-refresh');assert.equal(opts.body.get('scope'),OUTLOOK_TASKS_SCOPE+' offline_access');
   return Response.json({access_token:'new-outlook',refresh_token:'outlook-refresh-2',expires_in:3600});
  };
  assert.equal(await getCachedOutlookToken(),'new-outlook');assert.equal(refreshCalls,1);
  const cache=JSON.parse(local.getItem('hellotodo.microsoft.token.v1.outlook.12345678-1234-1234-1234-123456789abc'));
  assert.equal(cache.refresh_token,'outlook-refresh-2');
 }finally{restore(prior);clearMicrosoftTokenCache();}
});
