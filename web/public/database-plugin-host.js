/* Liyuan host adapter. The upstream database script is loaded unchanged from a verified private cache. */
const nativeFetch=window.fetch.bind(window);
let data=null,ctx=null,books={},revision=0,saving=Promise.resolve(),upstreamReady=false;
const listeners=new Map(),phaseErrors=[];let generationCapture=null,generationPurpose='fill';let readonlyBooks={};
const parentWindow=window.parent;
// Presentation is opt-in: the server's background browser must not open a management window.
const managerMode=new URLSearchParams(location.search).get('view')==='manager';
let pendingSaves=0,saveFailure=null,feedbackTimer,lastSavedState=null;
function feedback(kind,message){
 if(!managerMode)return;
 const text=String(message).slice(0,800),element=document.getElementById('host-feedback');
 clearTimeout(feedbackTimer);element.hidden=false;element.dataset.kind=kind;element.textContent=text;
 parentWindow.postMessage({type:'liyuan-database-feedback',kind,message:text},location.origin);
 if(kind==='success'||kind==='info')feedbackTimer=setTimeout(()=>{element.hidden=true;},8000);
}
function progress(message){if(managerMode){document.getElementById('host-status').textContent=message;parentWindow.postMessage({type:'liyuan-database-progress',message},location.origin);}}
document.documentElement.dataset.view=managerMode?'manager':'runtime';
if(parentWindow!==window)document.getElementById('host-home').hidden=true;
function reportHostError(error){
 const message=error instanceof Error?error.message:String(error);
 document.getElementById('host-status').textContent='数据库插件加载失败：'+message;
 document.getElementById('host-retry').hidden=false;
 phaseErrors.push(message);
 parentWindow.postMessage({type:'liyuan-database-error',message},location.origin);
}
async function openManager(){
 const api=window.AutoCardUpdaterV2API;
 const opened=typeof api?.open==='function'?await api.open():await window.AutoCardUpdaterAPI?.openSettings?.();
 if(opened!==true)throw new Error('原数据库管理界面未能打开，请重新加载');
 return true;
}
document.getElementById('host-open').addEventListener('click',()=>{void openManager().catch(reportHostError)});
async function openTables(){
 const api=window.AutoCardUpdaterV2API?.openVisualizer?window.AutoCardUpdaterV2API:window.AutoCardUpdaterAPI;
 if(typeof api?.openVisualizer!=='function'||await api.openVisualizer()!==true)throw new Error('原实时表格未能打开，请等待插件就绪后重试');
 return true;
}
document.getElementById('host-tables').addEventListener('click',()=>{void openTables().catch(error=>feedback('error',error.message));});
document.getElementById('host-sync').addEventListener('click',()=>{void window.LiyuanDatabasePluginHost.refreshTables().catch(error=>feedback('error',error.message));});
document.getElementById('host-retry').addEventListener('click',()=>location.reload());
// Run the unchanged userscript against this isolated host, not the React application's globals.
Object.defineProperty(window,'parent',{configurable:true,value:window});
const plain=x=>JSON.parse(JSON.stringify(x));
// Upstream caches references to settings namespaces. Synchronize their contents,
// rather than detaching the objects that its later saves still write into.
function syncSettings(target,next){
 for(const key of Object.keys(target))if(!Object.hasOwn(next,key))delete target[key];
 for(const [key,value]of Object.entries(next)){
  if(value&&typeof value==='object'&&!Array.isArray(value)&&target[key]&&typeof target[key]==='object'&&!Array.isArray(target[key]))syncSettings(target[key],value);
  else target[key]=plain(value);
 }
}
async function request(path,body){
 const options=body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({...body,scopeKey:data.scopeKey,sourceEntryId:data.sourceEntryId})};
 try{
  const response=await nativeFetch('/api/database-plugin'+path,options),value=await response.json();
  if(!response.ok)throw new Error(value.error||'数据库宿主请求失败');
  return value;
 }catch(error){phaseErrors.push(String(error.message||error).slice(0,300));throw error;}
}
function state(){const messages={};for(const m of ctx.chat){const id=m.__liyuanEntryId;if(!id)continue;messages[id]=Object.fromEntries(Object.entries(m).filter(([k])=>/^TavernDB_[A-Za-z0-9_]+$/.test(k)));}return {messages,chatMetadata:ctx.chatMetadata,extensionSettings:ctx.extensionSettings,worldbooks:books};}
function save(){
 pendingSaves++;feedback('pending','正在保存数据库更改…');
 // Keep failures observable to the caller/flush, without poisoning all later saves.
 const task=saving.then(async()=>{const snapshot=state(),serialized=JSON.stringify(snapshot);if(serialized===lastSavedState)return {globalRevision:revision};const response=await request('/state',{revision,state:snapshot});revision=response.globalRevision;lastSavedState=serialized;saveFailure=null;return response;});
 saving=task.then(()=>{},()=>{});
 return task.then(response=>{pendingSaves--;if(!pendingSaves)feedback('success','数据库更改已保存 · 版本 '+response.globalRevision);return response;},error=>{pendingSaves--;saveFailure=error;feedback('error','数据库保存失败：'+error.message+'。更改未确认保存，请保留草稿；冲突时需重新加载。');throw error;});
}
const eventNames=['GENERATION_STARTED','GENERATION_STOPPED','GENERATION_ENDED','GENERATION_AFTER_COMMANDS','MESSAGE_SENT','MESSAGE_RECEIVED','CHAT_CHANGED','MESSAGE_DELETED','MESSAGE_SWIPED','MESSAGE_UPDATED','CHARACTER_MESSAGE_RENDERED','USER_MESSAGE_RENDERED','CHARACTER_EDITED','CHARACTER_DELETED','SETTINGS_LOADED','EXTENSION_SETTINGS_LOADED'];
const eventSource={on:(name,fn)=>{const a=listeners.get(name)||[];a.push(fn);listeners.set(name,a);return()=>eventSource.off(name,fn)},makeFirst:(name,fn)=>{const a=listeners.get(name)||[];a.unshift(fn);listeners.set(name,a)},off:(name,fn)=>listeners.set(name,(listeners.get(name)||[]).filter(f=>f!==fn)),removeListener:(name,fn)=>eventSource.off(name,fn),once:(name,fn)=>{const wrap=(...args)=>{eventSource.off(name,wrap);return fn(...args)};eventSource.on(name,wrap)},emit:async(name,...args)=>{for(const fn of [...listeners.get(name)||[]])await fn(...args)},emitAndWait:async(name,...args)=>eventSource.emit(name,...args)};
function getEntries(name){const book=books[name]??readonlyBooks[name];if(!book)throw new Error('未绑定的数据库世界书');return book.entries;}
const bookRead=async name=>plain(getEntries(name));
async function bookSet(name,entries){if(readonlyBooks[name])throw new Error("原卡与挂载世界书在数据库宿主中只读");const all=getEntries(name);for(const patch of entries){const entry=all.find(e=>e.uid===patch.uid);if(!entry)throw new Error('世界书条目已变化');Object.assign(entry,plain(patch));}await save();}
async function bookCreate(name,entries){if(readonlyBooks[name])throw new Error("数据库不得改写原卡世界书");const all=getEntries(name),ids=[];for(const entry of entries){const uid=all.reduce((n,e)=>Math.max(n,Number(e.uid)||0),0)+1;all.push({...plain(entry),uid});ids.push(uid);}await save();return ids;}
const bookNames=()=>({primary:data.primaryBook,additional:(data.characterBookNames??[]).filter(name=>Object.hasOwn(readonlyBooks,name))});
async function generateRaw(params){const prompts=(params.ordered_prompts||params.messages||[]).map(p=>({role:String(p.role||'user').toLowerCase(),content:String(p.content??'')}));return (await request('/generate',{prompts,purpose:generationPurpose})).text;}
window.fetch=async(input,init={})=>{const address=typeof input==='string'?input:input instanceof URL?input.toString():input.url;const url=new URL(address,location.href);let payload={};try{payload=JSON.parse(init.body||'{}')}catch{};
 if(url.origin!==location.origin&&String(init.method||'GET').toUpperCase()==='POST'){const r=await request('/external',{url:url.href,payload});return new Response(JSON.stringify(r),{status:200,headers:{'content-type':'application/json'}});}
 if(url.origin===location.origin){
  if(url.pathname==='/api/backends/chat-completions/status'||url.pathname==='/api/backends/chat-completions/generate'){
   const path=url.pathname.endsWith('/status')?'/completion-status':'/completion';
   try{
    const response=await nativeFetch('/api/database-plugin'+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({scopeKey:data.scopeKey,sourceEntryId:data.sourceEntryId,payload}),signal:init.signal});
    if(!response.ok){const error=await response.clone().json().catch(()=>({}));phaseErrors.push(String(error.error||'数据库模型请求失败（HTTP '+response.status+'）').slice(0,300));}
    return response;
   }catch(error){phaseErrors.push(String(error.message||error).slice(0,300));throw error;}
  }
  if(url.pathname==='/api/database-plugin/embeddings'){const r=await request('/embeddings',payload);return new Response(JSON.stringify(r),{status:200,headers:{'content-type':'application/json'}});}
  if(url.pathname==='/api/files/upload'){const r=await request('/files/upload',payload);return new Response(JSON.stringify({path:'user/files/'+payload.name}),{status:200,headers:{'content-type':'application/json'}});}
  if(url.pathname==='/api/files/delete'){const r=await request('/files/delete',{name:payload.path});return new Response(JSON.stringify(r),{status:200,headers:{'content-type':'application/json'}});}
  if(url.pathname.startsWith('/user/files/'))return nativeFetch('/api/database-plugin/file?scopeKey='+encodeURIComponent(data.scopeKey)+'&name='+encodeURIComponent(url.pathname.slice('/user/files/'.length)),init);
  if(url.pathname==='/api/chats/get'||url.pathname==='/api/chats/group/get'){const list=await request('/native-chat');return new Response(JSON.stringify(plain(list)),{status:200,headers:{'content-type':'application/json'}});}
  if(url.pathname==='/api/characters/chats')return new Response(JSON.stringify([{file_name:ctx.chatId+'.jsonl',chat_items:ctx.chat.length}]),{status:200,headers:{'content-type':'application/json'}});
 }
 return nativeFetch(input,init);
};
function installContext(next){data=next;revision=next.revision;books=next.worldbooks;readonlyBooks=next.readonlyBooks??{};ctx={chat:plain(next.chat),chatId:next.scope.sessionId,characterId:0,groupId:null,name1:next.userName,name2:String(next.character.name||'角色'),characters:[{...next.character,avatar:'liyuan-card',chat:next.scope.sessionId,data:next.character}],groups:[],chatMetadata:plain(next.chatMetadata),extensionSettings:plain(next.extensionSettings),eventSource,eventTypes:Object.fromEntries(eventNames.map(n=>[n,n])),mainApi:'openai',main_api:'openai',onlineStatus:'ok',saveChat:save,saveMetadata:save,saveSettingsDebounced:()=>{void save().catch(()=>{})},updateChatMetadata:(patch)=>{Object.assign(ctx.chatMetadata,patch);return save()},getRequestHeaders:()=>({'content-type':'application/json'}),getCurrentChatId:()=>ctx.chatId,stopGeneration:()=>eventSource.emit('GENERATION_STOPPED'),updateMessageBlock:()=>{},setExtensionPrompt:()=>{},getTokenCount:text=>Math.ceil(String(text).length/2),substituteParams:text=>text,generate:async()=>''};
 const settingsRoot=ctx.extensionSettings.__userscripts??={};const namespace=settingsRoot.shujuku_v120__userscript_settings_v1??={};
 const metaKey='shujuku_v120_globalMeta_v1';let globalMeta;try{globalMeta=JSON.parse(namespace[metaKey]||'null')}catch{}
 if(!globalMeta){globalMeta={version:1,activeIsolationCode:'',isolationCodeList:[],migratedLegacySingleStore:true,zeroTkOccupyModeGlobal:true,summaryVectorIndexModeGlobal:next.embeddingConfigured===true,plotEnabledGlobal:true,formFillPreferencesGlobal:{schemaVersion:1,selectedMode:next.embeddingConfigured?'crossfire':'classic'},vectorMemoryConfigGlobal:{enabled:next.embeddingConfigured===true,embeddingEndpoint:location.origin+'/api/database-plugin/embeddings',embeddingApiKey:'host-managed',embeddingModel:next.embeddingModel||'host-managed',keywordApiPreset:''}};}

 // Refer to enabled Liyuan connections, without copying API credentials into browser settings.
 const managed=next.managedModels;
 if(managed?.presets?.length){
  const code=String(globalMeta.activeIsolationCode||'').trim(),slot=code?encodeURIComponent(code):'__default__';
  const profileKey='shujuku_v120_profile_v1__'+slot+'__settings';let profile={};
  try{profile=JSON.parse(namespace[profileKey]||'{}')}catch{}
  const makePreset=p=>({name:p.name,apiMode:'custom',apiConfig:{url:new URL(p.url,location.origin).href,apiKey:'host-managed',model:p.model,max_tokens:p.maxTokens,maxTokens:p.maxTokens,temperature:1},tavernProfile:''});
  const presets=managed.presets.map(makePreset),names=new Set(presets.map(p=>p.name));
  profile.apiPresets=[...(Array.isArray(profile.apiPresets)?profile.apiPresets:[]).filter(p=>!names.has(p.name)),...presets];
  if(profile.__liyuanModelBindingRevision!==managed.revision){
   const fill=managed.presets.find(p=>p.purpose==='fill'),recall=managed.presets.find(p=>p.purpose==='recall');
   if(fill){profile.tableApiPreset=fill.name;profile.tableApiPresetOverridesByName=Object.fromEntries(Object.keys(profile.tableApiPresetOverridesByName||{}).map(key=>[key,fill.name]));profile.defaultApiPresetName=fill.name;profile.apiMode='custom';profile.apiConfig=makePreset(fill).apiConfig;profile.apiPresetBindingsByChat={...(profile.apiPresetBindingsByChat||{}),[ctx.chatId]:{presetName:fill.name,updatedAt:Date.now()}};}
   if(recall){globalMeta.vectorMemoryConfigGlobal??={};globalMeta.vectorMemoryConfigGlobal.keywordApiPreset=recall.name;}
   profile.__liyuanModelBindingRevision=managed.revision;
  }
  // One-time correction of the old host's forced-off native recall hook.
  // Keep every original task, prompt/template and subsequent user choice.
  if(profile.__liyuanNativeRecallBridgeVersion!==1){
   const recall=managed.presets.find(p=>p.purpose==='recall');
   if(recall)profile.plotApiPreset=recall.name;
   profile.__liyuanNativeRecallBridgeVersion=1;
  }
  profile.dataIsolationCode=code;namespace[profileKey]=JSON.stringify(profile);
 }
 if(globalMeta.__liyuanNativeRecallBridgeVersion!==1){globalMeta.plotEnabledGlobal=true;globalMeta.__liyuanNativeRecallBridgeVersion=1;}
 // Native plot tasks include the original recall/writeback pipeline; do not
 // confuse it with independent story generation or force its switch off.
 namespace[metaKey]=JSON.stringify(globalMeta);
 const scoped=ctx.chatMetadata.TavernDB_ACU_ScopedConfig??={version:1};
 if(!scoped.fillModeByIsolationKey?.['']){scoped.fillModeByIsolationKey={...(scoped.fillModeByIsolationKey??{}),'':{mode:globalMeta.formFillPreferencesGlobal?.selectedMode??'classic',recordedAt:Date.now()}};ctx.chatMetadata.TavernDB_ACU_ScopedConfig__chatId=ctx.chatId;}

window.SillyTavern={getContext:()=>ctx};window.getContext=()=>ctx;window.getRequestHeaders=ctx.getRequestHeaders;window.saveSettingsDebounced=ctx.saveSettingsDebounced;
 window.TavernHelper={getChatMessages:async range=>ctx.chat.map((m,i)=>({...plain(m),role:m.is_user?'user':'assistant',message:m.mes,message_id:i})),getLastMessageId:()=>ctx.chat.length-1,getCurrentCharPrimaryLorebook:async()=>data.primaryBook,getCharWorldbookNames:bookNames,getGlobalWorldbookNames:()=>[...(data.globalBookNames??[])],getCharLorebooks:async()=>bookNames(),getLorebooks:async()=>[...Object.keys(books),...Object.keys(readonlyBooks)],getWorldbookNames:async()=>[...Object.keys(books),...Object.keys(readonlyBooks)],getLorebookEntries:bookRead,getWorldbook:bookRead,setLorebookEntries:bookSet,replaceWorldbook:async(name,entries)=>{if(readonlyBooks[name])throw new Error('原世界书只读');getEntries(name);books[name].entries=plain(entries);await save()},createLorebookEntries:bookCreate,deleteLorebookEntries:async(name,ids)=>{if(readonlyBooks[name])throw new Error('原世界书只读');books[name].entries=getEntries(name).filter(e=>!ids.includes(e.uid));await save()},getVariables:()=>({}),replaceVariables:()=>{},getAllVariables:()=>({}),generateRaw,generate:async params=>{generationCapture={userInput:String(params?.user_input??params?.prompt??params?.injects?.[0]?.content??'')};return '';},stopAllGeneration:ctx.stopGeneration,triggerSlash:async command=>{if(!/^\/(?:echo|flushvar|setvar|addvar)\b/.test(command))throw new Error('插件不得使用斜杠指令改写梨园正文');return ''},getTavernHelperVersion:()=> '4.0.0',setChatMessages:async messages=>{for(const patch of messages){const current=ctx.chat[patch.message_id];if(!current)throw new Error('楼层不在当前分支');for(const [key,value]of Object.entries(patch.data??patch))if(/^TavernDB_/.test(key))current[key]=plain(value);}await save()}};
  window.ACU_SQL_WASM_URL_ACU=location.origin+'/api/database-plugin/vendor/';window.toastr={success:message=>feedback('info',message),info:message=>feedback('info',message),warning:message=>{phaseErrors.push(String(message).slice(0,300));feedback('warning',message);},error:message=>{phaseErrors.push(String(message).slice(0,300));feedback('error',message);},clear:()=>{},options:{}};
}
async function loadScript(src){
 await new Promise((resolve,reject)=>{
  const script=document.createElement('script');
  const timer=setTimeout(()=>{script.remove();reject(new Error('插件依赖加载超时，请重新加载：'+src));},45000);
  script.src=src;
  script.onload=()=>{clearTimeout(timer);resolve();};
  script.onerror=()=>{clearTimeout(timer);reject(new Error('插件依赖加载失败：'+src));};
  document.head.append(script);
 });
}
window.LiyuanDatabasePluginHost={
 ready:()=>upstreamReady,
 binding:()=>data?{scopeKey:data.scopeKey,sourceEntryId:data.sourceEntryId}:null,
 errors:()=>[...phaseErrors],
  async flush(){await saving;if(saveFailure)throw saveFailure;return true;},
  openTables,
  async refreshTables(){if(pendingSaves)throw new Error('正在保存，请等待保存完成再刷新');const api=window.AutoCardUpdaterV2API;if(typeof api?.refreshVisualizer!=='function')throw new Error('原实时表格刷新接口不可用，请重新加载管理台');feedback('pending','正在读取已保存的实时表格…');await this.sync();await api.refreshVisualizer();await this.flush();feedback('info','实时表格已刷新；未保存的编辑草稿由原插件冲突保护处理');return true;},
 diagnostics:()=>({listeners:[...listeners.keys()],metadata:ctx.chatMetadata}),
   async sync(){await this.flush();const next=await request('/context');if(next.scopeKey!==data.scopeKey||next.sourceEntryId!==data.sourceEntryId)throw new Error('插件会话/分支需重新载入');const oldLength=ctx.chat.length;ctx.chat.splice(0,ctx.chat.length,...plain(next.chat));syncSettings(ctx.chatMetadata,plain(next.chatMetadata));syncSettings(ctx.extensionSettings,next.extensionSettings);books=next.worldbooks;readonlyBooks=next.readonlyBooks??{};data=next;revision=next.revision;lastSavedState=null;await window.AutoCardUpdaterAPI?.refreshDataAndWorldbook?.();return {previousLength:oldLength,currentLength:ctx.chat.length};},
 async before(userText){phaseErrors.length=0;await this.sync();generationCapture=null;generationPurpose='recall';
  document.getElementById('send_textarea').value=userText;
  try{document.getElementById('send_but').dispatchEvent(new Event('click',{bubbles:true}));await eventSource.emit('MESSAGE_SENT',ctx.chat.length-1);await eventSource.emit('GENERATION_STARTED','normal',{automatic_trigger:false},false);
   // The unchanged plugin wraps this function. Capture the actual writeback,
   // not our own reimplementation of its template or AM selection.
    await window.TavernHelper.generate({user_input:userText,automatic_trigger:false});await this.flush();
   if(!generationCapture){const detail=[...new Set(phaseErrors)].slice(-3).join('；');throw new Error('原数据库插件未完成发送前处理；本轮尚未交给正文模型'+(detail?'。原因：'+detail:''));}
   return {sourceEntryId:data.sourceEntryId,userInput:generationCapture.userInput,errors:[...phaseErrors]};
  }finally{generationPurpose='fill';document.getElementById('send_textarea').value='';}
 },
   async after(){
    phaseErrors.length=0;await this.sync();const api=window.AutoCardUpdaterAPI;
    if(!api?.triggerUpdate)throw new Error('数据库未完成启动');
    if(!Object.keys(api.exportTableAsJson()??{}).some(k=>k.startsWith('sheet_'))){const initialized=await api.restoreTableAsJson(JSON.stringify(api.getTableTemplate()));if(!initialized)throw new Error('原插件表结构初始化失败');}
    const current=ctx.chat.at(-1);
    const presentFrame=Object.values(current?.TavernDB_ACU_IsolatedData??{}).some(v=>v?.storageFrame?.checkpoint||v?.storageFrame?.logEntries?.length);
    if(!presentFrame){
     // The pinned upstream event schedules its async pipeline after 500ms.
     // Join that callback: emit() alone ends before filling, and triggerUpdate()
     // uses legacy standard mode, which excludes chronicle/summary sheets.
     const scheduled=[],setTimer=window.setTimeout,previousSpans=new Set(api.getRecentPerformanceSpans().map(s=>s.id));
     window.setTimeout=(callback,delay,...args)=>{
      if(delay!==500)return setTimer.call(window,callback,delay,...args);
      let resolve,reject;scheduled.push(new Promise((yes,no)=>{resolve=yes;reject=no;}));
      return setTimer.call(window,()=>{Promise.resolve().then(()=>callback(...args)).then(resolve,reject);},delay);
     };
     try{await eventSource.emit('GENERATION_ENDED',ctx.chat.length-1);}finally{window.setTimeout=setTimer;}
     if(scheduled.length!==1)throw new Error('原插件拍后任务未能绑定，填表完成状态未确认');
     await scheduled[0];
     const failed=api.getRecentPerformanceSpans().find(s=>!previousSpans.has(s.id)&&s.name==='auto-update-execute'&&s.metrics?.success===false);
     if(failed)throw new Error('原插件自动分组填表失败，保留待恢复状态');
    }
    await this.flush();await api.refreshDataAndWorldbook?.();await api.syncWorldbookEntries?.();await this.flush();
    return {success:true,sourceEntryId:data.sourceEntryId,errors:[...phaseErrors]};
   },
 tables:()=>window.AutoCardUpdaterAPI?.exportTableAsJson?.()??{},
  async rpc(method,args=[]){const allow=new Set(['openSettings','openVisualizer','exportTableAsJson','getTableTemplate','getUpdateConfigParams','setUpdateConfigParams','getPlotPresetNames','getApiPresets','setZeroTkOccupyMode','executeSqlQuery','queryTableRows']);if(!allow.has(method))throw new Error('未开放的插件管理操作');const value=await window.AutoCardUpdaterAPI[method](...args);await this.flush();return value;}
};
try {
  progress('正在读取当前分支数据与加载 jQuery…');
  const [initial]=await Promise.all([request('/context'),loadScript('/api/database-plugin/vendor/jquery.min.js')]);
 const expected=new URLSearchParams(location.search);
 if(expected.has('scopeKey')&&(expected.get('scopeKey')!==initial.scopeKey||expected.get('sourceEntryId')!==initial.sourceEntryId))throw new Error('会话／卡／分支已变化，请重新加载管理台');
 installContext(initial);
 if(managerMode&&expected.has('hostSource')){
  const binding=await request('/binding');
  if(binding.sha256!==expected.get('hostSource'))throw new Error('插件版本已变化，请重新加载管理台');
 }
  progress('正在加载原数据库脚本，首次加载需传输约 8.7 MB…');
  await loadScript('/api/database-plugin/source/index.js');
  progress('正在初始化原数据库与当前分支表格…');
 let initialized=false;
 for(let attempt=0;attempt<100;attempt++){
  if(window.AutoCardUpdaterAPI?.triggerUpdate&&window.AutoCardUpdaterV2API){
   await eventSource.emit('CHAT_CHANGED',ctx.chatId);
    if(!managerMode){await new Promise(r=>setTimeout(r,1800));await window.AutoCardUpdaterAPI.refreshDataAndWorldbook?.();}
   initialized=true;
   break;
  }
  await new Promise(r=>setTimeout(r,100));
 }
 if(!initialized)throw new Error('原数据库插件未就绪');
 // Script readiness alone is not management UI readiness. Open the unchanged upstream UI first.
  if(managerMode){progress('正在打开原数据库管理界面…');await openManager();if(expected.get('panel')==='tables')await openTables();}
 upstreamReady=true;
  document.getElementById('host-open').disabled=false;
  document.getElementById('host-tables').disabled=false;
  document.getElementById('host-sync').disabled=false;
 document.getElementById('host-status').textContent=managerMode?'原数据库完整管理界面已打开':'原数据库插件已载入';
 parentWindow.postMessage({type:'liyuan-database-ready'},location.origin);
 if(managerMode&&parentWindow===window){
  const baseline=await request('/binding');
  let checking=false;
  setInterval(async()=>{
   if(checking||document.hidden)return;
   checking=true;
   try{
    const next=await request('/binding');
    if(next.scopeKey!==baseline.scopeKey||next.sourceEntryId!==baseline.sourceEntryId||next.sha256!==baseline.sha256||next.modelRevision!==baseline.modelRevision){
     const url=new URL(location.href);
     url.searchParams.set('scopeKey',next.scopeKey);url.searchParams.set('sourceEntryId',next.sourceEntryId);url.searchParams.set('hostSource',next.sha256);
     location.replace(url.href);
    }
   }catch(error){reportHostError(error);}finally{checking=false;}
  },2500);
 }
}catch(error){reportHostError(error);}
