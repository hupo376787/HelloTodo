import {test} from 'node:test';
import assert from 'node:assert/strict';
import {recoverOutlookBatch} from '../web/outlook-batch.mjs';

const task=(id,title)=>({id,data:{title}});

test('Outlook batch recovers every missing attachment across pending tasks and skips existing files',async()=>{
 const tasks=[task('t1','任务一'),task('t2','任务二')],statuses=new Map(),saved=[],downloads=[],progress=[];
 const manifests={t1:[{id:'a1',name:'one.jpg'},{id:'a2',name:'two.zip'}],t2:[{id:'b1',name:'three.pdf'}]};
 const result=await recoverOutlookBatch({
  tasks,
  resolveTarget:async t=>({folderId:'folder-'+t.id,taskId:'source-'+t.id,localTaskId:t.id}),
  listAttachments:async t=>({attachments:manifests[t.id]}),
  hasSavedAttachment:async(t,f)=>t.id==='t1'&&f.id==='a1'?{saved:true,reviewRequired:false}:{saved:false},
  downloadAttachment:async(t,target,f)=>{downloads.push(t.id+':'+f.id);return {blob:new Blob([f.id]),meta:{id:f.id},reviewRequired:false};},
  saveAttachment:async(t,target,f,d)=>saved.push(t.id+':'+f.id),
  setTaskStatus:async(t,status,errors)=>statuses.set(t.id,{status,errors}),
  onProgress:(summary,current)=>progress.push(current.taskIndex)
 });
 assert.deepEqual(downloads,['t1:a2','t2:b1']);assert.deepEqual(saved,['t1:a2','t2:b1']);
 assert.equal(result.tasksCompleted,2);assert.equal(result.tasksPending,0);assert.equal(result.attachmentsTotal,3);assert.equal(result.downloaded,2);assert.equal(result.skipped,1);assert.equal(result.failed,0);
 assert.equal(statuses.get('t1').status,'complete');assert.equal(statuses.get('t2').status,'complete');assert.deepEqual(progress,[1,2]);
});

test('Outlook batch continues after one attachment fails and keeps the task pending',async()=>{
 const tasks=[task('t1','任务一'),task('t2','任务二')],statuses=new Map();
 const result=await recoverOutlookBatch({
  tasks,
  resolveTarget:async t=>({folderId:'f',taskId:t.id,localTaskId:t.id}),
  listAttachments:async t=>({attachments:t.id==='t1'?[{id:'bad',name:'bad.docx'},{id:'good',name:'good.jpg'}]:[{id:'ok',name:'ok.pdf'}]}),
  hasSavedAttachment:async()=>({saved:false}),
  downloadAttachment:async(_t,_target,f)=>{if(f.id==='bad')throw Error('上游 502');return {blob:new Blob(['ok']),meta:{id:f.id},reviewRequired:f.id==='good',reviewMessage:'图片或文件需要核对'};},
  saveAttachment:async()=>{},
  setTaskStatus:async(t,status,errors)=>statuses.set(t.id,{status,errors})
 });
 assert.equal(result.downloaded,2);assert.equal(result.failed,1);assert.equal(result.needsReview,1);assert.equal(result.tasksCompleted,1);assert.equal(result.tasksPending,1);
 assert.equal(statuses.get('t1').status,'pending');assert.match(statuses.get('t1').errors[0].message,/上游 502/);assert.equal(statuses.get('t2').status,'complete');
});

test('Outlook batch marks tasks with missing source IDs pending and enforces a per-run task cap',async()=>{
 const tasks=[task('t1','缺 ID'),task('t2','超出批次')],statuses=new Map();
 const result=await recoverOutlookBatch({
  tasks,maxTasks:1,
  resolveTarget:async()=>null,
  listAttachments:async()=>({attachments:[]}),hasSavedAttachment:async()=>({saved:false}),downloadAttachment:async()=>{},saveAttachment:async()=>{},
  setTaskStatus:async(t,status,errors)=>statuses.set(t.id,{status,errors})
 });
 assert.equal(result.tasksScanned,1);assert.equal(result.tasksPending,1);assert.equal(result.tasksNotProcessed,1);assert.equal(statuses.get('t1').status,'pending');assert.match(statuses.get('t1').errors[0].message,/缺少 Microsoft/);
});

 test('Microsoft To Do settings exposes exactly the two requested migration actions',async()=>{
  const {readFile}=await import('node:fs/promises');
  const source=await readFile(new URL('../web/app.mjs',import.meta.url),'utf8');
  const start=source.indexOf('function settings()');
  const end=source.indexOf('\n\nasync function authorizeOutlookOnly',start);
  const settings=source.slice(start,end);
  assert.match(settings,/btn\('Microsoft 登录并授权导入'/);
  assert.match(settings,/btn\('仅重试待补齐附件'/);
  for(const removed of ['单独授权 Outlook','测试 Outlook 原始附件接口','备用 Beta 接口重试','查看待补齐任务','导出 Outlook 附件恢复清单','导入 Outlook 恢复包','导入微软 To Do HAR'])assert.doesNotMatch(settings,new RegExp(removed));
 });

test('index scans each distinct folder once, matches exact IDs and finds a task in a different folder',async()=>{
 const {indexOutlookTasks}=await import('../web/outlook-batch.mjs');const tasks=[{id:'a',data:{source:'task_1==',title:'same',folder:'f_1=='}},{id:'b',data:{source:'task_2==',title:'same',folder:'f_1=='}},{id:'c',data:{source:'task_3==',title:'missing',folder:'f_2=='}}];const calls=[];
 const result=await indexOutlookTasks({tasks,folderIds:['f+1==','f_2=='],preferredFolder:t=>t.data.folder,fetchFolder:async(folder,ids)=>{calls.push({folder,ids});return {pages:2,rowsRead:100,deltaPages:1,manifests:[{taskId:folder==='f_1=='?'task+1==':'task+2==',attachments:[{id:'file'}]}]};}});
 assert.deepEqual(calls.map(x=>x.folder),['f_1==','f_2==']);assert.deepEqual(calls[1].ids,['task_2==','task_3==']);assert.equal(result.byTask.get('b').target.folderId,'f_2==');assert.equal(result.byTask.has('c'),false);assert.equal(result.pages,4);assert.equal(result.deltaPages,2);
});
test('batch report retains successful task IDs and attachment names for direct navigation',async()=>{
 const t=task('t1','done');const result=await recoverOutlookBatch({tasks:[t],resolveTarget:async()=>({folderId:'f',taskId:'s',localTaskId:'t1'}),listAttachments:async()=>({attachments:[{id:'a',name:'one.txt'}]}),hasSavedAttachment:async()=>({saved:true}),downloadAttachment:async()=>{throw Error('should not download');},saveAttachment:async()=>{},setTaskStatus:async()=>{}});assert.deepEqual(result.completedTasks,[{taskId:'t1',taskTitle:'done',attachmentCount:1,attachments:[{id:'a',name:'one.txt'}]}]);assert.equal(result.skipped,1);
});

test('attachment navigation and report include dedicated ready/pending views and open completed groups',async()=>{
 const {readFile}=await import('node:fs/promises');const app=await readFile(new URL('../web/app.mjs',import.meta.url),'utf8');for(const id of ['attachments','attachments-ready','attachments-pending'])assert.match(app,new RegExp("\\['"+id+"'"));assert.match(app,/ds\.open=.*C\.isAttachmentView\(view\)/);assert.match(app,/查看已补齐附件/);assert.match(app,/查看待补齐附件/);assert.match(app,/本次已补齐任务（点击查看附件）/);
});
