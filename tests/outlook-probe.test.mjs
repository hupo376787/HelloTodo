import {test} from 'node:test';
import assert from 'node:assert/strict';
import worker from '../server/worker.mjs';

const env={LOCAL_OUTLOOK_PROBE:true};
const payload={accessToken:'x'.repeat(240),mailbox:'owner@live.cn',folderId:'folder_1==',taskId:'task_1=='};
const request=(body=payload,origin='http://localhost:8787')=>new Request('http://localhost/api/outlook/attachment-probe',{
 method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)
});

test('local Outlook probe fetches Substrate metadata then the original file, without persisting token',async()=>{
 const prior=globalThis.fetch;const calls=[];
 try{
  globalThis.fetch=async(url,opts)=>{calls.push({url:String(url),opts});
   if(new URL(url).pathname.includes('/taskfolders/')){
    assert.match(new URL(url).pathname,/taskfolders\/folder%2B1%3D%3D\/tasks$/);assert.equal(new URL(url).searchParams.get('$expand'),'LinkedEntity');
    assert.equal(opts.headers.Authorization,'Bearer '+payload.accessToken);
    return Response.json({Value:[{Id:'task+1==',LinkedEntities:[{Id:'file+1==',WebLink:'/todob2/api/v1/tasks/task%2B1%3D%3D/attachments/file%2B1%3D%3D/$value',EntityType:'file',EntitySubType:'exchange-file-attachment',DisplayName:'test.png',Preview:{Size:3,ContentType:'image/png'}}]}]});
   }
   const u=new URL(String(url));assert.equal(u.origin,'https://substrate.office.com');
   assert.equal(decodeURIComponent(u.pathname.split('/').at(-1)),'$value');
   assert.equal(decodeURIComponent(u.pathname.split('/').at(-2)),'file+1==');
   assert.equal(opts.redirect,'manual');
   assert.equal(opts.headers.Authorization,'Bearer '+payload.accessToken);
   return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/png'}});
  };
  const r=await worker.fetch(request(),env);
  assert.equal(r.status,200);assert.equal(r.headers.get('X-HelloTodo-Stage'),'downloaded');
  assert.equal(decodeURIComponent(r.headers.get('X-HelloTodo-Attachment-Name')),'test.png');
  assert.equal(decodeURIComponent(r.headers.get('X-HelloTodo-Attachment-Id')),'file_1==');
  assert.equal(Number(r.headers.get('X-HelloTodo-Attachment-Count')),1);
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())],[1,2,3]);
  assert.equal(calls.length,2);
 }finally{globalThis.fetch=prior;}
});

test('local probe rejects non-loopback origins and malformed identifiers',async()=>{
 assert.equal((await worker.fetch(request(payload,'https://attacker.example'),env)).status,401);
 assert.equal((await worker.fetch(request({...payload,folderId:'https://attacker.example'}),env)).status,400);
});

test('Substrate 401 is reported as a stage-specific error and never exposes the bearer token',async()=>{
 const prior=globalThis.fetch;
 try{
  globalThis.fetch=async()=>Response.json({error:{code:'accessDenied',message:'Access denied'}},{status:401,headers:{'request-id':'sub-test-id'}});
  const r=await worker.fetch(request(),env),body=await r.json();
  assert.equal(r.status,401);assert.equal(body.stage,'Substrate 任务列表');assert.equal(body.code,'accessDenied');
  assert.equal(body.requestId,'sub-test-id');assert.doesNotMatch(JSON.stringify(body),/x{20}/);
 }finally{globalThis.fetch=prior;}
});

test('probe stops before download when task has no linked file attachment',async()=>{
 const prior=globalThis.fetch;let calls=0;
 try{
  globalThis.fetch=async()=>{calls++;return Response.json({Value:[{Id:'task+1==',LinkedEntities:[]}]});};
  const r=await worker.fetch(request(),env),body=await r.json();
  assert.equal(r.status,404);assert.equal(body.stage,'附件元数据');assert.equal(calls,1);
 }finally{globalThis.fetch=prior;}
});

test('probe retries the original Graph folder ID form if the Base64 folder path form is rejected',async()=>{
 const prior=globalThis.fetch;const urls=[];
 try{
  globalThis.fetch=async(url)=>{urls.push(String(url));if(urls.length===1)return new Response('not found',{status:404});
   if(urls.length===2)return Response.json({Value:[{Id:'task+1==',LinkedEntities:[{Id:'file+1==',WebLink:'/todob2/api/v1/tasks/task%2B1%3D%3D/attachments/file%2B1%3D%3D/$value',EntityType:'file',EntitySubType:'exchange-file-attachment',DisplayName:'a.txt',Preview:{Size:1,ContentType:'text/plain'}}]}]});
   return new Response(new Uint8Array([65]),{headers:{'Content-Type':'text/plain'}});
  };
  const r=await worker.fetch(request(),env);
  assert.equal(r.status,200);assert.equal(urls.length,3);
  assert.match(urls[0],/folder%2B1%3D%3D/);assert.match(urls[1],/folder_1%3D%3D/);
 }finally{globalThis.fetch=prior;}
});


