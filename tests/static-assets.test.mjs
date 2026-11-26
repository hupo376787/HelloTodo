import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,unlink,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {verifyWebAssets,REQUIRED_WEB_ASSETS} from '../server/local.mjs';

test('web asset preflight explicitly identifies missing and empty resize modules',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'ht-assets-'));
 try{
  for(const asset of REQUIRED_WEB_ASSETS)await writeFile(join(dir,asset),'test');
  await verifyWebAssets(dir);
  await unlink(join(dir,'pane-resize.mjs'));
  await assert.rejects(verifyWebAssets(dir),/pane-resize\.mjs/);
  await writeFile(join(dir,'pane-resize.mjs'),'');
  await assert.rejects(verifyWebAssets(dir),/pane-resize\.mjs/);
  await writeFile(join(dir,'pane-resize.mjs'),'restored');
  await verifyWebAssets(dir);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('complete source includes every service worker asset and application entry module',async()=>{
 const web=fileURLToPath(new URL('../web/',import.meta.url));
 await verifyWebAssets(web);
 const sw=await readFile(join(web,'sw.js'),'utf8');
 const manifest=sw.match(/const FILES=(\[[^\]]*\])/);
 assert.ok(manifest);
 for(const [,asset] of manifest[1].matchAll(/'([^']+)'/g))assert.ok(REQUIRED_WEB_ASSETS.includes(asset==='/'?'index.html':asset.slice(1)),asset);
 const app=await readFile(join(web,'app.mjs'),'utf8');
 for(const [,asset] of app.matchAll(/from\s*['"]\.\/([^'"]+)['"]/g))assert.ok(REQUIRED_WEB_ASSETS.includes(asset),asset);
});
