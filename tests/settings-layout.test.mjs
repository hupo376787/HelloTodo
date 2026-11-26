import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {MONET_COLORS} from '../web/appearance.mjs';
const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
test('settings dialogs have grouped cards, sticky actions and responsive single-column layout',()=>{
 const app=read('web/app.mjs'),css=read('web/style.css');
 assert.match(app,/dialog\.className=kind/);for(const title of ['基本设置','背景色','背景图片','实时预览','外观','Cloudflare 同步','迁移与恢复','数据与通知'])assert.ok(app.includes(`settingsCard('${title}'`),title);
 assert.match(css,/\.settings-grid\{display:grid;grid-template-columns:repeat\(2,/);assert.match(css,/@media\(max-width:650px\)[^\n]*\.settings-grid\{grid-template-columns:minmax\(0,1fr\)/);assert.match(css,/\.settings-dialog \.dialogActions\{position:sticky;bottom:0/);
});
test('shared native UI uses the same named Monet palette and attachment views as Web (source check)',()=>{
 const native=read('native/HelloTodo/MainView.Appearance.cs'),main=read('native/HelloTodo/MainView.cs'),store=read('native/HelloTodo/Store.cs');
 for(const c of MONET_COLORS)assert.ok(native.includes(`("${c.name}","${c.accent}","${c.background}")`));
 for(const v of ['attachments','attachments-ready','attachments-pending']){assert.ok(main.includes(`"${v}"`));assert.ok(store.includes(`"${v}"`));}
 for(const v of ['backgroundOpacity','backgroundId','sort','color'])assert.ok(native.includes(`["${v}"]`));
 assert.match(native,/if\(small\).*showRight/);assert.match(native,/PointerMoved/);assert.match(native,/Width=new GridLength/);
});
test('desktop scopes are distinct and shared native recovery reuses authenticated raw Worker protocol (source check)',()=>{
 const desktop=read('native/HelloTodo.Desktop/Program.cs'),recovery=read('native/HelloTodo/OutlookRecovery.cs'),native=read('native/HelloTodo/MainView.Appearance.cs'),web=read('web/app.mjs');
 assert.match(desktop,/graph\.microsoft\.com\/Tasks\.Read/);assert.match(desktop,/outlook\.office\.com\/Tasks\.Read/);assert.match(desktop,/AcquireTokenSilent/);assert.doesNotMatch(desktop,/Prompt\.SelectAccount/);
 for(const pattern of [/manifest-index/,/download-indexed/,/AllowAutoRedirect=false/,/ContentLength/,/SHA256/,/store\.PutFile/,/attachmentImport/])assert.match(recovery,pattern);
 assert.match(native,/migration-attachments/);assert.match(web,/#migration-attachments/);assert.match(native,/LaunchUriAsync\(uri\)/);assert.doesNotMatch(native,/index\.html[^\n]*cloud\.Key/);
});