test('probe follows same-folder NextLink and refuses external download links',async()=>{
 const prior=globalThis.fetch;let calls=0;
 try{
  globalThis.fetch=async(url,opts)=>{calls++;assert.equal(new URL(url).origin,'https://substrate.office.com');assert.equal(opts.redirect,'manual');
   if(calls===1)return Response.json({Value:[],NextLink:'https://substrate.office.com/todob2/api/v1/taskfolders/folder%2B1%3D%3D/tasks?skiptoken=next'});
   return Response.json({Value:[{Id:'task+1==',LinkedEntities:[{Id:'file+1==',WebLink:'https://example.invalid/attachment',EntityType:'file',EntitySubType:'exchange-file-attachment',Preview:{Size:3}}]}]});
  };
  const r=await worker.fetch(request(),env);assert.equal(r.status,502);assert.equal((await r.json()).stage,'附件下载地址');assert.equal(calls,2);
 }finally{globalThis.fetch=prior;}
});

test('probe refuses redirect with bearer and stops on foreign pagination',async()=>{
 const prior=globalThis.fetch;let calls=0;
 try{
  globalThis.fetch=async()=>{calls++;return Response.json({Value:[],NextLink:'https://example.invalid/tasks'});};
  let r=await worker.fetch(request(),env);assert.equal(r.status,502);assert.equal((await r.json()).stage,'Substrate 任务分页');assert.equal(calls,1);
  globalThis.fetch=async()=>{calls++;return new Response(null,{status:302,headers:{Location:'https://example.invalid/tasks'}});};
  r=await worker.fetch(request(),env);assert.equal(r.status,502);assert.equal(calls,2);
 }finally{globalThis.fetch=prior;}
});

test('Preview.Size mismatch is a warning when the HTTP body matches Content-Length',async()=>{
 const prior=globalThis.fetch;
 try{
  globalThis.fetch=async(url)=>{
   if(new URL(url).pathname.includes('/taskfolders/'))return Response.json({Value:[{Id:'task+1==',LinkedEntities:[{Id:'file+1==',WebLink:'/todob2/api/v1/tasks/task%2B1%3D%3D/attachments/file%2B1%3D%3D/$value',EntityType:'file',EntitySubType:'exchange-file-attachment',DisplayName:'test.jpg',Preview:{Size:1193536,ContentType:'image/jpeg'}}]}]});
   const bytes=new Uint8Array(578224);bytes.set([0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0x01,0x01,0x01,0x00,0x60]);bytes.set([0xff,0xd9],bytes.length-2);
   return new Response(bytes,{headers:{'Content-Type':'image/jpeg','Content-Length':'578224','request-id':'file-size-test'}});
  };
  const r=await worker.fetch(request(),env);
  assert.equal(r.status,200);assert.equal(r.headers.get('X-HelloTodo-Size-Mismatch'),'true');
  assert.equal(r.headers.get('X-HelloTodo-Expected-Size'),'1193536');assert.equal(r.headers.get('X-HelloTodo-Size-Status'),'metadata-differs');
  assert.equal(r.headers.get('X-HelloTodo-Attachment-Size'),'578224');assert.equal(r.headers.get('X-HelloTodo-Upstream-Content-Length'),'578224');
  assert.equal(r.headers.get('X-HelloTodo-Upstream-Request-Id'),'file-size-test');
  const downloaded=new Uint8Array(await r.arrayBuffer());assert.equal(downloaded.length,578224);assert.deepEqual([...downloaded.slice(0,16)],[0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0x01,0x01,0x01,0x00,0x60]);assert.deepEqual([...downloaded.slice(-2)],[0xff,0xd9]);
 }finally{globalThis.fetch=prior;}
});

