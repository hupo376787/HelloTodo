// Device-local layout preferences; never part of task or workspace sync.
export const PANE_STORAGE_KEY='hellotodo.layout.panes.v1';
export const PANE_DEFAULTS=Object.freeze({sidebar:260,detail:345});
export const PANE_LIMITS=Object.freeze({sidebar:[160,520],detail:[260,760],main:280,divider:6});
const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
export function normalizePaneWidths(value){
  const result={...PANE_DEFAULTS};
  for(const side of ['sidebar','detail']){
    const n=value?.[side];
    if(typeof n==='number'&&Number.isFinite(n)) result[side]=clamp(Math.round(n),...PANE_LIMITS[side]);
  }
  return result;
}
export function fitPaneWidths(preferred,width,visible){
  const p=normalizePaneWidths(preferred), sides=['sidebar','detail'].filter(s=>visible[s]);
  const out={sidebar:0,detail:0};
  const available=Math.max(0,Math.floor(width)-PANE_LIMITS.main-sides.length*PANE_LIMITS.divider);
  const minimum=sides.reduce((n,s)=>n+PANE_LIMITS[s][0],0);
  const desired=sides.reduce((n,s)=>n+p[s],0);
  const fraction=desired>minimum?clamp((available-minimum)/(desired-minimum),0,1):1;
  for(const side of sides){const min=PANE_LIMITS[side][0];out[side]=min+Math.floor((p[side]-min)*fraction);}
  return out;
}
export function paneDragBounds(side,width,visible,current){
  const other=side==='sidebar'?'detail':'sidebar';
  const count=Number(visible.sidebar)+Number(visible.detail);
  const [min,max]=PANE_LIMITS[side];
  return [min,Math.max(min,Math.min(max,Math.floor(width)-PANE_LIMITS.main-count*PANE_LIMITS.divider-(visible[other]?current[other]:0)))];
}
export function installPaneResize(layout){
  const media=window.matchMedia('(max-width:760px)');
  const panes={sidebar:layout.querySelector('#sidebar'),detail:layout.querySelector('#detail')};
  const handles={sidebar:layout.querySelector('#sidebar-resizer'),detail:layout.querySelector('#detail-resizer')};
  let preferred=normalizePaneWidths(),current={sidebar:0,detail:0},drag=null;
  try{preferred=normalizePaneWidths(JSON.parse(localStorage.getItem(PANE_STORAGE_KEY)));}catch{}
  const visible=()=>({sidebar:!media.matches&&!layout.classList.contains('sidebarHidden'),detail:!media.matches&&!panes.detail.hidden});
  function paint(){
    const v=visible();
    for(const side of ['sidebar','detail']){
      const h=handles[side];h.hidden=!v[side];
      layout.style.setProperty(`--${side}-width`,`${current[side]||preferred[side]}px`);
      if(v[side]){const [min,max]=paneDragBounds(side,layout.clientWidth,v,current);h.setAttribute('aria-valuemin',String(min));h.setAttribute('aria-valuemax',String(max));h.setAttribute('aria-valuenow',String(current[side]));h.setAttribute('aria-valuetext',`${current[side]} 像素`);}
    }
  }
  function persist(){try{localStorage.setItem(PANE_STORAGE_KEY,JSON.stringify(preferred));}catch{}}
  function stop(){if(!drag)return;const {handle,id}=drag;drag=null;layout.classList.remove('pane-resizing');if(handle.hasPointerCapture(id))handle.releasePointerCapture(id);persist();}
  function refresh(){if(drag)stop();current=fitPaneWidths(preferred,layout.clientWidth,visible());paint();}
  function adjust(side,requested){
    const v=visible();if(!v[side])return;
    const [min,max]=paneDragBounds(side,layout.clientWidth,v,current);
    const next=clamp(Math.round(requested),min,max);if(next===current[side])return;
    const other=side==='sidebar'?'detail':'sidebar';
    // Preserve the opposite pane's rendered width while moving this divider.
    if(v[other])preferred[other]=current[other];
    preferred[side]=current[side]=next;paint();
  }
  for(const side of ['sidebar','detail']){
    const handle=handles[side],sign=side==='sidebar'?1:-1;
    handle.addEventListener('pointerdown',e=>{
      if(media.matches||handle.hidden||e.button!==0||drag)return;
      e.preventDefault();handle.focus({preventScroll:true});
      drag={handle,id:e.pointerId,startX:e.clientX,startWidth:current[side],side,sign};
      handle.setPointerCapture(e.pointerId);layout.classList.add('pane-resizing');
    });
    handle.addEventListener('pointermove',e=>{if(drag?.handle===handle&&drag.id===e.pointerId)adjust(side,drag.startWidth+sign*(e.clientX-drag.startX));});
    for(const type of ['pointerup','pointercancel','lostpointercapture'])handle.addEventListener(type,e=>{if(drag?.handle===handle&&drag.id===e.pointerId)stop();});
    handle.addEventListener('keydown',e=>{
      if(handle.hidden)return;const [min,max]=paneDragBounds(side,layout.clientWidth,visible(),current);let next;
      if(e.key==='ArrowLeft')next=current[side]-sign*(e.shiftKey?40:10);
      else if(e.key==='ArrowRight')next=current[side]+sign*(e.shiftKey?40:10);
      else if(e.key==='Home')next=min;else if(e.key==='End')next=max;else return;
      e.preventDefault();adjust(side,next);persist();
    });
    handle.addEventListener('dblclick',()=>{if(handle.hidden)return;preferred[side]=PANE_DEFAULTS[side];refresh();persist();});
  }
  // Layout geometry changes independently of task rendering or persistence.
  if(typeof ResizeObserver!=='undefined')new ResizeObserver(refresh).observe(layout);
  window.addEventListener('resize',refresh);media.addEventListener('change',refresh);
  refresh();return {refresh};
}
