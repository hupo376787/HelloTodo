// Optional end-to-end test against an installed Chromium. Uses a fresh profile and test database.
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';

const executable=process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const directory=await mkdtemp(join(tmpdir(),'hellotodo-browser-')),port=18761+Math.floor(Math.random()*1000),origin='http://127.0.0.1:'+port;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const server=spawn(process.execPath,['server/local.mjs'],{env:{...process.env,PORT:String(port),HELLOTODO_KEY:'T'.repeat(43),HELLOTODO_DB:join(directory,'test.sqlite'),HELLOTODO_FILES:join(directory,'files')},stdio:'ignore',windowsHide:true});
let browser,ws;
try{
 for(let i=0;i<100;i++){try{if((await fetch(origin+'/api/health')).ok)break;}catch{}await delay(50);}
 browser=spawn(executable,['--headless=new','--disable-crash-reporter','--disable-breakpad','--noerrdialogs','--disable-gpu','--no-first-run','--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--user-data-dir='+join(directory,'profile'),'about:blank'],{stdio:['ignore','ignore','pipe'],windowsHide:true});
 let output='';let endpoint;
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Chromium did not start: '+output.slice(-600))),20000);browser.stderr.on('data',chunk=>{output+=chunk;const match=output.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(match){endpoint=new URL(match[1]);clearTimeout(timer);resolve();}});browser.on('error',reject);});
 const tab=await (await fetch('http://'+endpoint.host+'/json/new?'+encodeURIComponent(origin),{method:'PUT'})).json();
 ws=new WebSocket(tab.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
 let id=0;const pending=new Map();ws.onmessage=event=>{const message=JSON.parse(String(event.data)),item=pending.get(message.id);if(!item)return;pending.delete(message.id);message.error?item.reject(Error(message.error.message)):item.resolve(message.result);};
 const send=(method,params={})=>new Promise((resolve,reject)=>{const request=++id;const timer=setTimeout(()=>{pending.delete(request);reject(Error('CDP timeout: '+method));},15000);pending.set(request,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:error=>{clearTimeout(timer);reject(error);}});ws.send(JSON.stringify({id:request,method,params}));});
 const evaluate=async expression=>{const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(result.exceptionDetails)throw Error(result.exceptionDetails.text+' '+JSON.stringify(result.exceptionDetails.exception));return result.result?.value;};
 const wait=async(expression,label)=>{for(let i=0;i<150;i++){if(await evaluate(expression))return;await delay(100);}throw Error('Timed out: '+label);};
 await send('Page.enable');await send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});await send('Page.navigate',{url:origin});
 await wait("document.querySelector('#dialog')?.open && document.querySelector('#dialog').textContent.includes('欢迎使用')",'first-run welcome');
 await evaluate("[...document.querySelectorAll('#dialog button')].find(b=>b.textContent==='暂不登录，使用本地模式').click()");
 await wait("!document.querySelector('#dialog').open",'local mode');
 await evaluate("document.querySelector('#settings').click()");await wait("document.querySelector('input[aria-label=\"全局文字大小\"]')",'font slider');
 const before=await evaluate("parseFloat(getComputedStyle(document.querySelector('#heading h1')).fontSize)");
 await evaluate("(()=>{const s=document.querySelector('input[aria-label=\"全局文字大小\"]');s.value=160;s.dispatchEvent(new Event('input',{bubbles:true}));})()");
 const after=await evaluate("parseFloat(getComputedStyle(document.querySelector('#heading h1')).fontSize)");assert.ok(Math.abs(after/before-1.6)<.02);
 await evaluate("[...document.querySelectorAll('.monet-swatch')].find(b=>b.dataset.color==='#e08ca1').click()");
 assert.ok((await evaluate("document.querySelector('link[rel=icon]').href")).includes('%23e08ca1'));
 await evaluate("[...document.querySelectorAll('#dialog button')].find(b=>b.textContent==='关闭').click()");
 await send('Page.reload');await wait("document.querySelector('#heading h1') && !document.querySelector('#dialog').open",'saved local mode');
 assert.ok(Math.abs((await evaluate("parseFloat(getComputedStyle(document.querySelector('#heading h1')).fontSize)"))/before-1.6)<.02);
 await send('Page.navigate',{url:origin+'/account.html'});await wait("document.querySelector('#account-form') && document.querySelectorAll('#account-providers button').length===3",'account page');
 await evaluate("document.querySelector('#email').value='browser@example.test';document.querySelector('#password').value='browser test password 42';document.querySelector('#register').click()");
 await wait("location.pathname.includes('index.html') && document.querySelector('#status')?.textContent.includes('已同步')",'account sign-up and automatic sync');
 await evaluate("document.querySelector('#newTask').value='浏览器账号同步验证';document.querySelector('#add').requestSubmit()");
 await evaluate("document.querySelector('#sync').click()");
 await wait("document.querySelector('#status').textContent.includes('已同步')",'task upload');
 // A second independent device session reads the data created through the real UI.
 const login=await fetch(origin+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify({email:'browser@example.test',password:'browser test password 42'})});
 assert.equal(login.status,200);const sessionCookie=login.headers.get('set-cookie').split(';')[0];
 const token=await (await fetch(origin+'/api/auth/token',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,Cookie:sessionCookie},body:'{}'})).json();
 let tasks=[];for(let i=0;i<30;i++){tasks=(await (await fetch(origin+'/api/pull',{headers:{Authorization:'Bearer '+token.token}})).json()).records;if(tasks.some(t=>t.data.title==='浏览器账号同步验证'))break;await delay(100);}
 assert.ok(tasks.some(t=>t.data.title==='浏览器账号同步验证'));
 await mkdir('artifacts',{recursive:true});const screenshot=await send('Page.captureScreenshot',{format:'png'});await writeFile(resolve('artifacts/accounts-browser.png'),Buffer.from(screenshot.data,'base64'));
 await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
 await wait('innerWidth===390','mobile viewport');
 const mobileWidth=await evaluate('({viewport:innerWidth,width:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll("body *")].map(e=>({tag:e.tagName,id:e.id,cls:e.className,right:e.getBoundingClientRect().right,width:e.getBoundingClientRect().width})).filter(e=>e.right>innerWidth+1).slice(0,16)})');if(mobileWidth.width>mobileWidth.viewport+1)console.log(JSON.stringify(mobileWidth));assert.ok(mobileWidth.width<=mobileWidth.viewport+1,'Mobile 160% text must fit the viewport');
 await evaluate("document.querySelector('#settings').click()");await wait("document.querySelector('#dialog')?.open",'mobile settings');
 assert.equal(await evaluate("document.querySelector('input[aria-label=\"全局文字大小\"]').value"),'160','Restored slider thumb must match the saved text size');
 assert.ok(await evaluate("document.querySelector('#dialog').scrollWidth<=document.querySelector('#dialog').clientWidth+1"),'Mobile settings must not overflow horizontally');
 const mobile=await send('Page.captureScreenshot',{format:'png'});await writeFile(resolve('artifacts/accounts-mobile-settings.png'),Buffer.from(mobile.data,'base64'));
 await evaluate("(()=>{const slider=document.querySelector('input[aria-label=\"全局文字大小\"]');slider.value=80;slider.dispatchEvent(new Event('input',{bubbles:true}));[...document.querySelectorAll('#dialog button')].find(b=>b.textContent==='退出云工作区').click();})()");
 await wait("document.querySelector('#status').textContent.includes('本地模式')",'account logout');
 assert.equal(await evaluate("document.documentElement.style.getPropertyValue('--text-scale')"),'0.8','Global text size must survive logout');
 await send('Page.reload');await wait("document.querySelector('#heading h1') && !document.querySelector('#dialog').open",'local mode after logout');
 assert.equal(await evaluate("document.documentElement.style.getPropertyValue('--text-scale')"),'0.8');
 console.log('PASS: first-run welcome, local mode, 160% text, themed favicon, persistence, registration, automatic sync and independent device session');
}finally{
 ws?.close();browser?.kill();server.kill();await delay(300);
 // Only the uniquely created test directory is eligible for cleanup.
 try{await rm(directory,{recursive:true,force:true});}catch{}
}