test('missing Preview.Size does not block a complete attachment response',async()=>{
 const prior=globalThis.fetch;
 try{
  globalThis.fetch=async(url)=>{
   if(new URL(url).pathname.includes('/taskfolders/'))return Response.json({Value:[{Id:'task+1==',LinkedEntities:[{Id:'file+1==',WebLink:'/todob2/api/v1/tasks/task%2B1%3D%3D/attachments/file%2B1%3D%3D/$value',EntityType:'file',EntitySubType:'exchange-file-attachment',DisplayName:'a.bin'}]}]});
   return new Response(new Uint8Array([1,2,3]),{headers:{'Content-Length':'3','Content-Type':'application/octet-stream'}});
  };
  const r=await worker.fetch(request(),env);
  assert.equal(r.status,200);assert.equal(r.headers.get('X-HelloTodo-Size-Status'),'unknown');
  assert.equal(r.headers.get('X-HelloTodo-Expected-Size'),'');
 }finally{globalThis.fetch=prior;}
});

test('HTML and JSON error pages are not accepted as attachments',async()=>{
 const prior=globalThis.fetch;
 try{
  globalThis.fetch=async(url)=>{
   if(new URL(url).pathname.includes('/taskfolders/'))return Response.json({Value:[{Id:'task+1==',LinkedEntities:[{Id:'file+1==',WebLink:'/todob2/api/v1/tasks/task%2B1%3D%3D/attachments/file%2B1%3D%3D/$value',EntityType:'file',EntitySubType:'exchange-file-attachment',DisplayName:'photo.jpg',Preview:{Size:20,ContentType:'image/jpeg'}}]}]});
   return new Response('<!doctype html><html>login</html>',{headers:{'Content-Type':'text/html','Content-Length':'33'}});
  };
  const r=await worker.fetch(request(),env),d=await r.json();
  assert.equal(r.status,502);assert.equal(d.stage,'文件内容校验');
 }finally{globalThis.fetch=prior;}
});

test('failed response-body read is reported as transport truncation',async()=>{
 const prior=globalThis.fetch;
 try{
  globalThis.fetch=async(url)=>{
   if(new URL(url).pathname.includes('/taskfolders/'))return Response.json({Value:[{Id:'task+1==',LinkedEntities:[{Id:'file+1==',WebLink:'/todob2/api/v1/tasks/task%2B1%3D%3D/attachments/file%2B1%3D%3D/$value',EntityType:'file',EntitySubType:'exchange-file-attachment',DisplayName:'a.bin',Preview:{Size:10}}]}]});
   return {status:200,ok:true,headers:new Headers({'Content-Length':'10','Content-Type':'application/octet-stream'}),arrayBuffer:async()=>{throw Error('network terminated');}};
  };
  const r=await worker.fetch(request(),env),d=await r.json();
  assert.equal(r.status,502);assert.equal(d.stage,'传输完整性校验');assert.match(d.message,/响应体失败/);
 }finally{globalThis.fetch=prior;}
});

test('Content-Length mismatch still rejects a truncated HTTP response',async()=>{
 const prior=globalThis.fetch;
 try{
  globalThis.fetch=async(url)=>{
   if(new URL(url).pathname.includes('/taskfolders/'))return Response.json({Value:[{Id:'task+1==',LinkedEntities:[{Id:'file+1==',WebLink:'/todob2/api/v1/tasks/task%2B1%3D%3D/attachments/file%2B1%3D%3D/$value',EntityType:'file',EntitySubType:'exchange-file-attachment',DisplayName:'test.png',Preview:{Size:3,ContentType:'image/png'}}]}]});
   return new Response(new Uint8Array([0x89,0x50]),{headers:{'Content-Type':'image/png','Content-Length':'3'}});
  };
  const r=await worker.fetch(request(),env),d=await r.json();
  assert.equal(r.status,502);assert.equal(d.stage,'传输完整性校验');assert.equal(d.expectedSize,3);assert.equal(d.actualSize,2);
 }finally{globalThis.fetch=prior;}
});

test('metadata-only mode returns every attachment without downloading file bytes',async()=>{
 const prior=globalThis.fetch;let calls=0;
 try{
  globalThis.fetch=async(url)=>{calls++;assert.equal(new URL(url).origin,'https://substrate.office.com');return Response.json({Value:[{Id:'task+1==',LinkedEntities:[
   {Id:'file+1==',EntityType:'file',EntitySubType:'exchange-file-attachment',DisplayName:'one.jpg',Preview:{Size:10,ContentType:'image/jpeg'},WebLink:'/not-returned-to-client'},
   {Id:'file+2==',EntityType:'file',EntitySubType:'exchange-file-attachment',DisplayName:'two.zip',Preview:{Size:20,ContentType:'application/zip'},WebLink:'/not-returned-to-client'}
  ]}]});};
  const r=await worker.fetch(request({...payload,metadataOnly:true}),env),body=await r.json();
  assert.equal(r.status,200);assert.equal(body.attachmentCount,2);assert.deepEqual(body.attachments,[
   {index:0,id:'file_1==',name:'one.jpg',type:'image/jpeg',expectedSize:10},
   {index:1,id:'file_2==',name:'two.zip',type:'application/zip',expectedSize:20}
  ]);assert.equal(calls,1);assert.doesNotMatch(JSON.stringify(body),/substrate\.office\.com|WebLink/);
 }finally{globalThis.fetch=prior;}
});

