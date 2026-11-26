// Account identity is independent of Microsoft To Do import authorization.
// Only hashes of session/device secrets are persisted. Provider access tokens are discarded.
const encoder=new TextEncoder(),now=()=>Math.floor(Date.now()/1000);
export const digest=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value)))].map(v=>v.toString(16).padStart(2,'0')).join('');
const b64=bytes=>btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/,'');
const random=()=>b64(crypto.getRandomValues(new Uint8Array(32)));
const unb64=value=>Uint8Array.from(atob(value.replaceAll('-','+').replaceAll('_','/')),c=>c.charCodeAt(0));
const json=(body,status=200,headers={})=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',...headers}});
const cookie=(req,name)=>req.headers.get('cookie')?.split(';').map(s=>s.trim()).find(s=>s.startsWith(name+'='))?.slice(name.length+1)||'';
const redirect=(location,headers={})=>new Response(null,{status:303,headers:{Location:location,'Cache-Control':'no-store','Referrer-Policy':'no-referrer',...headers}});
const enabled=env=>env.ACCOUNTS_ENABLED===true||env.ACCOUNTS_ENABLED==='true';
const tokenFrom=req=>req.headers.has('authorization')?(req.headers.get('authorization')?.match(/^Bearer (hts_[A-Za-z0-9_-]{43})$/)?.[1]||''):cookie(req,'ht_session');
const publicOrigin=(req,env)=>{
 const u=new URL(env.AUTH_PUBLIC_URL||req.url);
 if(u.protocol!=='https:'&&!(u.protocol==='http:'&&['localhost','127.0.0.1'].includes(u.hostname)))throw Error('AUTH_PUBLIC_URL requires HTTPS');
 return u.origin;
};
function sessionCookie(req,value,maxAge=2592000){return `ht_session=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${new URL(req.url).protocol==='https:'?'; Secure':''}`;}
function browserCookie(req,value){return `ht_login=${value}; HttpOnly; Path=/api/auth/callback/; Max-Age=600; SameSite=${new URL(req.url).protocol==='https:'?'None; Secure':'Lax'}`;}
function csrf(req){const origin=req.headers.get('origin');return (!origin||origin===new URL(req.url).origin)&&!(cookie(req,'ht_session')&&!origin&&!req.headers.has('authorization'));}
async function body(req){if(!req.headers.get('content-type')?.startsWith('application/json'))throw Error('Expected JSON');const text=await req.text();if(text.length>8192)throw Error('Request too large');return JSON.parse(text);}
async function limited(req,env,action,limit=20,seconds=900){
 const time=now(),bucket=await digest(action+':'+(req.headers.get('CF-Connecting-IP')||'local')+':'+Math.floor(time/seconds));
 const row=await env.DB.prepare('INSERT INTO auth_limits(bucket,attempts,expires) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 RETURNING attempts').bind(bucket,time+seconds).first();
 return row.attempts>limit;
}
async function accountInfo(env,id){const account=await env.DB.prepare('SELECT id,email FROM accounts WHERE id=?').bind(id).first();return account?{...account,workspace:await digest('account:'+account.id)}:null;}
export async function accountSession(req,env){
 if(!enabled(env)||!env.DB)return null;
 const token=tokenFrom(req);if(!/^hts_[A-Za-z0-9_-]{43}$/.test(token))return null;
 const row=await env.DB.prepare('SELECT account_id FROM account_sessions WHERE token_hash=? AND expires>?').bind(await digest(token),now()).first();
 return row?accountInfo(env,row.account_id):null;
}
async function createSession(req,env,accountId,withToken=false){
 const token='hts_'+random(),expires=now()+2592000;
 await env.DB.batch(['account_sessions','oauth_states','account_devices','auth_limits'].map(table=>env.DB.prepare(`DELETE FROM ${table} WHERE expires<=?`).bind(now())));
 await env.DB.prepare('INSERT INTO account_sessions(token_hash,account_id,expires) VALUES(?,?,?)').bind(await digest(token),accountId,expires).run();
 return json({account:await accountInfo(env,accountId),expires,...(withToken?{token}:{})},200,{'Set-Cookie':sessionCookie(req,token)});
}
export async function passwordHash(password,salt){
 const material=await crypto.subtle.importKey('raw',encoder.encode(password),'PBKDF2',false,['deriveBits']);
 return b64(await crypto.subtle.deriveBits({name:'PBKDF2',salt:encoder.encode(salt),iterations:100000,hash:'SHA-256'},material,256));
}
function equal(a,b){if(typeof a!=='string'||typeof b!=='string'||a.length!==b.length)return false;let difference=0;for(let i=0;i<a.length;i++)difference|=a.charCodeAt(i)^b.charCodeAt(i);return difference===0;}

