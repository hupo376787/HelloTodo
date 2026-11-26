import {test} from 'node:test';
import assert from 'node:assert/strict';
import {win32,posix} from 'node:path';
import {resolveStaticFile} from '../server/local.mjs';

test('static assets resolve on Windows and POSIX; reject directory traversal',()=>{
 for(const [paths,root] of [[win32,'D:\\GitHub\\HelloTodo\\web'],[posix,'/home/test/HelloTodo/web']]){
  assert.equal(resolveStaticFile(root,'/',paths),paths.join(root,'index.html'));
  assert.equal(resolveStaticFile(root,'/app.mjs',paths),paths.join(root,'app.mjs'));
  assert.equal(resolveStaticFile(root,'/style.css',paths),paths.join(root,'style.css'));
  assert.equal(resolveStaticFile(root,'/hello%20world.txt',paths),paths.join(root,'hello world.txt'));
  for(const bad of ['/../server/local.mjs','/%2e%2e%2fserver/local.mjs','/../web-other/file','/..%5cserver/local.mjs','/%00','/%GG','/foo/..'])assert.equal(resolveStaticFile(root,bad,paths),null,bad);
 }
});