test('attachmentId selects the requested second file instead of always returning the first',async()=>{
 const prior=globalThis.fetch;let calls=0;
 try{
  globalThis.fetch=async(url)=>{calls++;if(new URL(url).pathname.includes('/taskfolders/'))return Response.json({Value:[{Id:'task+1==',LinkedEntities:[
   {Id:'file+1==',EntityType:'file',EntitySubType:'exchange-file-attachment',DisplayName:'one.txt',Preview:{Size:1,ContentType:'text/plain'},WebLink:'/todob2/api/v1/tasks/task%2B1%3D%3D/attachments/file%2B1%3D%3D/$value'},
   {Id:'file+2==',EntityType:'file',EntitySubType:'exchange-file-attachment',DisplayName:'two.txt',Preview:{Size:2,ContentType:'text/plain'},WebLink:'/todob2/api/v1/tasks/task%2B1%3D%3D/attachments/file%2B2%3D%3D/$value'}
  ]}]});assert.match(new URL(url).pathname,/attachments\/file%2B2%3D%3D/);return new Response(new Uint8Array([65,66]),{headers:{'Content-Type':'text/plain','Content-Length':'2'}});};
  const r=await worker.fetch(request({...payload,attachmentId:'file+2=='}),env);
  assert.equal(r.status,200);assert.equal(decodeURIComponent(r.headers.get('X-HelloTodo-Attachment-Id')),'file_2==');assert.equal(r.headers.get('X-HelloTodo-Attachment-Count'),'2');assert.equal(r.headers.get('X-HelloTodo-Attachment-Index'),'1');assert.deepEqual([...new Uint8Array(await r.arrayBuffer())],[65,66]);assert.equal(calls,2);
 }finally{globalThis.fetch=prior;}
});

test('attachment selector rejects unknown IDs and out-of-range indexes',async()=>{
 const prior=globalThis.fetch;
 try{
  globalThis.fetch=async()=>Response.json({Value:[{Id:'task+1==',LinkedEntities:[{Id:'file+1==',EntityType:'file',EntitySubType:'exchange-file-attachment',DisplayName:'one.txt',Preview:{Size:1},WebLink:'/todob2/api/v1/tasks/task%2B1%3D%3D/attachments/file%2B1%3D%3D/$value'}]}]});
  let r=await worker.fetch(request({...payload,attachmentId:'file+9=='}),env);assert.equal(r.status,404);assert.equal((await r.json()).stage,'附件选择');
  r=await worker.fetch(request({...payload,attachmentIndex:3}),env);assert.equal(r.status,404);assert.equal((await r.json()).stage,'附件选择');
 }finally{globalThis.fetch=prior;}
});

