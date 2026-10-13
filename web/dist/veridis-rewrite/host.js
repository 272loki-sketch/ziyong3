/** Management-only glue; all rule semantics, editors, import/export and templates stay upstream. */
const nativeFetch=window.fetch.bind(window),root='/veridis-rewrite/scripts/extensions/third-party/Veridis-Rewrite/';
const statusNode=document.getElementById('veridis-host-status'),params=new URLSearchParams(location.search);
document.documentElement.dataset.theme=params.get('theme')==='dark'?'dark':'light';
const status=(message,error=false)=>{statusNode.textContent=message;statusNode.setAttribute('role',error?'alert':'status');};
let binding,settings,extensionName,revision,queue=Promise.resolve(),pending=0,failed=false,ready=false;
const blocked=message=>Promise.reject(new Error(message));
// Imported original modules may read assets, but model/story/network mutations are not available.
window.fetch=(input,init={})=>{
 const url=new URL(typeof input==='string'?input:input.url,location.href),method=String(init.method??'GET').toUpperCase();
 if(url.origin===location.origin&&method==='GET'&&url.pathname.startsWith(root)&&!url.search&&!url.hash)return nativeFetch(input,init);
 return blocked('原版管理工作台不开放模型、历史消息或外部网络请求。');
};
window.XMLHttpRequest=class{constructor(){throw Error('原版管理工作台不开放 XHR 网络请求');}};
window.WebSocket=class{constructor(){throw Error('原版管理工作台不开放 WebSocket');}};
window.EventSource=class{constructor(){throw Error('原版管理工作台不开放 EventSource');}};
window.TavernHelper={generateRaw:()=>blocked('模型只在来源绑定的后台润色中执行'),getModelList:()=>blocked('模型由梨园独立岗位配置'),setChatMessages:()=>blocked('管理页不回写故事'),getChatMessages:()=>[]};
const publicSettings=value=>Array.isArray(value)?value.map(publicSettings):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!/^(?:api[_-]?key|key|api[_-]?token|token|access[_-]?token|refresh[_-]?token|secret|password|authorization|oauth)$/i.test(key)).map(([key,child])=>[key,publicSettings(child)])):value;
function save(){
 if(failed)return queue;
 const snapshot=publicSettings(structuredClone(settings));pending++;status('正在保存原版规则设置…');
 queue=queue.then(async()=>{
  if(failed)throw Error('此前保存失败，请重新载入原版工作台');
  const response=await nativeFetch('/api/veridis-rewrite/settings',{method:'PUT',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({settings:snapshot,scopeKey:binding.scopeKey,sourceEntryId:binding.sourceEntryId,upstreamCommit:binding.upstreamCommit,revision}),signal:AbortSignal.timeout(15000)});
  const result=await response.json();if(!response.ok)throw Error(result.error??`HTTP ${response.status}`);revision=result.revision;
 }).catch(error=>{failed=true;status('保存未完成：'+error.message+'。请返回并重新载入，未覆盖新来源。',true);}).finally(()=>{pending--;if(!failed&&!pending)status('原版规则设置已保存');});
 return queue;
}
const deniedSelectors='#blai-deep-clean-btn,#blai-tools-feedback-open,#blai-feedback-submit,#blai-composer-button-toggle,#blai-shujuku-auto-rewrite-toggle,#blai-ai-model-fetch,#blai-ai-api-key-reveal,#blai-ai-api-key-clear,#blai-ai-base-url,#blai-ai-api-key,#blai-ai-model,#blai-ai-model-manual,.blai-persona-description-protect-toggle';
function guardControls(){
 for(const element of document.querySelectorAll(deniedSelectors)){element.setAttribute('data-liyuan-unsupported','');element.title='梨园原版规则管理页不开放此旁路；模型端点与凭据由独立岗位管理。';if('disabled'in element)element.disabled=true;}
 const model=binding.model,modeLabel=model?`${model.provider} / ${model.id}`:'未配置（不会借用正文）';
 const modelSelect=document.getElementById('blai-ai-model');if(modelSelect&&modelSelect.options[0]?.textContent!=='梨园独立受管 · '+modeLabel){modelSelect.replaceChildren(new Option('梨园独立受管 · '+modeLabel,'liyuan-managed',true,true));}
 const base=document.getElementById('blai-ai-base-url');if(base)base.value='梨园连接面板的独立 veridisRewrite 岗位';
 const key=document.getElementById('blai-ai-api-key');if(key){key.value='';key.placeholder='由宿主管理，不向浏览器提供密钥';}
 const pill=document.getElementById('blai-responsive-model-pill');if(pill&&pill.textContent!=='独立受管 · '+modeLabel)pill.textContent='独立受管 · '+modeLabel;
}
document.addEventListener('click',event=>{const target=event.target.closest?.(deniedSelectors);if(target){event.preventDefault();event.stopImmediatePropagation();status('此旁路未开放；本工作台支持原版规则、预设、导入／导出及显示润色设置。');}},true);
document.addEventListener('submit',event=>{event.preventDefault();event.stopImmediatePropagation();},true);
document.getElementById('veridis-host-save').addEventListener('click',()=>{if(settings)void save();});
try{
 const response=await nativeFetch('/api/veridis-rewrite/context',{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(15000)});binding=await response.json();if(!response.ok)throw Error(binding.error??`HTTP ${response.status}`);
 if(!binding.scopeKey||!binding.sourceEntryId||!Number.isSafeInteger(binding.revision)||!/^[a-f0-9]{40}$/i.test(binding.upstreamCommit))throw Error('工作台来源、版本或revision绑定不完整');
 revision=binding.revision;
 const defaults=await import(root+'src/settings/defaults.js');extensionName=defaults.extensionName;
 settings={...structuredClone(defaults.defaultSettings),...structuredClone(binding.settings),aiRewrite:{...structuredClone(defaults.defaultAiRewriteSettings),...structuredClone(binding.settings?.aiRewrite)}};
 settings.guidedTourSeen=true; // Per-frame only: no automatic tour over the host's management canvas.
 const extension_settings={[extensionName]:settings},events={on(){},off(){},removeListener(){},makeLast(){},makeFirst(){},emit(){}};
 const chat=Object.freeze([]),context={chat,chatMetadata:{},chatId:binding.sourceEntryId,characters:[],characterId:undefined,getRequestHeaders:()=>({'content-type':'application/json'})};
 window.SillyTavern={getContext:()=>context};
 const app=await import(root+'src/host/appContext.js');app.initAppContext({extension_settings,chat,saveSettingsDebounced:()=>{void save();},saveChat:()=>blocked('工作台不允许编辑历史消息'),getSillyTavernContext:()=>context,eventSource:events,event_types:{},getStreamingProcessor:()=>null,getWorldInfoState:()=>({}),getCurrentPersonaIdentity:()=>'',getInstalledEnabledExtensions:()=>[],readExtensionManifest:async()=>binding.manifest,getVeridisCommit:()=>binding.upstreamCommit});
 const shell=await import(root+'src/ui/shell.js');
 await shell.setupUI(async(_directory,name,data)=>{if(name!=='purifier')throw Error('未知原模板');const r=await nativeFetch(root+'templates/purifier.html',{cache:'no-store'});if(!r.ok)throw Error('原版模板未加载');return (await r.text()).replaceAll('{{logoUrl}}',data.logoUrl);},root+'templates');
 const eventsModule=await import(root+'src/events.js');eventsModule.bindEvents();
 const popup=document.getElementById('blai-purifier-popup');if(!popup)throw Error('原版工作台根节点未创建');document.getElementById('veridis-host-canvas').append(popup);
 const view=await import(root+'src/rules/view.js'),presets=await import(root+'src/presets/view.js');view.renderTags();presets.updateToolbarUI();shell.showResponsivePage('overview');
 // Closing an inner popup must not leave an empty unopenable iframe; parent owns navigation.
 document.addEventListener('click',event=>{if(event.target.closest?.('#blai-close-btn')){event.preventDefault();event.stopImmediatePropagation();void queue.then(()=>parent.postMessage({type:'liyuan:veridis-rewrite-close'},location.origin));}},true);
 guardControls();new MutationObserver(()=>guardControls()).observe(popup,{childList:true,subtree:true});
 ready=true;status('原版工作台已就绪 · 规则可编辑，支持 JSON 导入／导出');
 window.LiyuanVeridisRewrite={ready:()=>ready,flush:()=>queue,get pending(){return pending;},get failed(){return failed;}};
}catch(error){status('原版工作台未就绪：'+error.message,true);window.LiyuanVeridisRewrite={ready:()=>false,error:error.message};}
