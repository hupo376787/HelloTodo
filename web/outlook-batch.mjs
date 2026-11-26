export async function recoverOutlookBatch({
  tasks,
  resolveTarget,
  listAttachments,
  hasSavedAttachment,
  downloadAttachment,
  saveAttachment,
  setTaskStatus,
  onProgress = () => {},
  maxTasks = 200
}) {
  const rows = Array.isArray(tasks) ? tasks : [];
  const limit = Math.max(0, Math.min(rows.length, Number.isSafeInteger(maxTasks) ? maxTasks : 200));
  const summary = {
    tasksTotal: rows.length,
    tasksScanned: 0,
    tasksCompleted: 0,
    tasksPending: 0,
    tasksNotProcessed: rows.length - limit,
    attachmentsTotal: 0,
    downloaded: 0,
    skipped: 0,
    failed: 0,
    needsReview: 0,
    errors: [],
    completedTasks: []
  };

  for (let taskIndex = 0; taskIndex < limit; taskIndex++) {
    const task = rows[taskIndex];
    const taskTitle = String(task?.data?.title || task?.title || '未命名任务');
    const taskErrors = [];
    const reviewItems = [];
    summary.tasksScanned++;
    try {
      const target = await resolveTarget(task);
      if (!target?.folderId || !target?.taskId || !target?.localTaskId) {
        throw Error('缺少 Microsoft 原始清单或任务 ID');
      }
      const manifest = await listAttachments(task, target);
      const attachments = Array.isArray(manifest?.attachments) ? manifest.attachments : [];
      if (!attachments.length) throw Error('Outlook 没有返回可恢复的原始附件');
      summary.attachmentsTotal += attachments.length;

      for (const file of attachments) {
        const fileName = String(file?.name || '未命名附件');
        try {
          const existing = await hasSavedAttachment(task, file);
          if (existing?.saved) {
            summary.skipped++;
            if (existing.reviewRequired) {
              summary.needsReview++;
              reviewItems.push(`${fileName}：${existing.message || '已有文件仍需人工核对'}`);
            }
            continue;
          }
          const downloaded = await downloadAttachment(task, target, file);
          if (!downloaded?.blob || !downloaded?.meta) throw Error('下载接口没有返回有效附件');
          if (String(downloaded.meta.id) !== String(file.id)) throw Error('下载返回的附件 ID 与清单不一致');
          await saveAttachment(task, target, file, downloaded);
          summary.downloaded++;
          if (downloaded.reviewRequired) {
            summary.needsReview++;
            reviewItems.push(`${fileName}：${downloaded.reviewMessage || '已保存，但文件格式或大小元数据需要人工核对'}`);
          }
        } catch (error) {
          summary.failed++;
          taskErrors.push(`${fileName}：${String(error?.message || error).slice(0, 1200)}`);
        }
      }

      if (taskErrors.length || reviewItems.length) {
        const messages = [...taskErrors, ...reviewItems];
        await setTaskStatus(task, 'pending', messages.map(message => ({ stage: 'Outlook 批量补齐', message })));
        summary.tasksPending++;
        summary.errors.push({ taskTitle, messages });
      } else {
        await setTaskStatus(task, 'complete', []);
        summary.tasksCompleted++;
        summary.completedTasks.push({taskId:task.id,taskTitle,attachmentCount:attachments.length,attachments:attachments.map(f=>({id:f.id,name:f.name}))});
      }
    } catch (error) {
      const message = String(error?.message || error).slice(0, 400);
      await setTaskStatus(task, 'pending', [{ stage: 'Outlook 批量补齐', message }]);
      summary.tasksPending++;
      summary.errors.push({ taskTitle, messages: [message] });
    }

    onProgress(summary, { taskIndex: taskIndex + 1, taskCount: limit, taskTitle });
  }

  if (summary.tasksNotProcessed) {
    summary.errors.push({
      taskTitle: '其余待补齐任务',
      messages: [`本次安全上限为 ${limit} 个任务，剩余 ${summary.tasksNotProcessed} 个尚未处理。`]
    });
  }
  return summary;
}

