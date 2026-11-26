import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {readFile,writeFile,mkdir,unlink,rename,stat} from 'node:fs/promises';
import path, {resolve,extname,dirname} from 'node:path';
import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {Readable} from 'node:stream';
import {createHash,randomBytes} from 'node:crypto';
import worker from './worker.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
// Use the platform's path rules, not a hard-coded POSIX separator.
export function resolveStaticFile(webRoot, pathname, paths=path){
 let decoded;
 try{decoded=decodeURIComponent(pathname==='/'?'/index.html':pathname);}catch{return null;}
 if(!decoded.startsWith('/')||decoded.includes('\0')||decoded.includes('\\'))return null;
 const file=paths.resolve(webRoot,'.'+decoded);
 const rel=paths.relative(webRoot,file);
 if(!rel||rel==='..'||rel.startsWith('..'+paths.sep)||paths.isAbsolute(rel))return null;
 return file;
}

// Fail before opening the database or listening if an update omitted a web asset.
export const REQUIRED_WEB_ASSETS=Object.freeze(['index.html','app.mjs','pane-resize.mjs','appearance.mjs','core.mjs','storage.mjs','graph.mjs','attachment-recovery.mjs','har-recovery.mjs','file-validation.mjs','outlook-batch.mjs','style.css','icon.svg','manifest.webmanifest','sw.js','microsoft-config.json','branding.mjs','account.html','account.mjs','account-config.json','icon-192.png','icon-512.png']);
export async function verifyWebAssets(webRoot){
 const bad=[];
 for(const asset of REQUIRED_WEB_ASSETS){
  const file=resolve(webRoot,asset);
  try{const info=await stat(file);if(!info.isFile()||info.size===0)bad.push(file);}
  catch(e){if(['ENOENT','ENOTDIR'].includes(e.code))bad.push(file);else throw e;}
 }
 if(bad.length)throw new Error('HelloTodo web assets missing or empty. Extract the complete update into the project root.\nWeb root: '+webRoot+'\n'+bad.join('\n'));
}

export function makeDB(path=':memory:'){
 const sqlite=new DatabaseSync(path);for(const file of ['0001.sql','0002_accounts.sql'])sqlite.exec(readFileSync(resolve(root,'server/migrations',file),'utf8'));
 const db={prepare(sql){return {bind(...args){return {run:async()=>sqlite.prepare(sql).run(...args),all:async()=>({results:sqlite.prepare(sql).all(...args)}),first:async()=>sqlite.prepare(sql).get(...args),_run:()=>sqlite.prepare(sql).run(...args)}}}},async batch(stmts){sqlite.exec('BEGIN');try{const results=stmts.map(s=>s._run());sqlite.exec('COMMIT');return results}catch(e){sqlite.exec('ROLLBACK');throw e}},close:()=>sqlite.close()};return db;
}
export function memoryFiles(){const map=new Map();return {put:async(k,v)=>map.set(k,new Uint8Array(v)),get:async k=>map.has(k)?{body:map.get(k)}:null,delete:async k=>map.delete(k)}}
export function diskFiles(dir){const path=k=>resolve(dir,createHash('sha256').update(k).digest('hex'));return {async put(k,v){await mkdir(dir,{recursive:true});const p=path(k),tmp=p+'.'+randomBytes(8).toString('hex');await writeFile(tmp,new Uint8Array(v));await rename(tmp,p)},async get(k){try{return {body:await readFile(path(k))}}catch(e){if(e.code==='ENOENT')return null;throw e}},async delete(k){try{await unlink(path(k))}catch(e){if(e.code!=='ENOENT')throw e}}};}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{await verifyWebAssets(resolve(root,'web'));}catch(e){console.error(e.message);process.exit(1);}
 const key=process.env.HELLOTODO_KEY||randomBytes(32).toString('base64url');
 const env={...Object.fromEntries(Object.entries(process.env).filter(([name])=>name.startsWith('AUTH_'))),ACCOUNTS_ENABLED:process.env.ACCOUNTS_ENABLED??'true',DB:makeDB(process.env.HELLOTODO_DB||resolve(root,'local.sqlite')),WORKSPACE_KEYS:createHash('sha256').update(key).digest('hex'),LOCAL_OUTLOOK_PROBE:true,FILES:diskFiles(process.env.HELLOTODO_FILES||resolve(root,'local-files'))};
 const mime={'.html':'text/html; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.webmanifest':'application/manifest+json','.svg':'image/svg+xml'};
 createServer(async(req,res)=>{try{const url=new URL(req.url,'http://'+(req.headers.host||'localhost'));if(url.pathname.startsWith('/api/')){const r=new Request(url,{method:req.method,headers:req.headers,...(['GET','HEAD'].includes(req.method)?{}:{body:Readable.toWeb(req),duplex:'half'})});const out=await worker.fetch(r,env);res.writeHead(out.status,Object.fromEntries(out.headers));res.end(Buffer.from(await out.arrayBuffer()));return;}
 const file=resolveStaticFile(resolve(root,'web'),url.pathname);
 if(!file){res.writeHead(404);res.end();return;}
 let body;
 try{if(!(await stat(file)).isFile()){res.writeHead(404);res.end();return;}body=await readFile(file);}
 catch(e){if(['ENOENT','ENOTDIR'].includes(e.code)){res.writeHead(404);res.end();return;}throw e;}
 res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Content-Length':body.length,'Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:body);
 }catch(e){res.writeHead(500);res.end('Error')}}).listen(Number(process.env.PORT||8787),'127.0.0.1',()=>console.log('http://127.0.0.1:'+(process.env.PORT||8787)+'\nLocal test key: '+key+'\nLocal attachments persist in the configured directory.'));
}
