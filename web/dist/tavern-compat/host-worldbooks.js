import {installNativeResources} from "./native-resources.js";
import {mvuParsingProjection,mvuParseSource,assertMvuCandidatesSettled,mvuManagedCandidatePayload} from "./mvu-adapter.js";
import {host,eventSource,event_types} from './bridge.js';
import {loadPluginLocales} from './i18n.js';
import {installSettingsUI,ensureManagerWorker} from './settings-ui.js';
const params=new URLSearchParams(location.search),view=params.get('view')??'runtime';document.body.dataset.view=view;
if(view==='manager'&&['helper','template'].includes(params.get('plugin')))document.body.dataset.plugin=params.get('plugin');
const focus=view==='manager'&&params.get('focus')==='mvu'?'mvu':undefined;if(focus)document.body.dataset.focus=focus;
const settingsUI=installSettingsUI({view,plugin:params.get('plugin'),focus});
const status=document.getElementById('status');let ready=false;
host.displayBootstrap=view==='render';
window.hljs={highlightElement:()=>{},highlight:(text)=>({value:text})};
window.addEventListener('unhandledrejection',e=>{host.errors.push(String(e.reason?.message??e.reason));status.textContent='插件错误：'+host.errors.at(-1);});
const nativeFetch=window.fetch.bind(window);
window.fetch=(input,options={})=>{
 const value=typeof input==='string'?input:input instanceof URL?input.href:input.url;
 const url=new URL(value,location.href);
 if(url.origin===location.origin&&!url.pathname.startsWith('/api/tavern-plugins')&&!url.pathname.startsWith('/tavern-compat')&&url.pathname!=='/tavern-plugin-host.html'){
  if(url.pathname==='/version')url.pathname='/api/tavern-plugins/legacy/version';
   else if(url.pathname==='/api/backends/chat-completions/status'){
    url.pathname='/api/tavern-plugins/mvu/models';const data=JSON.parse(options.body??'{}'),headers=new Headers(options.headers);
    headers.set('x-liyuan-tavern-scope',host.context?.scopeKey??'');headers.set('x-liyuan-tavern-source',host.context?.sourceEntryId??'');
    options={...options,headers,body:JSON.stringify({...data,model:host.context?.mvu?.model?.id})};
   }
   else if(url.pathname==='/api/backends/chat-completions/generate'){url.pathname='/api/tavern-plugins/generate';options={...options,body:JSON.stringify(mvuManagedCandidatePayload(JSON.parse(options.body)))};}
  else if(url.pathname.startsWith('/api/'))url.pathname='/api/tavern-plugins/legacy/'+url.pathname.slice(5);
 }
  const candidate=url.pathname==='/api/tavern-plugins/generate'&&host.mvuCandidates?{pending:true,ok:false}:null;
  if(candidate)host.mvuCandidates.push(candidate);
  return nativeFetch(url.href,options).then(async response=>{
   if(candidate){const data=await response.clone().json();candidate.ok=response.ok&&data.candidateOnly===true;if(!candidate.ok)candidate.error=typeof data.error==='string'?data.error:`HTTP ${response.status}`;if(response.ok&&!candidate.ok)throw new Error('Auxiliary model response is not candidate-only');}
   if(url.pathname==='/api/tavern-plugins/legacy/characters/edit'&&response.ok)void response.clone().json().then(data=>{if(typeof data.revision==='number')host.context.revision=data.revision;});return response;
  }).catch(error=>{if(candidate)candidate.error=String(error?.message??error);throw error;}).finally(()=>{if(candidate)candidate.pending=false;});
};
async function generation(packet){
 if(!ready)throw new Error('原插件未就绪');await host.flush();
 await eventSource.emit(event_types.GENERATION_AFTER_COMMANDS,'normal',{},false);
 const messages=[{role:'system',content:packet.systemPrompt,__liyuanIndex:-1},...structuredClone(packet.messages).map((message,index)=>({...message,content:message.content??message.text??'',__liyuanIndex:index}))];
 await eventSource.emit(event_types.GENERATE_AFTER_DATA,{prompt:messages,type:'normal'},false);
 const data={messages,type:'normal'};await eventSource.emit(event_types.CHAT_COMPLETION_SETTINGS_READY,data);
 if(!Array.isArray(data.messages)||data.messages.some(m=>!['system','user','assistant'].includes(m.role)||(typeof m.content!=='string'&&!Array.isArray(m.content))))throw new Error('模板未交付有效消息');
 await host.flush();
 const system=data.messages[0];if(system?.role!=='system'||typeof system.content!=='string')throw new Error('模板移除了主作者系统消息，未发送');
 // Preserve original structured messages (images/thinking/tools) unless their textual field actually changed.
 const result=data.messages.slice(1).map(message=>{
  const original=Number.isInteger(message.__liyuanIndex)&&message.__liyuanIndex>=0?packet.messages[message.__liyuanIndex]:undefined;
  const content=typeof message.content==='string'?[{type:'text',text:message.content}]:message.content;
  if(!original||original.role!==message.role)return {role:message.role,content,timestamp:Date.now()};
  return {...original,content:Array.isArray(original.content)?content:message.content};
 });return {systemPrompt:system.content,messages:result};
}
async function filterWorldbookEntries(packet){
 if(!ready||packet.card!==host.context.card)throw new Error('Worldbook filter binding is stale');
 const entries=packet.worldbookEntries;
 if(!Array.isArray(entries))throw new Error('Worldbook entries are required');
 if(!host.context.mvu?.enabled||!window.Mvu)return {...packet,retainedWorldbookIndices:entries.map((_,i)=>i)};
 const primary=host.characters[0]?.data?.extensions?.world;
 const data={characterLore:[],globalLore:[],personaLore:[],chatLore:[],type:'normal'};
 entries.forEach((entry,index)=>{const world=entry.worldbookName??(entry.source==='card'?primary:entry.source??'overlay');const scope=entry.worldbookScope;const bucket=scope==='chat'?'chatLore':scope==='global'?'globalLore':scope==='character'||scope==='character_aux'||scope==='agent'||entry.source==='card'?'characterLore':'globalLore';data[bucket].push({...structuredClone(entry),world,__liyuanFilterIndex:index});});
 // Only upstream MVU listeners: template/generation hooks must not execute twice.
 const listeners=eventSource.listeners.get(event_types.WORLDINFO_ENTRIES_LOADED)??[];
 if(!listeners.some(listener=>host.nativeMvuWorldbookListeners?.has(listener)))throw new Error('Native MVU worldbook handler is not ready');
 for(const listener of listeners)if(host.nativeMvuWorldbookListeners?.has(listener))await listener(data);
 const retained=[...data.characterLore,...data.globalLore,...data.personaLore,...data.chatLore].map(entry=>entry.__liyuanFilterIndex);
 return {...packet,retainedWorldbookIndices:retained};
}
async function render(){const canonical=host.chat.map(m=>m.mes);host.displayProjection++;try{await eventSource.emit(event_types.CHAT_CHANGED,host.context.sessionId);for(let i=0;i<host.chat.length;i++)await eventSource.emit(host.chat[i].is_user?event_types.USER_MESSAGE_RENDERED:event_types.CHARACTER_MESSAGE_RENDERED,i);await host.flush();}finally{host.chat.forEach((m,i)=>m.mes=canonical[i]);host.displayProjection--;}}
eventSource.makeFirst(event_types.GENERATION_ENDED,()=>{
 if(!host.mvuCandidates)return;
 assertMvuCandidatesSettled(host.mvuCandidates);
 const receipt=host.metadata.__liyuanMvuProcessed?.[host.chat.at(-1)?.__liyuanEntryId];
  const reused=receipt?.nativeRetry===true&&receipt.authorHistoryVersion===2&&['updated','unchanged'].includes(receipt.status);
 // Inherited/schema-default variables and a returned handler are not proof of extra parsing.
 if(host.afterRunning&&host.context.mvu?.enabled&&!reused&&host.extensions.mvu_settings?.更新方式==='额外模型解析'&&host.extensions.mvu_settings.额外模型解析配置?.启用自动请求!==false&&!host.mvuCandidates.some(candidate=>candidate.ok))throw new Error('原MVU自动额外解析未完成受管请求，未标记本回合变量完成');
});
// Pending general settlement must not repeat MVU work already completed by the isolated retry.
const originalEmit=eventSource.emit.bind(eventSource);
host.nativeHelperPromptListeners=new Set();
const originalOn=eventSource.on.bind(eventSource);
eventSource.on=(event,listener)=>{
 const result=originalOn(event,listener);
 // Helper macro registration is deferred; identify its original module, not all later hooks.
 if(event===event_types.CHAT_COMPLETION_SETTINGS_READY&&new Error().stack?.includes('/JS-Slash-Runner/dist/index.js'))host.nativeHelperPromptListeners.add(listener);
 return result;
};
eventSource.emit=async(event,...args)=>{
 if(host.mvuRetryBaseline&&(host.nativeMvuRetryListeners?.has(event)||[event_types.WORLDINFO_ENTRIES_LOADED,event_types.WORLD_INFO_ACTIVATED,event_types.MESSAGE_UPDATED,event_types.CHARACTER_MESSAGE_RENDERED,event_types.USER_MESSAGE_RENDERED].includes(event))){
   for(const listener of [...(eventSource.listeners.get(event)??[])])if(host.nativeMvuListeners?.get(event)?.has(listener)||event===event_types.CHAT_COMPLETION_SETTINGS_READY&&host.nativeHelperPromptListeners?.has(listener))await listener(...args);
  return;
 }
 const id=host.chat.at(-1)?.__liyuanEntryId,receipt=host.metadata.__liyuanMvuProcessed?.[id];
  if(host.afterRunning&&receipt?.nativeRetry===true&&receipt.authorHistoryVersion===2&&['updated','unchanged'].includes(receipt.status)&&host.nativeMvuRetryListeners?.has(event)){
  for(const listener of [...(eventSource.listeners.get(event)??[])])if(!host.nativeMvuRetryListeners.get(event).has(listener))await listener(...args);
  return;
 }
 return originalEmit(event,...args);
};
window.LiyuanTavernPlugins={ready:()=>ready,status:()=>({ready,errors:host.errors,plugins:host.context?.plugins}),before:generation,async after(){const msg=host.chat.at(-1),id=msg?.__liyuanEntryId;host.metadata.__liyuanPluginProcessed??={};if(id&&!host.metadata.__liyuanPluginProcessed[id]){const canonical=msg.mes;try{if(typeof msg.__liyuanAuthorDelivery==='string')msg.mes=mvuParsingProjection(mvuParseSource(msg.__liyuanAuthorDelivery,msg.__liyuanSupplementaryVariables)).text;await eventSource.emit(event_types.MESSAGE_RECEIVED,host.chat.length-1);await render();await eventSource.emit(event_types.GENERATION_ENDED);await host.flush();host.metadata.__liyuanPluginProcessed[id]=true;if(window.Mvu&&host.context.mvu?.enabled){host.metadata.__liyuanMvuProcessed??={};host.metadata.__liyuanMvuProcessed[id]={status:"normal",at:new Date().toISOString()};}await host.save();}finally{msg.mes=canonical;}}},async bind(){await host.bind(await host.request('/context'));await render();},async evaluate(text,context={}){if(!window.EjsTemplate)throw new Error('原提示词模板未启用');return window.EjsTemplate.evalTemplate(text,context);},async renderHtml(html,index){if(!window.TavernHelper)throw new Error('酒馆助手未启用，保留梨园原有安全HTML显示');const target=host.chat[index];if(!target)throw new Error('消息已不在当前分支');const node=document.querySelector(`.mes[mesid="${index}"] .mes_text`);if(!node)throw new Error('消息显示宿主缺失');const display=window.EjsTemplate?await window.EjsTemplate.evalTemplate(html,await window.EjsTemplate.prepareContext({},index)):html;const pre=document.createElement('pre'),code=document.createElement('code');code.className='language-html';code.textContent=/<html[\s>]/i.test(display)?display:'<!doctype html><html><head><meta charset="utf-8"></head><body>'+display+'</body></html>';pre.append(code);target.mes='```html\n'+code.textContent+'\n```';node.replaceChildren(pre);await eventSource.emit(event_types.MESSAGE_UPDATED,index);await eventSource.emit('chatLoaded');},host};
const originalRender=window.LiyuanTavernPlugins.renderHtml;window.LiyuanTavernPlugins.renderHtml=async(...args)=>{const canonical=host.chat.map(m=>m.mes);host.displayProjection++;try{return await originalRender(...args);}finally{host.chat.forEach((m,i)=>m.mes=canonical[i]);host.displayProjection--;}};
window.LiyuanTavernPlugins.filterWorldbookEntries=filterWorldbookEntries;
const originalAfter=window.LiyuanTavernPlugins.after;let afterPending=null;window.LiyuanTavernPlugins.after=(...args)=>{
 if(afterPending)return afterPending;
  afterPending=(async()=>{host.afterRunning=true;host.displayProjection++;host.mvuCandidates=[];try{return await originalAfter(...args);}finally{host.afterRunning=false;host.displayProjection--;delete host.mvuCandidates;}})().finally(()=>{afterPending=null;});return afterPending;
};
let displayWork=Promise.resolve();
function enqueueDisplay(work){const next=displayWork.catch(()=>{}).then(work);displayWork=next;return next;}
async function refreshStateFromParent(data){
 const context=host.context,index=host.chat.findIndex(message=>message.__liyuanEntryId===data.entryId);
 if(!ready||data.entryId!==params.get('entryId')||data.entryId!==context.sourceEntryId||data.entryScope!==context.scopeKey||index<0)throw new Error('变量刷新不属于当前显示来源');
 await host.saving; // Never flush/retry a pending write as part of a read-only refresh.
 const snapshot=await host.request('/context',undefined,context,AbortSignal.timeout(10000));
 if(host.context!==context)throw new Error('原卡已切换，迟到变量未投送');
 const before=window.Mvu?.getMvuData({type:'message',message_id:index});
 const result=host.refreshDisplayState(snapshot);
 if(result.variablesChanged&&window.Mvu){
  const event=window.Mvu.events.VARIABLE_UPDATE_ENDED;
  host.pendingDisplayNotification={context,revision:context.revision,event,before,after:window.Mvu.getMvuData({type:'message',message_id:index}),listeners:new Set((eventSource.listeners.get(event)??[]).filter(listener=>host.nativeDisplayListeners?.get(event)?.get(listener)?.isConnected))};
 }
 const notification=host.pendingDisplayNotification;
 if(notification?.context===context&&notification.revision===context.revision){
  // Only original message-iframe callbacks, never chat/render/generation/parser
  // hooks. A failed callback can be retried without repeating successful ones.
  for(const listener of notification.listeners){
   if((eventSource.listeners.get(notification.event)??[]).includes(listener)&&host.nativeDisplayListeners?.get(notification.event)?.get(listener)?.isConnected)await listener(structuredClone(notification.after),structuredClone(notification.before));
   notification.listeners.delete(listener);
  }
  delete host.pendingDisplayNotification;
 }
 parent.postMessage({type:'liyuan-tavern-state-refreshed',entryId:data.entryId,entryScope:data.entryScope,requestId:data.requestId},location.origin);
}
let pendingRender=null;
async function renderFromParent(data){
 const index=host.chat.findIndex(m=>m.__liyuanEntryId===data.entryId);if(index<0||data.entryId!==params.get('entryId'))throw new Error('显示消息不属于当前分支');
 const wasBootstrapping=host.displayBootstrap;host.displayBootstrap=true;
 try{await window.LiyuanTavernPlugins.renderHtml(data.html,index);
  // Original template receive accounting schedules a timer then the host's
  // immediate token-count promise. Let that display-local work finish before
  // recording the bootstrap baseline; it is not an unsaved user edit.
  await new Promise(resolve=>setTimeout(resolve,0));
 }
 finally{host.persistedStateJSON=JSON.stringify(host.state());host.displayBootstrap=wasBootstrapping;}
}
async function evaluateTemplateFromParent(data){
 const index=host.chat.findIndex(m=>m.__liyuanEntryId===data.entryId);if(index<0||data.entryId!==params.get('entryId'))throw new Error('模板求值消息不属于当前分支');
 if(!window.EjsTemplate)throw new Error('原提示词模板未启用');
 const context=await window.EjsTemplate.prepareContext({},index);const html=await window.EjsTemplate.evalTemplate(data.html,context);
 parent.postMessage({type:'liyuan-tavern-template-result',requestId:data.requestId,entryId:data.entryId,html:String(html)},location.origin);
}
window.addEventListener('message',event=>{
 if(view!=='render'||event.source!==parent||event.origin!==location.origin)return;
 const data=event.data;
 if(data?.type==='liyuan-tavern-render'&&typeof data.html==='string'){
  if(!ready){pendingRender=data;return;}
  void enqueueDisplay(()=>renderFromParent(data)).catch(error=>parent.postMessage({type:'liyuan-tavern-error',error:error.message},location.origin));return;
 }
 if(data?.type==='liyuan-tavern-refresh-state'){
  void enqueueDisplay(()=>refreshStateFromParent(data)).catch(error=>parent.postMessage({type:'liyuan-tavern-state-refresh-error',error:error.message,entryId:data.entryId,entryScope:data.entryScope,requestId:data.requestId},location.origin));return;
 }
 if(data?.type==='liyuan-tavern-evaluate-template'&&typeof data.html==='string'&&typeof data.requestId==='number'&&ready)
  void evaluateTemplateFromParent(data).catch(error=>parent.postMessage({type:'liyuan-tavern-error',error:error.message,requestId:data.requestId,entryId:data.entryId},location.origin));
});
// Settings realms do not own an internal turn nonce/after phase. Route only this native
// repair button through the same source-bound recovery used by the management panel.
if(view==='manager'&&focus==='mvu'){
 let recovering=false;
 const onRetry=async event=>{
  const button=event.target.closest?.('button,[role="button"]');
  if(!button||button.textContent.trim()!=='重试额外模型解析')return;
  event.preventDefault();event.stopImmediatePropagation();
  if(recovering)return;
  recovering=true;button.disabled=true;button.setAttribute('aria-disabled','true');
  let feedback=document.getElementById('liyuan-mvu-recovery-feedback');
  if(!feedback){feedback=document.createElement('p');feedback.id='liyuan-mvu-recovery-feedback';button.after(feedback);}
  feedback.setAttribute('role','status');feedback.textContent='正在恢复本回合变量；可能调用独立模型，请勿重复点击。';
  const binding={scopeKey:host.context.scopeKey,sourceEntryId:host.context.sourceEntryId};
  try{
   const response=await nativeFetch('/api/mvu/recover',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(binding),signal:AbortSignal.timeout(180000)});
   const result=await response.json();
   if(!response.ok)throw Error(result.error??`HTTP ${response.status}`);
   if(result.scopeKey!==binding.scopeKey||result.sourceEntryId!==binding.sourceEntryId||host.context.scopeKey!==binding.scopeKey||host.context.sourceEntryId!==binding.sourceEntryId)throw Error('会话或回合已变化，未将旧结果显示为成功。');
   if(!['updated','unchanged','reused'].includes(result.status))throw Error('恢复接口返回未知状态，未显示为成功。');
   feedback.textContent=result.status==='reused'?'本回合已经处理过，复用已存收据；未重复解析。':result.status==='updated'?'本回合变量已更新并保存。':'原 MVU 未发现新的变量变动，处理已完成。';
   // The recovery endpoint sends the authoritative hello; do not repeat card/template events.
  }catch(error){feedback.setAttribute('role','alert');feedback.textContent=error.name==='TimeoutError'?'等待结果超时，请先刷新核对；请求可能已执行，不自动重试。':error.message??'MVU恢复失败，请刷新核对。';}
  finally{recovering=false;button.disabled=false;button.removeAttribute('aria-disabled');}
 };
 const installed=new WeakSet();
 const install=doc=>{if(installed.has(doc))return;installed.add(doc);doc.addEventListener('click',onRetry,true);};
 install(document);
 const timer=setInterval(()=>{for(const iframe of document.querySelectorAll('iframe'))try{if(iframe.contentDocument)install(iframe.contentDocument);}catch{}},100);
 window.addEventListener('pagehide',()=>clearInterval(timer),{once:true});
}
try{
 const serviceWorkerReady = view === 'manager' && params.get('network') !== 'isolated'
  ? ensureManagerWorker(navigator.serviceWorker, location.origin)
  : (async()=>{
  if(view==='runtime'||view==='render'||params.get('network')==='isolated'||!('serviceWorker' in navigator))return;
  if(navigator.serviceWorker.controller?.scriptURL===new URL('/tavern-plugin-sw.js',location.href).href)return;
  try{await Promise.race([(async()=>{await navigator.serviceWorker.register('/tavern-plugin-sw.js',{scope:'/tavern-plugin-host.html'});await navigator.serviceWorker.ready;if(!navigator.serviceWorker.controller)await new Promise(resolve=>{const done=()=>{clearTimeout(timer);navigator.serviceWorker.removeEventListener('controllerchange',done);resolve();},timer=setTimeout(done,2000);navigator.serviceWorker.addEventListener('controllerchange',done);});})(),new Promise(resolve=>setTimeout(resolve,5000))]);}catch{ /* restricted browsers retain original CDN requests */ }
 })();
 const [yaml,context]=await Promise.all([import('/tavern-compat/vendor/yaml/index.js'),host.request('/context')]);
 window.YAML=yaml;await host.bind(context);
 if(params.has('scopeKey')&&params.get('scopeKey')!==host.context.scopeKey)throw new Error('会话或角色卡已变化，旧显示宿主不会写入新作用域');
 if(focus==='mvu'&&(!host.context.mvu?.enabled||!host.context.mvu.installed||!host.context.plugins.find(p=>p.id==='helper')?.enabled))throw new Error('请先启用已校验的原MVU与酒馆助手，不能以设置页临时启用冒充可用');
 if(view==='manager'){const selected=host.context.plugins.find(p=>p.id===params.get('plugin'));if(selected?.version)selected.enabled=true;}
 if(host.context.plugins.some(plugin=>plugin.id==='helper'&&plugin.enabled)){
  const assets=await host.request('/asset-map');
  installNativeResources({origin:location.origin,assets,workspace:document.querySelector('meta[name="liyuan-workspace"]')?.content,lease:document.querySelector('meta[name="liyuan-workspace-lease"]')?.content});
 }
 // Existing old workers may still intercept unknown decorative resources. Update
 // only our exact registration; render realms never require/register a worker.
 if(view==='render'&&navigator.serviceWorker?.controller?.scriptURL===new URL('/tavern-plugin-sw.js',location.origin).href){
  void navigator.serviceWorker.getRegistration('/tavern-plugin-host.html').then(registration=>{if(registration?.scope===new URL('/tavern-plugin-host.html',location.origin).href&&registration.active?.scriptURL===new URL('/tavern-plugin-sw.js',location.origin).href)return registration.update();}).catch(()=>{});
 }
 if(view==='manager')await loadPluginLocales(host.context.plugins);
 await serviceWorkerReady;
 for(const plugin of ['template','helper']){
  const info=host.context.plugins.find(p=>p.id===plugin);if(!info?.enabled)continue;
  const slug=plugin==='helper'?'JS-Slash-Runner':'ST-Prompt-Template';
  if(plugin==='helper'){const link=document.createElement('link');link.rel='stylesheet';link.href=`/tavern-compat/scripts/extensions/third-party/${slug}/dist/index.css`;document.head.append(link);}
   await import(`/tavern-compat/scripts/extensions/third-party/${slug}/dist/index.js`);
 }
 for(let i=0;i<100;i++){if(host.context.plugins.every(p=>!p.enabled||(p.id==='helper'?!!window.TavernHelper:!!window.EjsTemplate)))break;await new Promise(r=>setTimeout(r,50));}
  if(!host.context.plugins.every(p=>!p.enabled||(p.id==='helper'?!!window.TavernHelper:!!window.EjsTemplate)))throw new Error('原插件没有完成初始化');
  if(window.TavernHelper?._bind){
   host.nativeMvuListeners=new Map();host.nativeDisplayListeners=new Map();
   for(const name of ['_eventOn','_eventMakeFirst','_eventMakeLast','_eventOnce']){
    const original=window.TavernHelper._bind[name];if(typeof original!=='function')continue;
    window.TavernHelper._bind[name]=function(event,...args){
     const prior=new Set(eventSource.listeners.get(event)??[]),result=original.call(this,event,...args);
     const iframeId=String(this.frameElement?.id??this.__TH_IFRAME_ID??this.name??'');
     if(iframeId.startsWith('TH-message--')&&host.chat[Number(this.frameElement?.closest('.mes')?.getAttribute('mesid'))]?.__liyuanEntryId===params.get('entryId')){const listeners=host.nativeDisplayListeners.get(event)??new Map();for(const listener of eventSource.listeners.get(event)??[])if(!prior.has(listener))listeners.set(listener,this.frameElement);host.nativeDisplayListeners.set(event,listeners);}
     const scriptId=String(this.frameElement?.id??this.__TH_IFRAME_ID??this.name??'').replace(/TH-script--.+--/,'');
     const trees=window.TavernHelper.getScriptTrees({type:'global'});
     const native=items=>items.some(item=>item.type==='folder'?native(item.scripts??[]):item.id===scriptId&&/MagVarUpdate|MVU变量框架/.test(String(item.content??'')+' '+String(item.name??'')));
      if(native(trees)){const listeners=host.nativeMvuListeners.get(event)??new Set();for(const listener of eventSource.listeners.get(event)??[])if(!prior.has(listener))listeners.add(listener);host.nativeMvuListeners.set(event,listeners);if(event===window.TavernHelper._bind._getButtonEvent.call(this,'重试额外模型解析'))host.nativeMvuManualRetryEvent=event;}
     return result;
    };
   }
  }
  const managedMvuEnabled=host.context.mvu?.enabled&&host.context.plugins.some(plugin=>plugin.id==='helper'&&plugin.enabled);
  const priorWorldbookListeners=new Set(eventSource.listeners.get(event_types.WORLDINFO_ENTRIES_LOADED)??[]);
   const retryEvents=[event_types.GENERATION_STARTED,event_types.GENERATION_AFTER_COMMANDS,event_types.GENERATE_AFTER_DATA,event_types.CHAT_COMPLETION_SETTINGS_READY,event_types.MESSAGE_RECEIVED,event_types.GENERATION_ENDED];
 if(managedMvuEnabled){
  if(!host.context.mvu.installed)throw new Error('MVU已启用但原资产/依赖校验未通过');
  if(!window.TavernHelper)throw new Error('MVU需要已启用的酒馆助手；没有用空壳代替');
  const trees=window.TavernHelper.getScriptTrees({type:'global'});
  const hasMvu=items=>items.some(item=>item.enabled!==false&&(item.type==='folder'?hasMvu(item.scripts??[]):/MagVarUpdate|MVU变量框架/.test(String(item.content??'')+' '+String(item.name??''))));
  // The native character/preset container may be off even if each embedded script is enabled.
  // Do not enable unrelated card automation: run only the MVU core and its explicit schema dependency.
  if(!hasMvu(trees))window.TavernHelper.replaceScriptTrees([...trees,{type:'script',enabled:true,name:'MVU变量框架 · 梨园原版',id:'liyuan-original-mvu',content:"import '/tavern-compat/mvu/bundle.js'",info:'MagicalAstrogy & StageDog · MIT · v0.193.0',button:{enabled:false,buttons:[]},data:{},export_with:{data:false,button:false}}],{type:'global'});
  const enabledLeaves=items=>items.flatMap(item=>item.enabled===false?[]:item.type==='folder'?enabledLeaves(item.scripts??[]):[item]);
  const sourceSchemas=enabledLeaves(['character','preset'].flatMap(type=>window.TavernHelper.getScriptTrees({type}))).filter(item=>item.enabled!==false&&/registerMvuSchema|mvu_zod\.js/.test(String(item.content??'')));
  host.mvuSchemaDependencyCount=sourceSchemas.length;
  const current=window.TavernHelper.getScriptTrees({type:'global'}),ids=new Set(current.map(item=>item.id));
  const required=sourceSchemas.filter(item=>!ids.has('liyuan-mvu-schema-'+item.id)).map(item=>({...item,id:'liyuan-mvu-schema-'+item.id,name:item.name+' · MVU依赖',button:{enabled:false,buttons:[]},data:{...item.data,__liyuanMvuDependency:true}}));
  if(required.length)window.TavernHelper.replaceScriptTrees([...current,...required],{type:'global'});
 }
 if(host.errors.length)throw new Error(host.errors.join('\n'));
  await eventSource.emit(event_types.APP_READY);await eventSource.emit(event_types.SETTINGS_LOADED);await render();
  if(managedMvuEnabled){await Promise.race([window.TavernHelper.waitGlobalInitialized('Mvu'),new Promise((_,reject)=>setTimeout(()=>reject(new Error('原MVU初始化超时；未当成可用')),30000))]);if(typeof window.Mvu?.parseMessage!=='function')throw new Error('MVU没有提供原始parseMessage接口');
   // The shared API resolves before native chat initialization finishes registering handlers.
   const listenerDeadline=Date.now()+10000;
     // Native cleanup registers a message listener before the parser lifecycle is ready.
     while(view==='runtime'&&(!host.nativeMvuListeners?.get(event_types.MESSAGE_RECEIVED)?.size||!host.nativeMvuListeners?.get(host.nativeMvuManualRetryEvent)?.size)){if(Date.now()>listenerDeadline)throw new Error('原MVU消息监听器初始化超时');await new Promise(resolve=>setTimeout(resolve,20));}
    host.nativeMvuRetryListeners=new Map(retryEvents.map(event=>[event,host.nativeMvuListeners?.get(event)??new Set()]));
  if(host.mvuSchemaDependencyCount){const deadline=Date.now()+10000;while((eventSource.listeners.get('mag_variable_initialized')?.length??0)<host.mvuSchemaDependencyCount){if(Date.now()>deadline)throw new Error('声明的MVU schema未完成注册，未假装就绪');await new Promise(resolve=>setTimeout(resolve,20));}
   const index=host.chat.length-1;if(index>=0){let data=Mvu.getMvuData({type:'message',message_id:index});if(!Object.keys(data.stat_data??{}).length){let inherited=false;for(let previous=index-1;previous>=0;previous--){const candidate=Mvu.getMvuData({type:'message',message_id:previous});if(Object.keys(candidate.stat_data??{}).length){data=structuredClone(candidate);inherited=true;break;}}if(!inherited)await eventSource.emit(Mvu.events.VARIABLE_INITIALIZED,data,index);if(Object.keys(data.stat_data??{}).length){if(!inherited)delete data.schema;await Mvu.replaceMvuData(data,{type:'message',message_id:index});if(!inherited){host.metadata.__liyuanMvuSchemaInitialized??={};host.metadata.__liyuanMvuSchemaInitialized[host.chat[index].__liyuanEntryId]=true;}await host.flush();}}}
  }
 }
   host.nativeMvuWorldbookListeners=host.nativeMvuListeners?.get(event_types.WORLDINFO_ENTRIES_LOADED)??new Set((eventSource.listeners.get(event_types.WORLDINFO_ENTRIES_LOADED)??[]).filter(listener=>!priorWorldbookListeners.has(listener)));
   if(view==='render'){await new Promise(resolve=>setTimeout(resolve,0));host.displayBootstrap=false;host.persistedStateJSON=JSON.stringify(host.state());}
   settingsUI.refresh();if(focus==='mvu'){const deadline=Date.now()+10000;while(!settingsUI.mvuReady()){if(Date.now()>deadline)throw new Error('原MVU设置未挂载，不把空面板当成就绪');await new Promise(resolve=>setTimeout(resolve,30));}}ready=true;status.textContent='原插件已就绪（梨园宿主适配，不是完整酒馆）';
 if(view==='manager')parent.postMessage({type:'liyuan-tavern-manager-ready',attempt:params.get('attempt'),contextTick:params.get('contextTick')},location.origin);
 if(view==='manager'&&params.get('plugin')){const plugin=params.get('plugin');const unwanted=plugin==='helper'?document.getElementById('prompt_template_settings'):document.getElementById('tavern_helper');if(unwanted)unwanted.hidden=true;}
 if(view==='render'){
  const index=params.has('entryId')?host.chat.findIndex(m=>m.__liyuanEntryId===params.get('entryId')):Number(params.get('message'));if(!Number.isInteger(index)||index<0)throw new Error('当前分支没有该消息，请刷新会话');
  if(Number.isInteger(index)&&index>=0){document.querySelectorAll('.mes').forEach((node,i)=>{if(i!==index)node.remove();});}
  if(pendingRender)await renderFromParent(pendingRender);parent.postMessage({type:'liyuan-tavern-ready'},location.origin);
  const observer=new ResizeObserver(()=>parent.postMessage({type:'liyuan-tavern-height',height:document.body.scrollHeight},location.origin));observer.observe(document.body);
 }
}catch(error){host.errors.push(error.message??String(error));status.textContent='原插件加载失败：'+host.errors.at(-1);if(view==='render')parent.postMessage({type:'liyuan-tavern-error',error:error.message},location.origin);if(view==='manager')parent.postMessage({type:'liyuan-tavern-manager-error',error:error.message,attempt:params.get('attempt'),contextTick:params.get('contextTick')},location.origin);throw error;}