// Read each known folder once, matching exact source IDs only. Prefer original folders,
// then scan remaining known folders for tasks moved since the original Graph import.
const validOutlookId=v=>typeof v==='string'&&v.length<=1024&&/^[-_A-Za-z0-9+/]+={0,2}$/.test(v);
export const canonicalOutlookId=v=>typeof v==='string'?v.replaceAll('+','_').replaceAll('/','-'):'';
export async function indexOutlookTasks({tasks,folderIds,preferredFolder,fetchFolder,onProgress=()=>{},maxTasks=200}){
 const rows=tasks.slice(0,maxTasks),wanted=new Map(),found=new Map(),errors=[],seen=new Set();
 for(const task of rows){const id=validOutlookId(task.data?.source)?canonicalOutlookId(task.data.source):'';if(id){if(!wanted.has(id))wanted.set(id,[]);wanted.get(id).push(task);}}
 const folderMap=new Map();for(const id of [...rows.map(preferredFolder),...folderIds].filter(validOutlookId)){const key=canonicalOutlookId(id);if(!folderMap.has(key))folderMap.set(key,id);}const folders=[...folderMap.values()];
 let pages=0,rowsRead=0,deltaPages=0;
 for(const folderId of folders){const remaining=[...wanted.keys()].filter(id=>!found.has(id));if(!remaining.length)break;
  const key=canonicalOutlookId(folderId);if(seen.has(key))continue;seen.add(key);
  onProgress({foldersScanned:seen.size,foldersTotal:folders.length,matched:found.size,pages,rowsRead,deltaPages});
  try{const result=await fetchFolder(folderId,remaining);pages+=result.pages||0;rowsRead+=result.rowsRead||0;deltaPages+=result.deltaPages||0;
   for(const manifest of result.manifests||[]){const id=canonicalOutlookId(manifest.taskId);if(wanted.has(id)&&!found.has(id)&&manifest.attachments?.length)found.set(id,{folderId,manifest});}
  }catch(e){errors.push(String(e?.message||e).slice(0,400));}
 }
 const byTask=new Map();for(const [id,localTasks] of wanted){const match=found.get(id);if(match&&localTasks.length===1){const task=localTasks[0];byTask.set(task.id,{target:{folderId:match.folderId,taskId:task.data.source,localTaskId:task.id,taskTitle:task.data.title},manifest:match.manifest});}}
 return {byTask,foldersScanned:seen.size,pages,rowsRead,deltaPages,errors};
}

// All attachment types use identical byte-level transport checks. No format decoding.
// Preview.Size is diagnostic only. A local digest detects later changes, not source identity.
export function rawAttachmentAudit(blob,meta={}){
 const size=blob?.size;if(!Number.isSafeInteger(size)||size<0||size>25*1024*1024||!Number.isSafeInteger(meta.size)||meta.size!==size)throw Error('附件实际字节数与下载记录不一致或超过 25 MiB');
 const length=meta.upstreamContentLength==null||meta.upstreamContentLength===''?null:Number(meta.upstreamContentLength);
 const encoding=String(meta.upstreamContentEncoding||'').trim().toLowerCase();
 if(length!==null&&(!Number.isSafeInteger(length)||length<0))throw Error('无效的 HTTP Content-Length');
 if(length!==null&&(!encoding||encoding==='identity')&&length!==size)throw Error('HTTP Content-Length 与实际字节数不一致');
 const expectedSize=Number.isSafeInteger(meta.expectedSize)&&meta.expectedSize>=0?meta.expectedSize:null;
 const sizeMismatch=expectedSize!==null&&expectedSize!==size;
 return {verifiedSize:size,expectedSize,sizeMismatch,sizeStatus:expectedSize===null?'unknown':sizeMismatch?'metadata-differs':'match',upstreamContentLength:length,upstreamContentEncoding:encoding||null,validation:{kind:'raw-bytes',formatVerified:false,sourceIdentityVerified:false}};
}