const linked=(taskId,fileId)=>({Id:fileId,EntityType:'file',EntitySubType:'exchange-file-attachment',DisplayName:'sample.txt',Preview:{Size:1,ContentType:'text/plain'},WebLink:`/todob2/api/v1/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(fileId)}/$value`});
test('manifest index follows initial DeltaLink then historical NextLink pages and stops at terminal checkpoint',async()=>{
 const prior=globalThis.fetch,calls=[];const folder='/todob2/api/v1/taskfolders/folder%2B1%3D%3D/tasks';
 try{globalThis.fetch=async url=>{const u=new URL(url);calls.push(u);if(u.searchParams.has('deltatoken'))return Response.json({Value:[{Id:'other+1==',Status:'Completed',LinkedEntities:[linked('other+1==','file+2==')]}],NextLink:folder+'?skiptoken=more'});if(u.searchParams.has('skiptoken'))return Response.json({Value:[{Id:'task+1==',Status:'Completed',LinkedEntities:[linked('task+1==','file+1==')]}],DeltaLink:folder+'?deltatoken=terminal'});assert.equal(u.searchParams.get('$select'),'*,AllExtensions/com_microsoft_uno_richplannertask');return Response.json({Value:[{Id:'unrelated=='}],DeltaLink:folder+'?deltatoken=initial'});};
 const r=await worker.fetch(request({...payload,mode:'manifest-index',taskIds:['task_1==','other_1==','missing==']}),env),d=await r.json();assert.equal(r.status,200);assert.equal(d.pages,3);assert.equal(d.deltaPages,1);assert.equal(d.rowsRead,3);assert.deepEqual(d.manifests.map(x=>x.taskId),['other_1==','task_1==']);assert.deepEqual(d.unmatched,['missing==']);assert.equal(calls.length,3);assert.equal(d.manifests[0].attachments[0].webLink,linked('other+1==','file+2==').WebLink);
 }finally{globalThis.fetch=prior;}
});
test('indexed download avoids a second folder scan, validates same origin and exact IDs',async()=>{
 const prior=globalThis.fetch,calls=[];const file={index:0,id:'file_1==',name:'sample.txt',type:'text/plain',expectedSize:1,webLink:linked('task+1==','file+1==').WebLink};
 const body={...payload,mode:'download-indexed',attachmentId:file.id,file,attachmentCount:2};
 try{globalThis.fetch=async(url,options)=>{calls.push(String(url));assert.equal(options.redirect,'manual');assert.equal(options.headers.Authorization,'Bearer '+payload.accessToken);return new Response('a',{headers:{'Content-Type':'text/plain','Content-Length':'1'}});};
 const good=await worker.fetch(request(body),env);assert.equal(good.status,200);assert.equal(good.headers.get('X-HelloTodo-Attachment-Count'),'2');assert.equal(await good.text(),'a');assert.equal(calls.length,1);assert.match(calls[0],/\/attachments\//);
 for(const webLink of ['https://other.invalid/x',linked('other+1==','file+1==').WebLink,linked('task+1==','other+1==').WebLink,file.webLink+'?secret=x']){const bad=await worker.fetch(request({...body,file:{...file,webLink}}),env);assert.equal(bad.status,502);}
 assert.equal(calls.length,1);
 }finally{globalThis.fetch=prior;}
});

test('arbitrary named files, explicit HTML/JSON attachments and empty files return unchanged raw bytes',async()=>{
 const prior=globalThis.fetch;
 try{
  for(const item of [
   {name:'report.docx',type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',bytes:new Uint8Array([1,2,3])},
   {name:'file.unrecognized',type:'application/octet-stream',bytes:new Uint8Array([0,255,9])},
   {name:'no-extension',type:'text/html',bytes:new TextEncoder().encode('<html>actual file</html>')},
   {name:'settings.custom',type:'application/json',bytes:new TextEncoder().encode('{"error":"example text"}')},
   {name:'empty',type:'application/octet-stream',bytes:new Uint8Array()}
  ]){
   globalThis.fetch=async url=>new URL(url).pathname.includes('/taskfolders/')?Response.json({Value:[{Id:'task+1==',LinkedEntities:[{Id:'file+1==',EntityType:'file',EntitySubType:'exchange-file-attachment',DisplayName:item.name,Preview:{Size:693806,ContentType:item.type},WebLink:'/todob2/api/v1/tasks/task%2B1%3D%3D/attachments/file%2B1%3D%3D/$value'}]}]}):new Response(item.bytes,{headers:{'Content-Type':item.type,'Content-Length':String(item.bytes.length),'Content-Disposition':'attachment; filename="sample"'}});
   const r=await worker.fetch(request(),env);assert.equal(r.status,200,item.name);assert.equal(r.headers.get('X-HelloTodo-Size-Mismatch'),'true');assert.equal(r.headers.get('content-type'),'application/octet-stream');assert.equal(decodeURIComponent(r.headers.get('X-HelloTodo-Attachment-Type')),item.type);assert.deepEqual(new Uint8Array(await r.arrayBuffer()),item.bytes);
  }
 }finally{globalThis.fetch=prior;}
});
test('partial HTTP 206 and ambiguous empty responses are not accepted as complete files',async()=>{
 const prior=globalThis.fetch;
 try{for(const response of [new Response('abc',{status:206,headers:{'Content-Range':'bytes 0-2/10'}}),new Response(new Uint8Array(),{headers:{'Content-Length':'0'}})]){
  globalThis.fetch=async url=>new URL(url).pathname.includes('/taskfolders/')?Response.json({Value:[{Id:'task+1==',LinkedEntities:[{Id:'file+1==',EntityType:'file',EntitySubType:'exchange-file-attachment',DisplayName:'file.bin',Preview:{Size:10},WebLink:'/todob2/api/v1/tasks/task%2B1%3D%3D/attachments/file%2B1%3D%3D/$value'}]}]}):response;
  const r=await worker.fetch(request(),env);assert.equal(r.status,502);assert.equal((await r.json()).stage,'传输完整性校验');
 }}finally{globalThis.fetch=prior;}
});
