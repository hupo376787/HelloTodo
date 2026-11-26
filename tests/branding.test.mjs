import {test} from 'node:test';
import assert from 'node:assert/strict';
import {iconSvg,textScale,OLD_ACCENTS,BRIGHT_ACCENTS,upgradeAccent} from '../web/branding.mjs';
test('every preset is brighter while custom colors remain unchanged',()=>{
 const brightness=hex=>[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)).reduce((sum,c,i)=>sum+c*[.2126,.7152,.0722][i],0);
 OLD_ACCENTS.forEach((old,i)=>{assert.ok(brightness(BRIGHT_ACCENTS[i])>brightness(old));assert.equal(upgradeAccent(old),BRIGHT_ACCENTS[i]);});
 assert.equal(upgradeAccent('#123456'),'#123456');
});
test('checkmark uses the selected accent safely and global text scaling is bounded',()=>{
 assert.ok(iconSvg('#e08ca1').includes('#e08ca1'));assert.ok(!iconSvg('red"><script>').includes('<script>'));
 assert.equal(textScale(undefined),1);assert.equal(textScale(2),1.6);assert.equal(textScale(.2),.8);assert.equal(textScale(1.25),1.25);
});
