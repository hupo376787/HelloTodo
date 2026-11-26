import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../server/worker.mjs';
import {makeDB,memoryFiles} from '../server/local.mjs';
import {verifyIdentityToken,digest} from '../server/accounts.mjs';

const origin='https://todo.example.test',password='a good test password 42';
const cookie=response=>response.headers.get('set-cookie')?.split(';')[0]||'';
function fixture(extra={}){
 const env={DB:makeDB(),FILES:memoryFiles(),ACCOUNTS_ENABLED:'true',AUTH_PUBLIC_URL:origin,...extra};
 const call=(path,{method='GET',data,cookie:session,bearer,source=origin}={})=>worker.fetch(new Request(origin+path,{method,headers:{...(source?{Origin:source}:{}),...(session?{Cookie:session}:{}),...(bearer?{Authorization:'Bearer '+bearer}:{}),...(data!==undefined?{'Content-Type':'application/json'}:{})},...(data!==undefined?{body:JSON.stringify(data)}:{})}),env);
 return {env,call};
}
async function register(call,email){const response=await call('/api/auth/register',{method:'POST',data:{email,password}});assert.equal(response.status,200);return {cookie:cookie(response),...(await response.json())};}
async function token(call,session){const response=await call('/api/auth/token',{method:'POST',cookie:session,data:{}});assert.equal(response.status,200);return response.json();}

test('account registration, independent device sessions, sync and account isolation use the real database',async()=>{
 const {env,call}=fixture();try{
  const alice=await register(call,'alice@example.test'),a=await token(call,alice.cookie);
  const response=await call('/api/auth/login',{method:'POST',data:{email:' ALICE@example.test ',password}});assert.equal(response.status,200);
  const a2=await token(call,cookie(response));assert.equal(a.account.id,a2.account.id);assert.notEqual(a.token,a2.token);
  const row=await env.DB.prepare('SELECT password_hash,salt FROM accounts WHERE id=?').bind(a.account.id).first();assert.notEqual(row.password_hash,password);assert.ok(row.salt.length>=32);
  const op={opId:'create-one',kind:'task',id:'task-1',patch:{title:'same account on another device',listId:'inbox'},deleted:false};
  assert.equal((await call('/api/push',{method:'POST',bearer:a.token,data:{ops:[op]}})).status,200);
  const pulled=await (await call('/api/pull',{bearer:a2.token})).json();assert.equal(pulled.records[0].data.title,op.patch.title);
  await worker.fetch(new Request(origin+'/api/attachments/file1',{method:'PUT',headers:{Authorization:'Bearer '+a.token},body:'private file'}),env);
  const bob=await register(call,'bob@example.test'),b=await token(call,bob.cookie);
  assert.equal((await (await call('/api/pull',{bearer:b.token})).json()).records.length,0);
  assert.equal((await call('/api/attachments/file1',{bearer:b.token})).status,404);
  const legacyKey='L'.repeat(43);env.WORKSPACE_KEYS=await digest(legacyKey);
  assert.equal((await (await call('/api/pull',{bearer:legacyKey,cookie:alice.cookie})).json()).records.length,0,'Explicit workspace keys must not fall back to an unrelated browser account cookie');
  assert.equal((await call('/api/auth/login',{method:'POST',data:{email:'alice@example.test',password:'wrong password 10'}})).status,401);
  assert.equal((await call('/api/auth/register',{method:'POST',data:{email:'alice@example.test',password}})).status,409);
  await call('/api/auth/logout',{method:'POST',bearer:a.token,data:{}});
  assert.equal((await call('/api/pull',{bearer:a.token})).status,401);
  assert.equal((await call('/api/pull',{bearer:a2.token})).status,200);
 }finally{env.DB.close();}
});

