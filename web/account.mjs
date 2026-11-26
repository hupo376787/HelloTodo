import * as DB from './storage.mjs';
import {applyBranding} from './branding.mjs';
const $=id=>document.getElementById(id),params=new URLSearchParams(location.search),device=params.get('device');
let account=null,busy=false;
const message=text=>{$('account-message').textContent=text;};
async function api(path,options={}){
 const response=await fetch('/api/auth/'+path,{credentials:'same-origin',...options,headers:{'Content-Type':'application/json',...options.headers}});
 const data=await response.json();if(!response.ok)throw Error(data.error||(response.status===401?'请先登录':'账号请求失败'));return data;
}
async function finish(){
 if(device){
  const info=await api('device/info?id='+encodeURIComponent(device));
  const region=$('account-device');region.hidden=false;region.replaceChildren();
  const help=document.createElement('p');help.textContent=`是否将“${info.label}”连接到当前账号？请确认这是你刚才在 App 中发起的操作。`;
  const approve=document.createElement('button');approve.textContent='确认连接此设备';approve.className='primary';
  approve.onclick=()=>run(async()=>{await api('device/approve',{method:'POST',body:JSON.stringify({id:device})});region.replaceChildren();message('连接完成，可以返回 HelloTodo。');});
  region.append(help,approve);$('account-continue').textContent='返回网页版';return;
 }
 const session=await api('token',{method:'POST',body:'{}'});
 await DB.write('account.session',session);await DB.write('welcome.seen',true);
 location.replace('index.html');
}
async function run(action){if(busy)return;busy=true;document.querySelectorAll('button').forEach(b=>b.disabled=true);message('正在处理…');try{await action();}catch(error){message(error.message);}finally{busy=false;document.querySelectorAll('button[data-enabled="true"],#login,#register,#account-device button').forEach(b=>b.disabled=false);}}
async function signedIn(value){account=value;$('account-form').hidden=true;$('account-providers').hidden=true;const user=$('account-user');user.hidden=false;user.textContent='已登录：'+(account.email||'HelloTodo 用户');message('登录成功');await finish();}
$('account-form').onsubmit=e=>{e.preventDefault();run(async()=>{const data=await api('login',{method:'POST',body:JSON.stringify({email:$('email').value,password:$('password').value})});await signedIn(data.account);});};
$('register').onclick=()=>{if(!$('account-form').reportValidity())return;run(async()=>{const data=await api('register',{method:'POST',body:JSON.stringify({email:$('email').value,password:$('password').value})});await signedIn(data.account);});};
$('account-continue').onclick=async e=>{if(device)return;e.preventDefault();await DB.write('welcome.seen',true);location.replace('index.html');};
const active=await DB.read('active')||'local',saved=await DB.read('state:'+active);applyBranding(saved?.settings?.accentColor||'#3b82f6',saved?.settings?.textScale??1);
try{
 const config=await api('config');
 if(!config.enabled){message('账号服务尚未配置，可以先使用本地模式。');$('account-form').hidden=true;}
 for(const provider of config.providers){const button=document.createElement('button');button.type='button';button.textContent='使用 '+provider.name+' 登录';button.disabled=!provider.enabled;button.dataset.enabled=String(provider.enabled);if(!provider.enabled)button.title='发布者尚未配置此登录方式';button.onclick=()=>location.assign('/api/auth/start/'+provider.id+(device?'?device='+encodeURIComponent(device):''));$('account-providers').append(button);}
 if(params.get('provider')&&config.providers.some(p=>p.id===params.get('provider')&&p.enabled)){location.replace('/api/auth/start/'+params.get('provider')+(device?'?device='+encodeURIComponent(device):''));}
 else if(params.get('provider'))message('发布者尚未配置此登录方式，可以选择邮箱登录或本地模式。');
 else if(params.has('error'))message(params.get('error')==='cancelled'?'已取消登录，可以重试或使用本地模式。':'登录未完成，请检查服务端配置后重试。');
 else {try{const me=await api('me');await signedIn(me.account);}catch(error){if(!error.message.includes('请先登录'))message(error.message);}}
}catch(error){message('账号服务暂时不可用：'+error.message);}