const providers={
 microsoft:{name:'Microsoft',authorize:'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',token:'https://login.microsoftonline.com/common/oauth2/v2.0/token',keys:'https://login.microsoftonline.com/common/discovery/v2.0/keys'},
 google:{name:'Google',authorize:'https://accounts.google.com/o/oauth2/v2/auth',token:'https://oauth2.googleapis.com/token',keys:'https://www.googleapis.com/oauth2/v3/certs'},
 apple:{name:'Apple',authorize:'https://appleid.apple.com/auth/authorize',token:'https://appleid.apple.com/auth/token',keys:'https://appleid.apple.com/auth/keys'}
};
function providerConfig(env,id){const prefix='AUTH_'+id.toUpperCase();return {...providers[id],clientId:env[prefix+'_CLIENT_ID'],secret:env[prefix+'_CLIENT_SECRET']};}
const configured=(env,id)=>!!(providers[id]&&providerConfig(env,id).clientId&&providerConfig(env,id).secret);
const keyCache=new Map();
async function signingKeys(url,force=false){
 const existing=keyCache.get(url);if(!force&&existing?.expires>Date.now())return existing.keys;
 const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('Signing keys unavailable');
 const data=await response.json();if(!Array.isArray(data.keys)||data.keys.length>100)throw Error('Invalid signing keys');
 keyCache.set(url,{keys:data.keys,expires:Date.now()+3600000});return data.keys;
}
export async function verifyIdentityToken(token,provider,clientId,nonce){
 if(typeof token!=='string'||token.length>20000)throw Error('Invalid identity token');
 const parts=token.split('.');if(parts.length!==3)throw Error('Invalid identity token');
 const decode=value=>JSON.parse(new TextDecoder().decode(unb64(value)));
 const header=decode(parts[0]),claims=decode(parts[1]);
 if(header.alg!=='RS256'||typeof header.kid!=='string'||header.crit)throw Error('Invalid signature algorithm');
 if(typeof claims.sub!=='string'||!claims.sub||claims.sub.length>255||claims.aud!==clientId||claims.nonce!==nonce||!Number.isInteger(claims.exp)||claims.exp<=now()||!Number.isInteger(claims.iat)||claims.iat>now()+60||(claims.nbf!=null&&(!Number.isInteger(claims.nbf)||claims.nbf>now()+60)))throw Error('Invalid identity claims');
 if(provider==='google'&&!['https://accounts.google.com','accounts.google.com'].includes(claims.iss))throw Error('Invalid issuer');
 if(provider==='apple'&&claims.iss!=='https://appleid.apple.com')throw Error('Invalid issuer');
 if(provider==='microsoft'&&(!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(claims.tid||'')||claims.iss!==`https://login.microsoftonline.com/${claims.tid}/v2.0`))throw Error('Invalid issuer');
 const url=providers[provider]?.keys;if(!url)throw Error('Invalid provider');
 let keys=await signingKeys(url),jwk=keys.find(k=>k.kid===header.kid);if(!jwk){keys=await signingKeys(url,true);jwk=keys.find(k=>k.kid===header.kid);}
 if(!jwk||jwk.kty!=='RSA'||jwk.use&&jwk.use!=='sig'||jwk.alg&&jwk.alg!=='RS256')throw Error('Invalid signing key');
 if(provider==='microsoft'&&(typeof jwk.issuer!=='string'||jwk.issuer.replace('{tenantid}',claims.tid)!==claims.iss))throw Error('Invalid key issuer');
 const key=await crypto.subtle.importKey('jwk',jwk,{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']);
 if(!await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,unb64(parts[2]),encoder.encode(parts[0]+'.'+parts[1])))throw Error('Invalid signature');
 return claims;
}
async function socialAccount(env,provider,claims){
 const subject=claims.iss+'|'+claims.sub;
 let identity=await env.DB.prepare('SELECT account_id FROM identities WHERE provider=? AND subject=?').bind(provider,subject).first();
 if(!identity){
  const id=crypto.randomUUID();
  // Never merge accounts by an email claim. Each provider's stable subject owns its identity.
  await env.DB.batch([
   env.DB.prepare('INSERT INTO accounts(id,email,created_at) VALUES(?,?,?)').bind(id,typeof claims.email==='string'?claims.email.slice(0,254):null,now()),
   env.DB.prepare('INSERT INTO identities(provider,subject,account_id) VALUES(?,?,?) ON CONFLICT(provider,subject) DO NOTHING').bind(provider,subject,id)
  ]);
  identity=await env.DB.prepare('SELECT account_id FROM identities WHERE provider=? AND subject=?').bind(provider,subject).first();
 }
 return identity.account_id;
}

export async function accountRoutes(req,env){
 const u=new URL(req.url),path=u.pathname;if(!path.startsWith('/api/auth/'))return null;
 if(path==='/api/auth/config'&&req.method==='GET')return json({enabled:enabled(env),registration:enabled(env),providers:Object.keys(providers).map(id=>({id,name:providers[id].name,enabled:enabled(env)&&configured(env,id)}))});
 if(!enabled(env)||!env.DB)return json({error:'账号服务尚未启用，请由发布者完成配置'},503);
 const origin=publicOrigin(req,env);
 if(req.method==='POST'&&!path.startsWith('/api/auth/callback/')&&!csrf(req))return json({error:'请求来源无效'},403);
 if(path==='/api/auth/me'&&req.method==='GET'){
  const account=await accountSession(req,env);return account?json({account}):json({account:null},401);
 }
 if(['/api/auth/register','/api/auth/login'].includes(path)&&req.method==='POST'){
  const registering=path.endsWith('/register');if(await limited(req,env,registering?'register':'login',registering?10:20))return json({error:'尝试次数过多，请稍后再试'},429);
  let input;try{input=await body(req);}catch{return json({error:'请求格式不正确'},400);}
  const email=typeof input.email==='string'?input.email.trim().toLowerCase():'';
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254||typeof input.password!=='string'||input.password.length<10||input.password.length>256)return json({error:'请输入有效邮箱及 10～256 位密码'},400);
  const existing=await env.DB.prepare('SELECT * FROM accounts WHERE email=? AND password_hash IS NOT NULL').bind(email).first();
  if(registering){
   if(existing)return json({error:'无法使用此邮箱注册，请尝试登录或其他邮箱'},409);
   const id=crypto.randomUUID(),salt=random(),hash=await passwordHash(input.password,salt);
   await env.DB.prepare('INSERT INTO accounts(id,email,password_hash,salt,created_at) VALUES(?,?,?,?,?)').bind(id,email,hash,salt,now()).run();
   return createSession(req,env,id);
  }
  const hash=await passwordHash(input.password,existing?.salt||'hellotodo-invalid-account');
  if(!existing||!equal(hash,existing.password_hash))return json({error:'邮箱或密码不正确'},401);
  return createSession(req,env,existing.id);
 }
 if(path==='/api/auth/logout'&&req.method==='POST'){
  const token=tokenFrom(req);if(token)await env.DB.prepare('DELETE FROM account_sessions WHERE token_hash=?').bind(await digest(token)).run();
  return json({ok:true},200,{'Set-Cookie':sessionCookie(req,'',0)});
 }
 if(path==='/api/auth/token'&&req.method==='POST'){
  const account=await accountSession(req,env);if(!account)return json({error:'请先登录'},401);
  if(await limited(req,env,'token',100))return json({error:'请稍后重试'},429);
  return createSession(req,env,account.id,true);
 }
 if(path==='/api/auth/device/start'&&req.method==='POST'){
  if(await limited(req,env,'device',30))return json({error:'请稍后重试'},429);
  let input;try{input=await body(req);}catch{return json({error:'请求格式不正确'},400);}
  const id=random(),secret=random(),label=String(input.label||'HelloTodo').slice(0,60),expires=now()+600;
  await env.DB.prepare('INSERT INTO account_devices(id,secret_hash,label,expires) VALUES(?,?,?,?)').bind(id,await digest(secret),label,expires).run();
  return json({id,secret,expires,verificationUrl:origin+'/account.html?device='+id});
 }
 if(path==='/api/auth/device/info'&&req.method==='GET'){
  const row=await env.DB.prepare('SELECT label FROM account_devices WHERE id=? AND expires>? AND consumed=0').bind(u.searchParams.get('id')||'',now()).first();
  return row?json(row):json({error:'连接请求已过期，请返回 App 重试'},410);
 }
 if(path==='/api/auth/device/approve'&&req.method==='POST'){
  const account=await accountSession(req,env);if(!account)return json({error:'请先登录'},401);
  let input;try{input=await body(req);}catch{return json({error:'请求格式不正确'},400);}
  const row=await env.DB.prepare('UPDATE account_devices SET account_id=? WHERE id=? AND expires>? AND consumed=0 AND account_id IS NULL RETURNING id').bind(account.id,input.id||'',now()).first();
  return row?json({ok:true}):json({error:'连接请求已过期或已使用'},410);
 }
 if(path==='/api/auth/device/poll'&&req.method==='POST'){
  if(await limited(req,env,'poll',180,60))return json({error:'请稍后重试'},429);
  let input;try{input=await body(req);}catch{return json({error:'请求格式不正确'},400);}
  if(typeof input.id!=='string'||typeof input.secret!=='string'||input.secret.length!==43)return json({error:'连接凭据无效'},400);
  const hash=await digest(input.secret);
  const row=await env.DB.prepare('SELECT account_id,consumed FROM account_devices WHERE id=? AND secret_hash=? AND expires>?').bind(input.id,hash,now()).first();
  if(!row||row.consumed)return json({error:'连接请求已过期或已使用'},410);
  if(!row.account_id)return json({pending:true},202);
  const consumed=await env.DB.prepare('UPDATE account_devices SET consumed=1 WHERE id=? AND secret_hash=? AND consumed=0 RETURNING account_id').bind(input.id,hash).first();
  if(!consumed)return json({error:'连接请求已使用'},410);
  return createSession(req,env,consumed.account_id,true);
 }
 const start=path.match(/^\/api\/auth\/start\/(microsoft|google|apple)$/);
 if(start&&req.method==='GET'){
  const provider=start[1];if(!configured(env,provider))return json({error:'发布者尚未配置此登录方式'},503);
  if(await limited(req,env,'oauth',60))return json({error:'请稍后重试'},429);
  const config=providerConfig(env,provider),state=random(),nonce=random(),verifier=random(),browser=random(),device=u.searchParams.get('device');
  if(device&&!await env.DB.prepare('SELECT id FROM account_devices WHERE id=? AND expires>? AND consumed=0').bind(device,now()).first())return json({error:'设备连接已过期'},410);
  await env.DB.prepare('INSERT INTO oauth_states(state_hash,provider,nonce,verifier,browser_hash,device_id,expires) VALUES(?,?,?,?,?,?,?)').bind(await digest(state),provider,nonce,verifier,await digest(browser),device||null,now()+600).run();
  const url=new URL(config.authorize);for(const [key,value] of Object.entries({client_id:config.clientId,redirect_uri:origin+'/api/auth/callback/'+provider,response_type:'code',scope:provider==='apple'?'name email':'openid email profile',state,nonce}))url.searchParams.set(key,value);
  if(provider==='apple')url.searchParams.set('response_mode','form_post');
  else {url.searchParams.set('code_challenge',b64(await crypto.subtle.digest('SHA-256',encoder.encode(verifier))));url.searchParams.set('code_challenge_method','S256');}
  return redirect(url.href,{'Set-Cookie':browserCookie(req,browser)});
 }
 const callback=path.match(/^\/api\/auth\/callback\/(microsoft|google|apple)$/);
 if(callback&&['GET','POST'].includes(req.method)){
  const values=req.method==='POST'?new URLSearchParams(await req.text()):u.searchParams;
  const state=values.get('state')||'';if(state.length!==43)return json({error:'登录状态无效，请重新登录'},400);
  const row=await env.DB.prepare('SELECT * FROM oauth_states WHERE state_hash=? AND provider=? AND expires>?').bind(await digest(state),callback[1],now()).first();
  if(!row||!equal(row.browser_hash,await digest(cookie(req,'ht_login'))))return json({error:'登录状态已失效，请重新登录'},400);
  const used=await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash=? RETURNING state_hash').bind(await digest(state)).first();if(!used)return json({error:'登录状态已使用'},400);
  const target=origin+'/account.html'+(row.device_id?'?device='+row.device_id:'');
  if(values.has('error')||!values.get('code'))return redirect(target+(row.device_id?'&':'?')+'error=cancelled');
  try{
   const config=providerConfig(env,row.provider),form=new URLSearchParams({grant_type:'authorization_code',code:values.get('code'),client_id:config.clientId,client_secret:config.secret,redirect_uri:origin+'/api/auth/callback/'+row.provider});
   if(row.provider!=='apple')form.set('code_verifier',row.verifier);
   const response=await fetch(config.token,{method:'POST',body:form,redirect:'error',signal:AbortSignal.timeout(15000)});if(!response.ok)throw Error('Token exchange failed');
   const tokens=await response.json(),claims=await verifyIdentityToken(tokens.id_token,row.provider,config.clientId,row.nonce),id=await socialAccount(env,row.provider,claims);
   const session=await createSession(req,env,id);return redirect(target,{'Set-Cookie':session.headers.get('set-cookie')});
  }catch{return redirect(target+(row.device_id?'&':'?')+'error=failed');}
 }
 return json({error:'Not found'},404);
}
