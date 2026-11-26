let db;
export async function open(){if(db)return db;db=await new Promise((ok,no)=>{const r=indexedDB.open('HelloTodo',1);r.onupgradeneeded=()=>{r.result.createObjectStore('data');r.result.createObjectStore('files');};r.onsuccess=()=>ok(r.result);r.onerror=()=>no(r.error);});return db;}
async function tx(store,mode,fn){const d=await open();return new Promise((ok,no)=>{const t=d.transaction(store,mode),r=fn(t.objectStore(store));t.oncomplete=()=>ok(r.result);t.onerror=()=>no(t.error);t.onabort=()=>no(t.error);});}
export const read=key=>tx('data','readonly',s=>s.get(key));
export const write=(key,val)=>tx('data','readwrite',s=>s.put(val,key));
export const fileGet=id=>tx('files','readonly',s=>s.get(id));
export const filePut=(id,blob)=>tx('files','readwrite',s=>s.put(blob,id));
