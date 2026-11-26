import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {normalizePaneWidths,fitPaneWidths,paneDragBounds,PANE_DEFAULTS} from '../web/pane-resize.mjs';
const both={sidebar:true,detail:true};
test('pane preferences validate corrupt storage and clamp bounds',()=>{
  assert.deepEqual(normalizePaneWidths(null),PANE_DEFAULTS);
  assert.deepEqual(normalizePaneWidths({sidebar:'300',detail:Infinity}),PANE_DEFAULTS);
  assert.deepEqual(normalizePaneWidths({sidebar:2,detail:9999}),{sidebar:160,detail:760});
});
test('desktop panes retain requested widths when space permits',()=>{
  assert.deepEqual(fitPaneWidths({sidebar:310,detail:480},1600,both),{sidebar:310,detail:480});
  assert.deepEqual(fitPaneWidths({},1280,{sidebar:true,detail:false}),{sidebar:260,detail:0});
  assert.deepEqual(fitPaneWidths({},1280,{sidebar:false,detail:true}),{sidebar:0,detail:345});
});
test('pane resizing reserves center width at narrow desktop sizes',()=>{
  for(const width of [761,800,1024,1280,1920]){
    const actual=fitPaneWidths({sidebar:520,detail:760},width,both);
    assert.ok(actual.sidebar>=160&&actual.detail>=260);
    assert.ok(width-12-actual.sidebar-actual.detail>=280);
  }
});
test('drag bounds depend on opposite visible pane and viewport',()=>{
  assert.deepEqual(paneDragBounds('sidebar',900,both,{sidebar:260,detail:345}),[160,263]);
  assert.deepEqual(paneDragBounds('detail',900,both,{sidebar:260,detail:345}),[260,348]);
  assert.deepEqual(paneDragBounds('detail',900,{sidebar:false,detail:true},{sidebar:0,detail:345}),[260,614]);
});
test('hidden and mobile panes do not consume splitter space',()=>{
  assert.deepEqual(fitPaneWidths({},390,{sidebar:false,detail:false}),{sidebar:0,detail:0});
  const html=readFileSync(new URL('../web/index.html',import.meta.url),'utf8'),css=readFileSync(new URL('../web/style.css',import.meta.url),'utf8'),sw=readFileSync(new URL('../web/sw.js',import.meta.url),'utf8');
  assert.match(html,/id="sidebar-resizer"[^>]+role="separator"[^>]+hidden/);
  assert.match(html,/id="detail-resizer"[^>]+role="separator"[^>]+hidden/);
  assert.match(css,/\.pane-resizer\{display:none\}/);
  assert.match(sw,/pane-resize\.mjs/);
});
