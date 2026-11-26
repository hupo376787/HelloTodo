import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {MONET_COLORS,DEFAULT_ACCENT,normalizeAccent,themeColors,contrast,isOutsideDialog,installBackdropDismiss} from '../web/appearance.mjs';
test('Monet palette has unique named and safe background/accent values',()=>{
 assert.equal(MONET_COLORS.length,13);for(const key of ['name','accent','background'])assert.equal(new Set(MONET_COLORS.map(c=>c[key])).size,13);
 for(const c of MONET_COLORS)for(const key of ['accent','background'])assert.match(c[key],/^#[0-9a-f]{6}$/);
 assert.equal(normalizeAccent('red; color: red'),DEFAULT_ACCENT);assert.equal(normalizeAccent('#ABCDEF'),'#abcdef');
});
test('global accent maintains readable toolbar and primary buttons in light and dark modes',()=>{
 for(const a of [...MONET_COLORS.map(c=>c.accent),'#ffffff','#000000','#ffff00','#ff0000'])for(const dark of [false,true]){
 const c=themeColors(a,dark);assert.ok(contrast(c['--top'],c['--top-text'])>=4.5,`toolbar ${a} ${dark}`);assert.ok(contrast(c['--primary-bg'],c['--primary-text'])>=4.5,`button ${a} ${dark}`);assert.ok(contrast(c['--head'],c['--main'])>=4.5,`heading ${a} ${dark}`);
 }
});
test('default blue stays backwards compatible and custom theme changes default background',()=>{
 assert.equal(themeColors(null)['--main'],'#e8effa');assert.equal(themeColors(null,true)['--top'],'#203d72');assert.notEqual(themeColors('#6e9e98')['--main'],'#e8effa');assert.notEqual(themeColors('#6e9e98',true)['--main'],themeColors('#6e9e98')['--main']);
});
test('backdrop dismissal only closes for clicks beginning and ending outside',()=>{
 const rect={left:10,right:100,top:10,bottom:100};assert.equal(isOutsideDialog(rect,50,50),false);assert.equal(isOutsideDialog(rect,9,50),true);
 const handlers={};let count=0;const dialog={open:true,addEventListener:(n,f)=>handlers[n]=f,getBoundingClientRect:()=>rect,close:()=>count++};installBackdropDismiss(dialog);
 const e=(x,target=dialog)=>({target,clientX:x,clientY:50,button:0});handlers.pointerdown(e(50));handlers.click(e(5));assert.equal(count,0);handlers.pointerdown(e(5));handlers.click(e(50));assert.equal(count,0);handlers.pointerdown(e(5));handlers.pointercancel();handlers.click(e(5));assert.equal(count,0);handlers.pointerdown(e(5));handlers.click(e(5,{}));assert.equal(count,0);handlers.pointerdown(e(5));handlers.click(e(5));assert.equal(count,1);
});
test('both palettes are wired, list overrides are independent, and service worker caches the module',()=>{
 const app=readFileSync(new URL('../web/app.mjs',import.meta.url),'utf8'),sw=readFileSync(new URL('../web/sw.js',import.meta.url),'utf8');assert.match(app,/colorPalette\('accent'/);assert.match(app,/colorPalette\('background'/);assert.match(app,/state.settings.accentColor=normalizeAccent/);assert.match(app,/else main.style.removeProperty\('--main'\)/);assert.match(app,/installBackdropDismiss\(dialog\)/);assert.match(sw,/appearance\.mjs/);
});