// Replay only registered native MVU handlers, never the template/helper or other settlement chain.
let mvuRetryPending=null;
window.LiyuanTavernPlugins.recoverMvu=()=>{
 if(mvuRetryPending)return mvuRetryPending;
 mvuRetryPending=(async()=>{
  if(!ready||!host.context.mvu?.enabled||typeof window.Mvu?.parseMessage!=="function")throw new Error("原MVU尚未启用/初始化");
  const msg=host.chat.at(-1),id=msg?.__liyuanEntryId,scopeKey=host.context.scopeKey;
  if(!id||id!==host.context.sourceEntryId||msg.is_user||msg.__liyuanUnfinished||typeof msg.__liyuanAuthorDelivery!=="string"||!msg.__liyuanAuthorDelivery.trim())throw new Error("没有完整且可追溯的原作者交付，不能补造变量更新");
   const projection=mvuParsingProjection(mvuParseSource(msg.__liyuanAuthorDelivery,msg.__liyuanSupplementaryVariables));
   if(host.extensions.mvu_settings?.更新方式==='额外模型解析'&&host.extensions.mvu_settings.额外模型解析配置?.密钥)throw new Error('MVU受管解析不接受原设置中的自定义密钥；原设置保持不变，请先核对独立受管连接');
   const records=host.metadata.__liyuanMvuProcessed??={},receipt=records[id];
   const materials=[projection.text,host.context.readonlyBooks,host.extensions.mvu_settings];
   // Completed current deliveries remain valid when reference-only ancestors are repaired.
   // Explicit historical reconstruction must still bind its repaired pre-turn basis.
   if(host.context.mvuHistoricalRecovery)materials.push(host.chat.slice(0,-1).map(row=>[row.__liyuanEntryId,row.variables]));
   const materialBytes=new TextEncoder().encode(JSON.stringify(materials));
   const materialHash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',materialBytes))].map(byte=>byte.toString(16).padStart(2,'0')).join('');
      if(receipt?.nativeRetry===true&&receipt.authorHistoryVersion===2&&receipt.materialHash===materialHash&&['updated','unchanged'].includes(receipt.status)){
    const baseline=host.mvuRetryBaseline;if(baseline){if(baseline.hasVariables)msg.variables=structuredClone(baseline.variables);else delete msg.variables;const global=host.extensions.variables.global;if(baseline.hasExtraAnalysis)global.extra_analysis=baseline.extraAnalysis;else delete global.extra_analysis;await host.flush();}
     return {scopeKey,sourceEntryId:id,status:"reused"};
    }
  if(!host.nativeMvuRetryListeners?.get(event_types.MESSAGE_RECEIVED)?.size)throw new Error('原MVU消息监听器未就绪，不能以空解析冒充成功');
   const index=host.chat.length-1,canonical=msg.mes;
   await host.flush();
   const context=host.context,global=host.extensions.variables.global;
   const baseline=host.mvuRetryBaseline??{context,id,hasVariables:Object.hasOwn(msg,'variables'),variables:structuredClone(msg.variables??{}),receipt:receipt===undefined?undefined:structuredClone(receipt),hasExtraAnalysis:Object.hasOwn(global,'extra_analysis'),extraAnalysis:global.extra_analysis};
   const baselineSlot=Array.isArray(baseline.variables)?baseline.variables[msg.swipe_id??0]:baseline.variables;
   const before=JSON.stringify(baselineSlot?.stat_data??{});
   host.mvuRetryBaseline=baseline;
   const errorStart=host.errors.length;
   const extraModel=host.extensions.mvu_settings?.更新方式==='额外模型解析';
   let parsed=false,completed=false,observed=false,receiving=false;
   const observe=(_data,commands,text)=>{
    if(!receiving||!String(text).startsWith(host.mvuRetryParseText??projection.text))return;
    observed=true;
   if(commands.length){parsed=true;return;}
   // Empty native JSONPatch is a real unchanged result; absent/invalid commands are not.
   for(const match of String(text).matchAll(/<JSONPatch\b[^>]*>([\s\S]*?)<\/JSONPatch\s*>/gi)){
    try{const value=JSON.parse(match[1].trim());if(Array.isArray(value)&&value.length===0)parsed=true;}catch{}
   }
   },ended=()=>{if(receiving&&observed)completed=true;};
  eventSource.on(Mvu.events.COMMAND_PARSED,observe);eventSource.on(Mvu.events.VARIABLE_UPDATE_ENDED,ended);
  host.displayProjection++;host.mvuCandidates=[];
  try{
     msg.mes=projection.text;
     if(extraModel){
      const event=host.nativeMvuManualRetryEvent,listeners=host.nativeMvuListeners.get(event);
      if(!listeners?.size)throw new Error('原MVU手动重试按钮监听器未就绪');
      receiving=true;
      // Observe the native button's parse projection after it removes the old update block.
      const start=projection.text.lastIndexOf('<UpdateVariable>'),end=projection.text.lastIndexOf('</UpdateVariable>');
      host.mvuRetryParseText=start<0?projection.text:end<0?projection.text.slice(0,start):projection.text.slice(0,start)+projection.text.slice(end+17);
      for(const listener of [...(eventSource.listeners.get(event)??[])])if(listeners.has(listener))await listener();
     }else{
     for(const [event,args] of [[event_types.GENERATION_STARTED,['normal',{},false]],[event_types.MESSAGE_RECEIVED,[index]],[event_types.GENERATION_ENDED,[]]]){
     if(event===event_types.MESSAGE_RECEIVED)receiving=true;
      for(const listener of [...(eventSource.listeners.get(event)??[])])if(host.nativeMvuListeners.get(event)?.has(listener))await listener(...args);
    }
     }
   // Native desktop handlers are throttled; their trailing invocation can outlive the returned promise.
    const deadline=Date.now()+90000;
    while(Date.now()<deadline){
     const candidates=host.mvuCandidates;
     if(host.errors.length>errorStart||candidates.length&&!candidates.some(candidate=>candidate.pending)&&!candidates.some(candidate=>candidate.ok))break;
     if(completed&&!Mvu.isDuringExtraAnalysis())break;
     if(Date.now()>deadline-85000&&!Mvu.isDuringExtraAnalysis()&&!candidates.length)break;
     await new Promise(resolve=>setTimeout(resolve,20));
    }
    assertMvuCandidatesSettled(host.mvuCandidates);
    if(host.errors.length>errorStart)throw new Error('原MVU监听器失败：'+host.errors.slice(errorStart).join('; '));
     if(!parsed||!completed||Mvu.isDuringExtraAnalysis()||extraModel&&!host.mvuCandidates.some(candidate=>candidate.ok))throw new Error('原MVU未完成有效变量命令解析；缺少更新内容不视为 unchanged，请检查原设置/材料后重试');
   await host.flush();
   if(host.context.scopeKey!==scopeKey||host.context.sourceEntryId!==id||host.chat.at(-1)!==msg)throw new Error('MVU结果来自过期作用域');
    const data=Mvu.getMvuData({type:'message',message_id:index}),status=before===JSON.stringify(data.stat_data??{})?'unchanged':'updated';
    if(Object.keys(baselineSlot?.stat_data??{}).length&&!Object.keys(data.stat_data??{}).length)throw new Error('原MVU重试丢失当前来源全部变量，未发布空状态；请检查原schema与祖先变量基准');
    if(baseline.hasExtraAnalysis)global.extra_analysis=baseline.extraAnalysis;else delete global.extra_analysis;
    delete host.mvuRetryBaseline;
      records[id]={status,nativeRetry:true,authorHistoryVersion:2,materialHash,projectionRepaired:projection.repairedPatchClosingTag,at:new Date().toISOString()};
   try{await host.flush();}catch(error){delete records[id];throw error;}return {scopeKey,sourceEntryId:id,status,variableRootKeys:Object.keys(data.stat_data??{}).length};
   }catch(error){
    if(host.context===context&&host.context.scopeKey===scopeKey&&host.context.sourceEntryId===id&&host.chat.at(-1)===msg){
     if(baseline.hasVariables)msg.variables=structuredClone(baseline.variables);else delete msg.variables;
     if(baseline.receipt===undefined)delete records[id];else records[id]=structuredClone(baseline.receipt);
     if(baseline.hasExtraAnalysis)global.extra_analysis=baseline.extraAnalysis;else delete global.extra_analysis;
     host.mvuRetryBaseline=baseline;await host.flush();
    }
    throw error;
    }finally{msg.mes=canonical;host.displayProjection--;delete host.mvuCandidates;delete host.mvuRetryParseText;eventSource.removeListener(Mvu.events.COMMAND_PARSED,observe);eventSource.removeListener(Mvu.events.VARIABLE_UPDATE_ENDED,ended);}
 })().finally(()=>{mvuRetryPending=null;});return mvuRetryPending;
};
