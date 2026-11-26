export const OLD_ACCENTS=['#2564cf','#7695ad','#6e9e98','#879c83','#969b70','#c0a46c','#c18f75','#b9818b','#b397aa','#9990b7','#807b9e','#9c8c80','#87949d'];
export const BRIGHT_ACCENTS=['#3b82f6','#79b4df','#61b9aa','#8cbb7a','#b0bc66','#e6bd67','#e9a17c','#e08ca1','#d798c5','#b39be1','#9a90d1','#c5a68d','#9eafbd'];
export const textScale=value=>Number.isFinite(Number(value))?Math.min(1.6,Math.max(.8,Number(value))):1;
export function upgradeAccent(value){const i=OLD_ACCENTS.indexOf(String(value).toLowerCase());return i<0?value:BRIGHT_ACCENTS[i];}
export function iconSvg(color='#3b82f6',background=false){
 if(!/^#[\da-f]{6}$/i.test(color))color='#3b82f6';
 // The two interlocking strokes are separate so both tones follow the chosen accent.
 return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${background?'<rect width="64" height="64" rx="14" fill="white"/>':''}<path d="M4 30 14 20 28 34 18 44Z" fill="${color}"/><path d="M4 30 14 20 28 34 50 12 60 22 28 54Z" fill="${color}"/><path d="M18 44 50 12 60 22 28 54Z" fill="white" opacity=".30"/></svg>`;
}
export function applyBranding(accent,scale=1){
 const svg=iconSvg(accent),url='data:image/svg+xml,'+encodeURIComponent(svg);
 document.querySelector('link[rel="icon"]')?.setAttribute('href',url);
 document.querySelectorAll('[data-app-logo]').forEach(img=>{img.src=url;});
 document.documentElement.style.setProperty('--text-scale',String(textScale(scale)));
}
