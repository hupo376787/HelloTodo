const MIME_BY_EXT={jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',gif:'image/gif',webp:'image/webp'};

export function imageFormat(type='',name=''){
 const mime=String(type||'').split(';')[0].trim().toLowerCase();
 if(mime==='image/jpeg'||mime==='image/jpg')return 'jpeg';
 if(mime==='image/png')return 'png';
 if(mime==='image/gif')return 'gif';
 if(mime==='image/webp')return 'webp';
 const ext=String(name||'').split('?')[0].split('.').pop()?.toLowerCase();
 const byExt=MIME_BY_EXT[ext];
 if(byExt==='image/jpeg')return 'jpeg';
 if(byExt==='image/png')return 'png';
 if(byExt==='image/gif')return 'gif';
 if(byExt==='image/webp')return 'webp';
 return null;
}

function validContainer(bytes,format){
 if(format==='jpeg')return bytes.length>=4&&bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff&&bytes.at(-2)===0xff&&bytes.at(-1)===0xd9;
 if(format==='gif')return bytes.length>=14&&['GIF87a','GIF89a'].some(s=>String.fromCharCode(...bytes.slice(0,6))===s)&&bytes.at(-1)===0x3b;
 if(format==='webp'){
  if(bytes.length<20||String.fromCharCode(...bytes.slice(0,4))!=='RIFF'||String.fromCharCode(...bytes.slice(8,12))!=='WEBP')return false;
  const n=bytes[4]+bytes[5]*256+bytes[6]*65536+bytes[7]*16777216;
  return n+8===bytes.length;
 }
 if(format==='png'){
  const sig=[137,80,78,71,13,10,26,10];
  if(bytes.length<45||!sig.every((v,i)=>bytes[i]===v))return false;
  let offset=8,ihdr=false,idat=false,iend=false;
  while(offset+12<=bytes.length){
   const n=(bytes[offset]*0x1000000)+(bytes[offset+1]<<16)+(bytes[offset+2]<<8)+bytes[offset+3];
   if(n>bytes.length||offset+12+n>bytes.length)return false;
   const type=String.fromCharCode(...bytes.slice(offset+4,offset+8));
   if(type==='IHDR'){if(ihdr||n!==13)return false;ihdr=true;}
   if(type==='IDAT')idat=true;
   if(type==='IEND'){if(n!==0||!ihdr||!idat||offset+12!==bytes.length)return false;iend=true;break;}
   offset+=12+n;
  }
  return iend;
 }
 return false;
}

async function decodeInBrowser(blob){
 if(typeof globalThis.createImageBitmap==='function'){
  const bitmap=await globalThis.createImageBitmap(blob);
  try{return {width:bitmap.width,height:bitmap.height};}finally{bitmap.close?.();}
 }
 if(typeof globalThis.Image==='function'&&globalThis.URL?.createObjectURL){
  const url=URL.createObjectURL(blob);
  try{
   const img=new Image();img.src=url;
   if(typeof img.decode==='function')await img.decode();
   else await new Promise((resolve,reject)=>{img.onload=resolve;img.onerror=()=>reject(Error('浏览器无法解码图片'));});
   return {width:img.naturalWidth||img.width,height:img.naturalHeight||img.height};
  }finally{URL.revokeObjectURL(url);}
 }
 throw Error('当前环境没有可用的图片解码器');
}

// A successful result means the returned image is structurally plausible and the browser decoder can decode it.
// It does not prove byte-for-byte identity with the original upload; source metadata discrepancies are retained separately.
export async function validateImageAttachment(blob,{type=blob?.type||'',name='',decodeImage=decodeInBrowser}={}){
 const format=imageFormat(type,name);
 if(!format)return {ok:false,kind:'not-image',reason:'该文件不是支持自动验证的图片格式'};
 if(!blob||!Number.isSafeInteger(blob.size)||blob.size===0)return {ok:false,kind:'invalid',format,reason:'附件为空'};
 const bytes=new Uint8Array(await blob.arrayBuffer());
 if(!validContainer(bytes,format))return {ok:false,kind:'invalid',format,reason:'图片文件头、容器长度或结束标记不完整'};
 let dimensions;
 try{dimensions=await decodeImage(blob);}catch(e){return {ok:false,kind:'invalid',format,reason:'图片解码失败：'+String(e?.message||e).slice(0,200)};}
 const width=Number(dimensions?.width),height=Number(dimensions?.height);
 if(!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>100_000_000)return {ok:false,kind:'invalid',format,reason:'图片尺寸无效或超过 1 亿像素安全上限'};
 return {ok:true,kind:'image-decoded',format,width,height,method:'container-signature+browser-decode'};
}

export function attachmentRecoveryDecision(meta={}){
 const mismatch=meta.sizeMismatch===true;
 const imageVerified=meta.validation?.ok===true;
 const count=Number.isSafeInteger(meta.count)&&meta.count>0?meta.count:1;
 const complete=count===1&&(!mismatch||imageVerified);
 return {complete,pending:!complete,imageVerified,remaining:Math.max(0,count-1),state:complete?(mismatch?'image-validated-with-metadata-warning':'complete'):(mismatch&&!imageVerified?'manual-review':'more-attachments')};
}

// DOCX is an OOXML ZIP package. Check directory, local records, bounded inflation,
// CRC32 and mandatory parts. No extraction to disk or execution of document content.
export function isDocxAttachment(type='',name=''){
 return /\.docx$/i.test(String(name))||String(type).split(';')[0].trim().toLowerCase()==='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
}
const CRC_TABLE=Uint32Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=(n&1)?(0xedb88320^(n>>>1)):(n>>>1);return n>>>0;});
function crc32(bytes){let n=0xffffffff;for(const b of bytes)n=CRC_TABLE[(n^b)&255]^(n>>>8);return (n^0xffffffff)>>>0;}
async function inflateBounded(bytes,size){
 const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
 const out=new Uint8Array(size);let offset=0;
 try{while(true){const {done,value}=await reader.read();if(done)break;if(offset+value.length>size)throw Error('解压长度超出 ZIP 声明');out.set(value,offset);offset+=value.length;}if(offset!==size)throw Error('解压长度不符');return out;}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
export async function validateDocxAttachment(blob){
 const kind='docx-package';
 if(typeof DecompressionStream!=='function')return {ok:false,kind:'unsupported',format:'docx',reason:'当前浏览器不支持 ZIP 解压校验'};
 // Avoid zip bombs and excessively large documents in a browser migration.
 const max=128*1024*1024;
 try{
  if(!blob||blob.size<22||blob.size>25*1024*1024)throw Error('DOCX 文件为空或超过下载上限');
  const b=new Uint8Array(await blob.arrayBuffer()),v=new DataView(b.buffer),u16=o=>v.getUint16(o,true),u32=o=>v.getUint32(o,true);
  let end=-1;for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--){if(u32(i)===0x06054b50&&i+22+u16(i+20)===b.length){end=i;break;}}
  if(end<0)throw Error('缺少 ZIP 中央目录结束标记');
  const count=u16(end+10),centralSize=u32(end+12),centralOffset=u32(end+16);
  if(u16(end+4)||u16(end+6)||u16(end+8)!==count||!count||count>4096||centralOffset+centralSize!==end)throw Error('ZIP 目录无效或不支持分卷/ZIP64');
  const names=new Set(),ranges=[],parts=new Map(),required=new Set(['[Content_Types].xml','_rels/.rels','word/document.xml']);
  let p=centralOffset,total=0;
  for(let i=0;i<count;i++){
   if(p+46>end||u32(p)!==0x02014b50)throw Error('ZIP 中央目录记录损坏');
   const flags=u16(p+8),method=u16(p+10),crc=u32(p+16),compressed=u32(p+20),size=u32(p+24),nl=u16(p+28),xl=u16(p+30),cl=u16(p+32),local=u32(p+42);
   if(p+46+nl+xl+cl>end||u16(p+34)!==0||!nl||flags&0x41||![0,8].includes(method)||size>max||compressed===0xffffffff||local===0xffffffff)throw Error('ZIP 条目不支持或损坏');
   const nameBytes=b.subarray(p+46,p+46+nl),name=new TextDecoder('utf-8',{fatal:true}).decode(nameBytes);
   if(names.has(name)||name.includes('\u0000'))throw Error('ZIP 条目重名或无效');names.add(name);
   total+=size;if(total>max)throw Error('DOCX 解压总大小超过 128 MiB 安全上限');
   if(local+30>centralOffset||u32(local)!==0x04034b50||u16(local+6)!==flags||u16(local+8)!==method)throw Error('ZIP 本地记录损坏');
   const ln=u16(local+26),lx=u16(local+28),start=local+30+ln+lx,stop=start+compressed;
   if(stop>centralOffset||ln!==nl||!nameBytes.every((x,j)=>x===b[local+30+j]))throw Error('ZIP 本地条目与目录不一致');
   if(!(flags&8)&&(u32(local+14)!==crc||u32(local+18)!==compressed||u32(local+22)!==size))throw Error('ZIP 本地大小或 CRC 与目录不一致');
   ranges.push([local,stop]);
   const compressedBytes=b.subarray(start,stop);
   const plain=method===0?compressedBytes:await inflateBounded(compressedBytes,size);
   if(plain.length!==size||crc32(plain)!==crc)throw Error('ZIP 条目 CRC 或长度校验失败');
   if(required.has(name))parts.set(name,plain);
   p+=46+nl+xl+cl;
  }
  if(p!==end)throw Error('ZIP 目录长度不符');ranges.sort((a,b)=>a[0]-b[0]);for(let i=1;i<ranges.length;i++)if(ranges[i][0]<ranges[i-1][1])throw Error('ZIP 条目重叠');
  for(const name of required)if(!parts.has(name)||!parts.get(name).length)throw Error('缺少 DOCX 必要部件：'+name);
  // In the browser additionally require well-formed XML in the mandatory parts.
  if(typeof DOMParser==='function'){
   const roots={'[Content_Types].xml':'Types','_rels/.rels':'Relationships','word/document.xml':'document'};
   for(const [name,bytes] of parts){const text=new TextDecoder().decode(bytes);if(/<!DOCTYPE/i.test(text))throw Error('DOCX XML 含不支持的 DTD');const doc=new DOMParser().parseFromString(text,'application/xml');if(doc.getElementsByTagName('parsererror').length||doc.documentElement?.localName!==roots[name])throw Error('DOCX XML 结构无效：'+name);}
  }
  return {ok:true,kind,format:'docx',entries:count,method:'zip-directory+all-entry-crc32+required-ooxml-parts'+(typeof DOMParser==='function'?'+xml-parse':'')};
 }catch(e){return {ok:false,kind:'invalid',format:'docx',reason:String(e?.message||e).slice(0,200)};}
}
export async function validateOutlookAttachment(blob,meta){
 if(isDocxAttachment(meta.type,meta.name))return validateDocxAttachment(blob);
 if(imageFormat(meta.type,meta.name))return validateImageAttachment(blob,meta);
 return null;
}
