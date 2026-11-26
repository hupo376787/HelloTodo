// Muted, Monet-inspired palettes. Background and accent values are independent.
export const MONET_COLORS=Object.freeze([
 ['默认蓝','#3b82f6','#e8effa'],['雾霾蓝','#79b4df','#dce7ef'],['湖水绿','#61b9aa','#deece7'],['鼠尾草','#8cbb7a','#e3ebdf'],['橄榄绿','#b0bc66','#e9ead8'],['奶油黄','#e6bd67','#f4ecd6'],['杏仁橙','#e9a17c','#f3e4da'],['干枯玫瑰','#e08ca1','#f2e1e5'],['烟粉','#d798c5','#eee3eb'],['薰衣草','#b39be1','#e9e5f2'],['鸢尾紫','#9a90d1','#e3e1ed'],['暖灰棕','#c5a68d','#ede6e0'],['雾灰','#9eafbd','#e5e9ec']
].map(([name,accent,background])=>Object.freeze({name,accent,background})));
export const DEFAULT_ACCENT=MONET_COLORS[0].accent;
export const normalizeAccent=value=>typeof value==='string'&&/^#[0-9a-f]{6}$/i.test(value)?value.toLowerCase():DEFAULT_ACCENT;
const rgb=hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16));
export function mixColor(a,b,t){return '#'+rgb(a).map((v,i)=>Math.round(v+(rgb(b)[i]-v)*t).toString(16).padStart(2,'0')).join('');}
function luminance(hex){return rgb(hex).map(x=>{const v=x/255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;}).reduce((s,v,i)=>s+v*[.2126,.7152,.0722][i],0);}
export function contrast(a,b){const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);}
function readable(base,against,toward){for(let i=0;i<=100;i++){const c=mixColor(base,toward,i/100);if(contrast(c,against)>=4.5)return c;}return toward;}
export function themeColors(value,dark=false){const a=normalizeAccent(value);if(a===DEFAULT_ACCENT)return dark?{'--blue':'#8ab4ff','--select':'#343e50','--main':'#17243a','--tile':'#292f39','--head':'#c6d9ff','--top':'#203d72','--top-text':'#ffffff','--primary-bg':'#8ab4ff','--primary-text':'#101010','--primary-hover':'#a4c5ff'}:{'--blue':a,'--select':'#e5eaf2','--main':'#e8effa','--tile':'#ffffffee','--head':'#2856a7','--top':a,'--top-text':contrast(a,'#ffffff')>=4.5?'#ffffff':'#000000','--primary-bg':a,'--primary-text':contrast(a,'#ffffff')>=4.5?'#ffffff':'#000000','--primary-hover':'#174ca6'};
 const main=mixColor(a,dark?'#121212':'#ffffff',dark?.84:.86),select=mixColor(a,dark?'#222222':'#ffffff',dark?.76:.80),tile=dark?mixColor(a,'#242424',.89):'#ffffffee';
 const top=dark?mixColor(a,'#171717',.65):a,topText=contrast(top,'#ffffff')>=4.5?'#ffffff':'#000000';
 const blue=readable(a,dark?'#343434':select,dark?'#ffffff':'#000000');
 const head=readable(a,main,dark?'#ffffff':'#000000');
 const primaryText=contrast(a,'#ffffff')>=4.5?'#ffffff':'#000000';
 return {'--blue':blue,'--select':select,'--main':main,'--tile':tile,'--head':head,'--top':top,'--top-text':topText,'--primary-bg':a,'--primary-text':primaryText,'--primary-hover':mixColor(a,primaryText==='#ffffff'?'#000000':'#ffffff',.12)};
}
// A backdrop click must start and end outside the dialog (not a text selection or scrollbar drag).
export function isOutsideDialog(rect,x,y){return x<rect.left||x>=rect.right||y<rect.top||y>=rect.bottom;}
export function installBackdropDismiss(dialog){let start=false;const outside=e=>e.target===dialog&&isOutsideDialog(dialog.getBoundingClientRect(),e.clientX,e.clientY);dialog.addEventListener('pointerdown',e=>{start=e.button===0&&outside(e);});dialog.addEventListener('pointercancel',()=>{start=false;});dialog.addEventListener('click',e=>{const close=start&&outside(e);start=false;if(close&&dialog.open)dialog.close();});dialog.addEventListener('close',()=>{start=false;});}