test('native browser handoff requires login and explicit approval; secret, expiry and one-time redemption are enforced',async()=>{
 const {env,call}=fixture();try{
  const device=await (await call('/api/auth/device/start',{method:'POST',data:{label:'My test laptop'},source:null})).json();
  const poll=()=>call('/api/auth/device/poll',{method:'POST',data:{id:device.id,secret:device.secret},source:null});
  assert.equal((await poll()).status,202);
  assert.equal((await call('/api/auth/device/approve',{method:'POST',data:{id:device.id}})).status,401);
  const alice=await register(call,'alice@example.test');
  assert.equal((await call('/api/auth/device/approve',{method:'POST',cookie:alice.cookie,data:{id:device.id},source:'https://evil.example'})).status,403);
  assert.equal((await call('/api/auth/device/approve',{method:'POST',cookie:alice.cookie,data:{id:device.id}})).status,200);
  assert.equal((await call('/api/auth/device/poll',{method:'POST',data:{id:device.id,secret:'x'.repeat(43)},source:null})).status,410);
  const session=await (await poll()).json();assert.equal(session.account.id,alice.account.id);assert.match(session.token,/^hts_/);
  assert.equal((await poll()).status,410);
  assert.equal((await call('/api/pull',{bearer:session.token,source:null})).status,200);
  await env.DB.prepare('UPDATE account_sessions SET expires=0').bind().run();
  assert.equal((await call('/api/pull',{bearer:session.token})).status,401);
 }finally{env.DB.close();}
});

test('registration rejects cross-origin requests, weak passwords, malformed input and excessive guesses',async()=>{
 const {env,call}=fixture();try{
  assert.equal((await call('/api/auth/register',{method:'POST',data:{email:'x@example.test',password},source:'https://evil.example'})).status,403);
  assert.equal((await call('/api/auth/register',{method:'POST',data:{email:'x@example.test',password:'short'}})).status,400);
  let result;for(let i=0;i<22;i++)result=await call('/api/auth/login',{method:'POST',data:{email:'x@example.test',password:'incorrect password'}});
  assert.equal(result.status,429);
  const config=await (await call('/api/auth/config')).json();assert.equal(config.providers.length,3);assert.ok(config.providers.every(p=>!p.enabled));
 }finally{env.DB.close();}
});

const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
async function signed(key,claims,kid='test-key'){
 const text=encode({alg:'RS256',kid})+'.'+encode(claims);
 return text+'.'+Buffer.from(await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(text))).toString('base64url');
}
test('OIDC verifies signature, audience, issuer, nonce and expiry; full Google callback binds browser state and stable subject',async()=>{
 const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const jwk={...await crypto.subtle.exportKey('jwk',keys.publicKey),kid:'test-key',use:'sig',alg:'RS256'};
 const realFetch=globalThis.fetch;
 const {env,call}=fixture({AUTH_GOOGLE_CLIENT_ID:'google-client',AUTH_GOOGLE_CLIENT_SECRET:'server-secret'});
 const claims={iss:'https://accounts.google.com',sub:'stable-subject-123',aud:'google-client',nonce:'nonce-1',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+600,email:'same@example.test'};
 let tokenClaims=claims;
 globalThis.fetch=async(url,options)=>{
  if(String(url).includes('certs'))return Response.json({keys:[jwk]});
  assert.equal(String(url),'https://oauth2.googleapis.com/token');assert.equal(options.body.get('client_secret'),'server-secret');assert.ok(options.body.get('code_verifier'));
  return Response.json({id_token:await signed(keys.privateKey,tokenClaims)});
 };
 try{
  const valid=await signed(keys.privateKey,claims);assert.equal((await verifyIdentityToken(valid,'google','google-client','nonce-1')).sub,claims.sub);
  await assert.rejects(verifyIdentityToken(valid,'google','wrong-client','nonce-1'));
  await assert.rejects(verifyIdentityToken(valid,'google','google-client','wrong-nonce'));
  await assert.rejects(verifyIdentityToken(await signed(keys.privateKey,{...claims,exp:1}),'google','google-client','nonce-1'));
  await assert.rejects(verifyIdentityToken(await signed(keys.privateKey,{...claims,iss:'https://attacker.example'}),'google','google-client','nonce-1'));
  const parts=valid.split('.');parts[1]=encode({...claims,sub:'forged'});await assert.rejects(verifyIdentityToken(parts.join('.'),'google','google-client','nonce-1'));
  const passwordAccount=await register(call,'same@example.test');
  const start=await call('/api/auth/start/google'),authorize=new URL(start.headers.get('location'));assert.equal(authorize.searchParams.get('code_challenge_method'),'S256');
  tokenClaims={...claims,nonce:authorize.searchParams.get('nonce')};
  const callback='/api/auth/callback/google?code=test-code&state='+authorize.searchParams.get('state');
  assert.equal((await call(callback)).status,400);
  const finished=await call(callback,{cookie:cookie(start)});assert.equal(finished.status,303);
  const me=await (await call('/api/auth/me',{cookie:cookie(finished)})).json();assert.notEqual(me.account.id,passwordAccount.account.id,'Unverified email matching must not silently merge accounts');
  assert.equal((await call(callback,{cookie:cookie(start)})).status,400,'Callback state can only be redeemed once');
  const again=await call('/api/auth/start/google'),next=new URL(again.headers.get('location'));tokenClaims={...claims,nonce:next.searchParams.get('nonce')};
  const returning=await call('/api/auth/callback/google?code=again&state='+next.searchParams.get('state'),{cookie:cookie(again)});
  const same=await (await call('/api/auth/me',{cookie:cookie(returning)})).json();assert.equal(same.account.id,me.account.id);
 }finally{globalThis.fetch=realFetch;env.DB.close();}
});

