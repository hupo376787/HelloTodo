import {test} from 'node:test';
import assert from 'node:assert/strict';
import {imageFormat,validateImageAttachment,attachmentRecoveryDecision} from '../web/file-validation.mjs';

const jpeg=()=>new Blob([new Uint8Array([0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0x01,0xff,0xd9])],{type:'image/jpeg'});

test('image format detection supports MIME and file extension fallback',()=>{
 assert.equal(imageFormat('image/jpeg','photo.bin'),'jpeg');
 assert.equal(imageFormat('application/octet-stream','photo.JPG'),'jpeg');
 assert.equal(imageFormat('application/pdf','report.pdf'),null);
});

test('JPEG with complete markers and successful decoder is accepted with dimensions',async()=>{
 const result=await validateImageAttachment(jpeg(),{name:'photo.jpg',decodeImage:async()=>({width:1920,height:1080})});
 assert.equal(result.ok,true);assert.equal(result.kind,'image-decoded');assert.equal(result.format,'jpeg');
 assert.equal(result.width,1920);assert.equal(result.height,1080);
});

test('truncated JPEG without EOI is rejected before decoder runs',async()=>{
 let decoded=false;const blob=new Blob([new Uint8Array([0xff,0xd8,0xff,0xe0])],{type:'image/jpeg'});
 const result=await validateImageAttachment(blob,{decodeImage:async()=>{decoded=true;return {width:1,height:1};}});
 assert.equal(result.ok,false);assert.match(result.reason,/结束标记/);assert.equal(decoded,false);
});

test('JPEG decoder failure is rejected even when boundary markers exist',async()=>{
 const result=await validateImageAttachment(jpeg(),{decodeImage:async()=>{throw Error('decode failed');}});
 assert.equal(result.ok,false);assert.match(result.reason,/解码失败/);
});

test('invalid dimensions and oversized pixel counts are rejected',async()=>{
 const result=await validateImageAttachment(jpeg(),{decodeImage:async()=>({width:20000,height:20000})});
 assert.equal(result.ok,false);assert.match(result.reason,/像素安全上限/);
});

test('metadata mismatch completes only a single structurally validated image attachment',()=>{
 assert.deepEqual(attachmentRecoveryDecision({count:1,sizeMismatch:true,validation:{ok:true}}),{complete:true,pending:false,imageVerified:true,remaining:0,state:'image-validated-with-metadata-warning'});
 assert.equal(attachmentRecoveryDecision({count:1,sizeMismatch:true,validation:null}).state,'manual-review');
 assert.equal(attachmentRecoveryDecision({count:1,sizeMismatch:false}).complete,true);
 const multiple=attachmentRecoveryDecision({count:2,sizeMismatch:true,validation:{ok:true}});
 assert.equal(multiple.complete,false);assert.equal(multiple.pending,true);assert.equal(multiple.remaining,1);
});
