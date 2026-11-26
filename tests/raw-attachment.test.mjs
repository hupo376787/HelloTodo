import {test} from 'node:test';
import assert from 'node:assert/strict';
import {rawAttachmentAudit,recoverOutlookBatch} from '../web/outlook-batch.mjs';
import {readFile} from 'node:fs/promises';

test('all extensions and unknown MIME use the same raw bytes policy, including zero-byte files',()=>{
 for(const name of ['a.jpg','a.docx','a.zip','a.pdf','a.custom','no-extension','a.json','a.html']){
  const blob=new Blob([Uint8Array.of(0,255,1,2)]),audit=rawAttachmentAudit(blob,{name,size:4,expectedSize:693806,upstreamContentLength:'4'});
  assert.equal(audit.sizeMismatch,true);assert.equal(audit.verifiedSize,4);assert.equal(audit.validation.formatVerified,false);assert.equal(audit.validation.sourceIdentityVerified,false);
 }
 assert.equal(rawAttachmentAudit(new Blob(),{size:0,expectedSize:0,upstreamContentLength:'0'}).verifiedSize,0);
 assert.equal(rawAttachmentAudit(new Blob(['abc']),{size:3}).sizeStatus,'unknown');
});
test('transport byte mismatch rejects even if metadata matches; encoded responses compare decoded byte count only',()=>{
 const b=new Blob(['abc']);
 assert.throws(()=>rawAttachmentAudit(b,{size:4}),/字节数/);
 assert.throws(()=>rawAttachmentAudit(b,{size:3,expectedSize:3,upstreamContentLength:'4'}),/Content-Length/);
 assert.throws(()=>rawAttachmentAudit(b,{size:3,upstreamContentLength:'4',upstreamContentEncoding:'identity'}),/Content-Length/);
 assert.equal(rawAttachmentAudit(b,{size:3,upstreamContentLength:'10',upstreamContentEncoding:'gzip'}).verifiedSize,3);
});
test('batch saves unchanged bytes despite unknown format or size metadata differences; failures stay pending',async()=>{
 const tasks=[{id:'ok',data:{title:'ok'}},{id:'bad',data:{title:'bad'}}],statuses={},saved=[];
 const bytes=Uint8Array.of(0,255,42,0);
 const result=await recoverOutlookBatch({tasks,resolveTarget:async t=>({folderId:'f',taskId:t.id,localTaskId:t.id}),listAttachments:async t=>({attachments:t.id==='ok'?[{id:'doc',name:'x.docx'},{id:'new',name:'x.xyz'}]:[{id:'bad',name:'x.zip'}]}),hasSavedAttachment:async()=>({saved:false}),downloadAttachment:async(t,target,file)=>{const blob=new Blob([bytes]),meta={id:file.id,size:4,expectedSize:693806,upstreamContentLength:t.id==='ok'?'4':'10'};rawAttachmentAudit(blob,meta);return {blob,meta,reviewRequired:false};},saveAttachment:async(t,target,file,downloaded)=>{saved.push(file.id);assert.deepEqual(new Uint8Array(await downloaded.blob.arrayBuffer()),bytes);},setTaskStatus:async(t,status)=>{statuses[t.id]=status;}});
 assert.deepEqual(saved,['doc','new']);assert.deepEqual(statuses,{ok:'complete',bad:'pending'});assert.equal(result.downloaded,2);assert.equal(result.failed,1);assert.equal(result.needsReview,0);
});
test('production Outlook paths no longer call format-specific validators or enforce Preview.Size',async()=>{
 const app=await readFile(new URL('../web/app.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(app,/validate(?:OutlookAttachment|DocxAttachment|ImageAttachment)|attachmentRecoveryDecision/);
 assert.match(app,/B\.rawAttachmentAudit\(blob,meta\)/);assert.match(app,/return \{blob,meta,reviewRequired:false\}/);
 assert.match(app,/return \{saved:true,reviewRequired:false\}/);assert.match(app,/sha256:digest/);
});