test('Microsoft tenant/key issuer and Apple form_post callbacks establish accounts through their own endpoints',async()=>{
 const keys=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
 const publicKey=await crypto.subtle.exportKey('jwk',keys.publicKey),realFetch=globalThis.fetch;
 const tenant='12345678-1234-1234-1234-123456789abc';
 try{
  for(const provider of ['microsoft','apple']){
   const prefix='AUTH_'+provider.toUpperCase(),{env,call}=fixture({[prefix+'_CLIENT_ID']:'client-'+provider,[prefix+'_CLIENT_SECRET']:'secret-'+provider});
   try{
    const begin=await call('/api/auth/start/'+provider),url=new URL(begin.headers.get('location'));
    const claims={iss:provider==='apple'?'https://appleid.apple.com':`https://login.microsoftonline.com/${tenant}/v2.0`,tid:tenant,sub:'stable-'+provider,aud:'client-'+provider,nonce:url.searchParams.get('nonce'),iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+600};
    globalThis.fetch=async(address,options)=>{
     if(String(address).endsWith('/keys'))return Response.json({keys:[{...publicKey,kid:provider,alg:'RS256',use:'sig',...(provider==='microsoft'?{issuer:'https://login.microsoftonline.com/{tenantid}/v2.0'}:{})}]});
     assert.ok(String(address).includes(provider==='apple'?'appleid.apple.com':'login.microsoftonline.com'));
     assert.equal(options.body.has('code_verifier'),provider!=='apple');
     return Response.json({id_token:await signed(keys.privateKey,claims,provider)});
    };
    let result;
    if(provider==='apple'){
     assert.equal(url.searchParams.get('response_mode'),'form_post');assert.match(begin.headers.get('set-cookie'),/SameSite=None; Secure/);
     result=await worker.fetch(new Request(origin+'/api/auth/callback/apple',{method:'POST',headers:{Cookie:cookie(begin),'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({state:url.searchParams.get('state'),code:'apple-code'})}),env);
    }else result=await call('/api/auth/callback/microsoft?state='+url.searchParams.get('state')+'&code=ms-code',{cookie:cookie(begin)});
    assert.equal(result.status,303);assert.match(result.headers.get('set-cookie'),/HttpOnly/);
    const me=await (await call('/api/auth/me',{cookie:cookie(result)})).json();assert.ok(me.account.id);
    if(provider==='microsoft')await assert.rejects(verifyIdentityToken(await signed(keys.privateKey,{...claims,tid:'------------------------------------'},provider),provider,'client-'+provider,claims.nonce));
   }finally{env.DB.close();}
  }
 }finally{globalThis.fetch=realFetch;}
});
