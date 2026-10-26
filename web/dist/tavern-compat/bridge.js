import { getCurrentLocale, t, localizeTemplate } from './i18n.js';
/** Liyuan's host API/DOM adapter. Upstream extension bytes are imported unchanged. */
const unsupported = name => { throw new Error(`梨园酒馆兼容宿主尚不支持 ${name}；没有执行或修改故事`); };
class Events {
 constructor() { this.listeners = new Map(); }
 on(event, fn) { const list = this.listeners.get(event) ?? []; list.push(fn); this.listeners.set(event, list); return fn; }
 makeFirst(event, fn) { const list = this.listeners.get(event) ?? []; list.unshift(fn); this.listeners.set(event, list); return fn; }
 makeLast(event, fn) { return this.on(event, fn); }
 once(event, fn) { const wrapped = async (...args) => { this.removeListener(event, wrapped); return fn(...args); }; this.on(event, wrapped); return wrapped; }
 removeListener(event, fn) { this.listeners.set(event, (this.listeners.get(event) ?? []).filter(f => f !== fn)); }
 off(event, fn) { this.removeListener(event, fn); }
 removeAllListeners(event) { event === undefined ? this.listeners.clear() : this.listeners.delete(event); }
 async emit(event, ...args) { for (const fn of [...(this.listeners.get(event) ?? [])]) await fn(...args); }
}
const eventNames = ['APP_READY','CHAT_CHANGED','CHAT_CREATED','SETTINGS_LOADED','SETTINGS_UPDATED','CHARACTER_EDITED','CHARACTER_DELETED','CHARACTER_DUPLICATED','CHARACTER_MESSAGE_RENDERED','USER_MESSAGE_RENDERED','MESSAGE_RECEIVED','MESSAGE_SENT','MESSAGE_UPDATED','MESSAGE_DELETED','MESSAGE_SWIPED','MESSAGE_SWIPE_DELETED','MORE_MESSAGES_LOADED','GENERATION_STARTED','GENERATION_STOPPED','GENERATION_ENDED','GENERATION_AFTER_COMMANDS','GENERATE_AFTER_DATA','CHAT_COMPLETION_SETTINGS_READY','CHAT_COMPLETION_PROMPT_READY','WORLDINFO_ENTRIES_LOADED','WORLDINFO_UPDATED','WORLD_INFO_ACTIVATED','OAI_PRESET_CHANGED_BEFORE','OAI_PRESET_CHANGED_AFTER','OAI_PRESET_EXPORT_READY'];
const event_types = Object.fromEntries(eventNames.map(k => [k, k.toLowerCase()]));
Object.assign(event_types,{"APP_READY": "app_ready", "EXTRAS_CONNECTED": "extras_connected", "MESSAGE_SWIPED": "message_swiped", "MESSAGE_SENT": "message_sent", "MESSAGE_RECEIVED": "message_received", "MESSAGE_EDITED": "message_edited", "MESSAGE_DELETED": "message_deleted", "MESSAGE_UPDATED": "message_updated", "MESSAGE_FILE_EMBEDDED": "message_file_embedded", "MESSAGE_REASONING_EDITED": "message_reasoning_edited", "MESSAGE_REASONING_DELETED": "message_reasoning_deleted", "MORE_MESSAGES_LOADED": "more_messages_loaded", "IMPERSONATE_READY": "impersonate_ready", "CHAT_CHANGED": "chat_id_changed", "GENERATION_AFTER_COMMANDS": "GENERATION_AFTER_COMMANDS", "GENERATION_STARTED": "generation_started", "GENERATION_STOPPED": "generation_stopped", "GENERATION_ENDED": "generation_ended", "SD_PROMPT_PROCESSING": "sd_prompt_processing", "EXTENSIONS_FIRST_LOAD": "extensions_first_load", "EXTENSION_SETTINGS_LOADED": "extension_settings_loaded", "SETTINGS_LOADED": "settings_loaded", "SETTINGS_UPDATED": "settings_updated", "GROUP_UPDATED": "group_updated", "MOVABLE_PANELS_RESET": "movable_panels_reset", "SETTINGS_LOADED_BEFORE": "settings_loaded_before", "SETTINGS_LOADED_AFTER": "settings_loaded_after", "CHATCOMPLETION_SOURCE_CHANGED": "chatcompletion_source_changed", "CHATCOMPLETION_MODEL_CHANGED": "chatcompletion_model_changed", "OAI_PRESET_CHANGED_BEFORE": "oai_preset_changed_before", "OAI_PRESET_CHANGED_AFTER": "oai_preset_changed_after", "OAI_PRESET_EXPORT_READY": "oai_preset_export_ready", "OAI_PRESET_IMPORT_READY": "oai_preset_import_ready", "WORLDINFO_SETTINGS_UPDATED": "worldinfo_settings_updated", "WORLDINFO_UPDATED": "worldinfo_updated", "CHARACTER_EDITED": "character_edited", "CHARACTER_PAGE_LOADED": "character_page_loaded", "CHARACTER_GROUP_OVERLAY_STATE_CHANGE_BEFORE": "character_group_overlay_state_change_before", "CHARACTER_GROUP_OVERLAY_STATE_CHANGE_AFTER": "character_group_overlay_state_change_after", "USER_MESSAGE_RENDERED": "user_message_rendered", "CHARACTER_MESSAGE_RENDERED": "character_message_rendered", "FORCE_SET_BACKGROUND": "force_set_background", "CHAT_DELETED": "chat_deleted", "CHAT_CREATED": "chat_created", "GROUP_CHAT_DELETED": "group_chat_deleted", "GROUP_CHAT_CREATED": "group_chat_created", "GENERATE_BEFORE_COMBINE_PROMPTS": "generate_before_combine_prompts", "GENERATE_AFTER_COMBINE_PROMPTS": "generate_after_combine_prompts", "GENERATE_AFTER_DATA": "generate_after_data", "GROUP_MEMBER_DRAFTED": "group_member_drafted", "GROUP_WRAPPER_STARTED": "group_wrapper_started", "GROUP_WRAPPER_FINISHED": "group_wrapper_finished", "WORLD_INFO_ACTIVATED": "world_info_activated", "TEXT_COMPLETION_SETTINGS_READY": "text_completion_settings_ready", "CHAT_COMPLETION_SETTINGS_READY": "chat_completion_settings_ready", "CHAT_COMPLETION_PROMPT_READY": "chat_completion_prompt_ready", "CHARACTER_FIRST_MESSAGE_SELECTED": "character_first_message_selected", "CHARACTER_DELETED": "characterDeleted", "CHARACTER_DUPLICATED": "character_duplicated", "CHARACTER_RENAMED": "character_renamed", "CHARACTER_RENAMED_IN_PAST_CHAT": "character_renamed_in_past_chat", "SMOOTH_STREAM_TOKEN_RECEIVED": "stream_token_received", "STREAM_TOKEN_RECEIVED": "stream_token_received", "STREAM_REASONING_DONE": "stream_reasoning_done", "FILE_ATTACHMENT_DELETED": "file_attachment_deleted", "WORLDINFO_FORCE_ACTIVATE": "worldinfo_force_activate", "OPEN_CHARACTER_LIBRARY": "open_character_library", "ONLINE_STATUS_CHANGED": "online_status_changed", "IMAGE_SWIPED": "image_swiped", "CONNECTION_PROFILE_LOADED": "connection_profile_loaded", "CONNECTION_PROFILE_CREATED": "connection_profile_created", "CONNECTION_PROFILE_DELETED": "connection_profile_deleted", "CONNECTION_PROFILE_UPDATED": "connection_profile_updated", "TOOL_CALLS_PERFORMED": "tool_calls_performed", "TOOL_CALLS_RENDERED": "tool_calls_rendered", "CHARACTER_MANAGEMENT_DROPDOWN": "charManagementDropdown", "SECRET_WRITTEN": "secret_written", "SECRET_DELETED": "secret_deleted", "SECRET_ROTATED": "secret_rotated", "SECRET_EDITED": "secret_edited", "PRESET_CHANGED": "preset_changed", "PRESET_DELETED": "preset_deleted", "MAIN_API_CHANGED": "main_api_changed", "WORLDINFO_ENTRIES_LOADED": "worldinfo_entries_loaded"});
const eventSource = new Events();
const clone = value => JSON.parse(JSON.stringify(value ?? {}));
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const cloneReferenceValue = value => value === null ? null : typeof value === 'object' ? clone(value) : value;
function canSyncReferences(value) {
 if (value === null || typeof value !== 'object') return false;
 // ESM namespaces have exotic read-only [[Set]] even when export descriptors
 // advertise writable:true. Treat them and other readonly containers as atoms.
 if (Object.getOwnPropertyDescriptor(value, Symbol.toStringTag)?.value === 'Module' || !Object.isExtensible(value)) return false;
 for (const key of Reflect.ownKeys(value)) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (Array.isArray(value) && key === 'length') { if (!descriptor.writable) return false; continue; }
  if (!Object.hasOwn(descriptor, 'value') || !descriptor.writable || !descriptor.configurable) return false;
 }
 return true;
}
function syncReferences(target, source) {
 if (target === source) return target;
 if (!canSyncReferences(target) || !canSyncReferences(source)) return source;
 if (Array.isArray(target) && Array.isArray(source)) {
  const next=source.map((value,index)=>{
   const current=target[index];
   if(Array.isArray(current)&&Array.isArray(value))return syncReferences(current,value);
   if(isRecord(current)&&isRecord(value))return syncReferences(current,value);
   return value;
  });
  target.splice(0,target.length,...next);return target;
 }
 if(isRecord(target)&&isRecord(source)){
  for(const key of Object.keys(target))if(!Object.hasOwn(source,key))delete target[key];
  for(const [key,value] of Object.entries(source)){
   target[key]=syncReferences(target[key],value);
  }
  return target;
 }
 return source;
}
function syncMutable(target, source) {
 if (Array.isArray(target) && Array.isArray(source)) {
  const next = source.map((value, index) => {
   const current = target[index];
   if (Array.isArray(current) && Array.isArray(value)) return syncMutable(current, value);
   if (isRecord(current) && isRecord(value)) return syncMutable(current, value);
   return cloneReferenceValue(value);
  });
  target.splice(0, target.length, ...next);
  return target;
 }
 if (isRecord(target) && isRecord(source)) {
  for (const key of Object.keys(target)) if (!Object.hasOwn(source, key)) delete target[key];
  for (const [key, value] of Object.entries(source)) {
   const current = target[key];
   if (Array.isArray(current) && Array.isArray(value)) syncMutable(current, value);
   else if (isRecord(current) && isRecord(value)) syncMutable(current, value);
   else target[key] = cloneReferenceValue(value);
  }
  return target;
 }
 return clone(source);
}
function sameJSON(left,right) {
 if(Object.is(left,right))return true;
 if(!left||!right||typeof left!=='object'||typeof right!=='object'||Array.isArray(left)!==Array.isArray(right))return false;
 const keys=Object.keys(left);return keys.length===Object.keys(right).length&&keys.every(key=>Object.hasOwn(right,key)&&sameJSON(left[key],right[key]));
}
const host = {
 context: null, displayProjection:0, canonicalMes:new Map(), chat: [], characters: [], metadata: {}, extensions: {}, books: {}, modules: {}, prompts: {}, presets: [], pending: false, saving: Promise.resolve(), saveGeneration:0, bindingGeneration:0, pendingBindingGeneration:0, pendingContext:null, errors: [], generating: false,
 async request(path, body, binding=this.context, signal) {
  const response = await fetch('/api/tavern-plugins' + path, { method: body === undefined ? 'GET' : 'POST', ...(signal?{signal}:{}), headers: { 'content-type': 'application/json', ...(binding ? {'x-liyuan-tavern-scope':binding.scopeKey,'x-liyuan-tavern-source':binding.sourceEntryId} : {}) }, ...(body === undefined ? {} : {body:JSON.stringify(body)}) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error ?? '酒馆插件宿主请求失败'); return data;
 },
 async bind(context) {
  this.bindingGeneration++;
  this.pending=false;this.pendingBindingGeneration=0;this.pendingContext=null;
  this.context = context;
  this.persistedStateJSON=JSON.stringify(context.state);
  this.canonicalMes=new Map(context.chat.map(m=>[m.__liyuanEntryId,m.mes]));
  syncMutable(this.chat, clone(context.chat));
  syncMutable(this.metadata, clone(context.state.chatMetadata));
  syncMutable(this.extensions, clone(context.state.extensionSettings));
  // A message-render realm is not the script-management UI. Never enable disabled
  // character/preset automation here, or let its first-use consent cover the card UI.
  // This is a realm-local "already asked" overlay, masked out of every saved state.
  this.renderScriptConsent=undefined;
  if(new URLSearchParams(location.search).get('view')==='render'&&
   context.plugins?.some(plugin=>plugin.id==='helper'&&plugin.enabled)&&
   (this.extensions.tavern_helper===undefined||this.extensions.tavern_helper&&typeof this.extensions.tavern_helper==='object'&&!Array.isArray(this.extensions.tavern_helper))&&
   (this.extensions.tavern_helper?.script===undefined||this.extensions.tavern_helper.script&&typeof this.extensions.tavern_helper.script==='object'&&!Array.isArray(this.extensions.tavern_helper.script))){
   const settings=this.extensions.tavern_helper??={},script=settings.script??={};
   const hasPopuped=Object.hasOwn(script,'popuped'),popuped=clone(script.popuped);
   if(script.popuped===undefined||script.popuped&&typeof script.popuped==='object'&&!Array.isArray(script.popuped)){
    this.renderScriptConsent={context,hasPopuped,popuped};
    const overlay=script.popuped??={};
    for(const [key,value] of [['characters',context.character?.avatar],['presets',context.preset?.name]]){
     if(typeof value==='string'&&value&&(!Object.hasOwn(overlay,key)||Array.isArray(overlay[key])))overlay[key]=[...new Set([...(overlay[key]??[]),value])];
    }
   }
  }
  syncMutable(this.books, clone(context.state.worldbooks));
  this.extensions.variables ??= {global:{}};this.extensions.note??={allowWIScan:false}; this.extensions.regex ??= [];this.extensions.disabledExtensions??=[];this.extensions.quickReplyV2 ??= {config:{setList:[]},chatConfig:{setList:[]}};
  this.extensions.EjsTemplate ??= {}; if (!Object.hasOwn(this.extensions.EjsTemplate,'compile_workers')) this.extensions.EjsTemplate.compile_workers = false;
  const cardData = Object.assign({description:'',personality:'',scenario:'',first_mes:'',mes_example:'',creatorcomment:'',talkativeness:0.5},clone(context.character)); cardData.data ??= clone(cardData); cardData.data = Object.assign({creator_notes:'',system_prompt:'',post_history_instructions:'',tags:[],extensions:{}},cardData.data); cardData.data.extensions = {...cardData.data.extensions,...clone(context.state.characterExtensions)}; cardData.extensions = cardData.data.extensions; cardData.avatar ??= 'liyuan-current.png';
  const card=this.characters[0]??{};syncMutable(card,cardData);this.characters.splice(0,this.characters.length,card);
  const presetData = clone(context.preset ?? {name:'梨园当前预设',prompts:[],extensions:{}}); Object.assign(presetData,{send_if_empty:presetData.send_if_empty??'',openai_model:context.model?.id??'',chat_completion_source:'openai',openai_max_tokens:4096,max_context:context.model?.contextWindow??32768,prompt_order:presetData.prompt_order??[]});presetData.extensions = {...presetData.extensions,...clone(context.state.presetExtensions)};
  const preset=this.presets[0]??{};syncMutable(preset,presetData);this.presets.splice(0,this.presets.length,preset);
  for (const msg of this.chat) { const fields=context.state.messages[msg.__liyuanEntryId]; if(fields)Object.assign(msg,clone(fields)); }
   if(new URLSearchParams(location.search).get('mvuRetry')==='1'){
    const msg=this.chat.at(-1),id=context.sourceEntryId,global=this.extensions.variables.global;
    if(msg?.__liyuanEntryId===id)this.mvuRetryBaseline={context,id,hasVariables:Object.hasOwn(msg,'variables'),variables:clone(msg.variables),receipt:context.state.chatMetadata.__liyuanMvuProcessed?.[id],hasExtraAnalysis:Object.hasOwn(global,'extra_analysis'),extraAnalysis:global.extra_analysis};
   }
  this.installModules(); this.renderChat();
 },
 // Adopt a newer *saved* variable snapshot without rebinding modules, replacing
 // message DOM, emitting chat/generation hooks, or restarting enabled scripts.
 refreshDisplayState(snapshot) {
  const current=this.context,fail=()=>{throw new Error('变量显示来源或配置已变化，请重新连接原卡界面');};
  if(new URLSearchParams(location.search).get('view')!=='render'||!current||!snapshot)fail();
  for(const key of ['sessionId','card','scopeKey','sourceEntryId'])if(snapshot[key]!==current[key])fail();
  if(!Number.isSafeInteger(snapshot.revision)||snapshot.revision<current.revision)fail();
  if(this.chat.some(message=>message.mes!==this.canonicalMes.get(message.__liyuanEntryId)))fail();
  if(!Array.isArray(snapshot.chat)||snapshot.chat.length!==this.chat.length||snapshot.chat.some((message,index)=>message.__liyuanEntryId!==this.chat[index].__liyuanEntryId||message.mes!==this.canonicalMes.get(message.__liyuanEntryId)||(message.swipe_id??0)!==(this.chat[index].swipe_id??0)))fail();
  if(snapshot.revision===current.revision){if(!sameJSON(snapshot.state,current.state))fail();return {changed:false,variablesChanged:false};}
  if(this.displayBootstrap||this.pending||JSON.stringify(this.state())!==this.persistedStateJSON)throw new Error('原卡有尚未保存的变量修改，未用后台快照覆盖');
  const state=this.state(),withoutVariables=value=>{
   const settings=clone(value);delete settings.variables;
   // Render-only consent is masked out of saved state. Its latest durable
   // bookkeeping may change without granting any script enablement.
   if(this.renderScriptConsent&&settings.tavern_helper?.script)delete settings.tavern_helper.script.popuped;
   return settings;
  };
  // A settings change is not authority to start/stop/reload a script in this
  // read-only path. Native normalization already equal to the saved state is OK.
  for(const key of ['extensionSettings','characterExtensions','presetExtensions','worldbooks']){
   const project=key==='extensionSettings'?withoutVariables:value=>value;
   if(!sameJSON(project(snapshot.state[key]),project(current.state[key]))&&!sameJSON(project(snapshot.state[key]),project(state[key])))fail();
  }
  const variableView=value=>({messages:Object.fromEntries(Object.entries(value.messages).map(([id,fields])=>[id,fields.variables])),chat:value.chatMetadata.variables,global:value.extensionSettings.variables});
  const variablesChanged=!sameJSON(variableView(state),variableView(snapshot.state));
  for(const message of this.chat){
   const fields=snapshot.state.messages[message.__liyuanEntryId]??{};
   for(const key of ['variables','extra']){
    if(Object.hasOwn(fields,key))message[key]=syncMutable(message[key],clone(fields[key]));else delete message[key];
   }
  }
  syncMutable(this.metadata,clone(snapshot.state.chatMetadata));
  this.extensions.variables=syncMutable(this.extensions.variables,clone(snapshot.state.extensionSettings.variables??{global:{}}));
  current.revision=snapshot.revision;current.state=clone(snapshot.state);
  if(this.renderScriptConsent?.context===current){const script=snapshot.state.extensionSettings.tavern_helper?.script;this.renderScriptConsent.hasPopuped=!!script&&Object.hasOwn(script,'popuped');this.renderScriptConsent.popuped=clone(script?.popuped);}
  this.persistedStateJSON=JSON.stringify(this.state());
  return {changed:true,variablesChanged};
 },
  state() {
   const messages={}; for(const msg of this.chat) { if(!msg.__liyuanEntryId)continue; messages[msg.__liyuanEntryId]={...(msg.variables!==undefined?{variables:clone(msg.variables)}:{}),...(msg.extra?{extra:clone(msg.extra)}:{})}; }
   const state={chatMetadata:clone(this.metadata),extensionSettings:clone(this.extensions),characterExtensions:clone(this.characters[0]?.data?.extensions),presetExtensions:clone(this.presets[0]?.extensions),messages,worldbooks:clone(this.books)};
   const consent=this.renderScriptConsent;
   if(consent&&consent.context===this.context){
    const script=state.extensionSettings.tavern_helper?.script;
    if(script){if(consent.hasPopuped)script.popuped=clone(consent.popuped);else delete script.popuped;}
   }
   const retry=this.mvuRetryBaseline;
   if(retry&&retry.context===this.context){
    if(retry.hasVariables)state.messages[retry.id].variables=clone(retry.variables);else delete state.messages[retry.id].variables;
    state.chatMetadata.__liyuanMvuProcessed??={};if(retry.receipt===undefined)delete state.chatMetadata.__liyuanMvuProcessed[retry.id];else state.chatMetadata.__liyuanMvuProcessed[retry.id]=clone(retry.receipt);
    state.extensionSettings.variables??={global:{}};state.extensionSettings.variables.global??={};
    if(retry.hasExtraAnalysis)state.extensionSettings.variables.global.extra_analysis=retry.extraAnalysis;else delete state.extensionSettings.variables.global.extra_analysis;
   }
   return state;
 },
 save() {
  // Native render initialization may normalize defaults/register schemas. These
  // are view-local until an actual later change; sibling display frames must not
  // race to rewrite a shared state snapshot merely because a message was opened.
  if(!this.displayProjection&&(this.chat.length!==this.canonicalMes.size||this.chat.some(m=>!this.canonicalMes.has(m.__liyuanEntryId)||m.mes!==this.canonicalMes.get(m.__liyuanEntryId))))throw new Error('原插件宿主只保存派生变量；改写、增删故事请用梨园编辑/重Roll，未提交故事变更');
  if(this.displayBootstrap)return Promise.resolve();
  const context=this.context, bindingGeneration=this.bindingGeneration, saveGeneration=++this.saveGeneration;
  if(!context)throw new Error('酒馆插件尚未绑定会话');
  this.pending=true;this.pendingBindingGeneration=bindingGeneration;this.pendingContext=context;
  const operation=this.saving.catch(()=>{}).then(async()=>{
   if(bindingGeneration!==this.bindingGeneration||context!==this.context)throw new Error('会话或分支已变化，旧插件状态不会写入新作用域');
   const persistedState=this.state();const persistedStateJSON=JSON.stringify(persistedState);
   if(persistedStateJSON===this.persistedStateJSON){if(saveGeneration===this.saveGeneration)this.pending=false;return;}
   const result=await this.request('/state',{revision:context.revision,state:persistedState},{scopeKey:context.scopeKey,sourceEntryId:context.sourceEntryId});
   if(bindingGeneration===this.bindingGeneration&&context===this.context){context.revision=result.revision;context.state=clone(persistedState);this.persistedStateJSON=persistedStateJSON;if(saveGeneration===this.saveGeneration)this.pending=false;}
  });
  this.saving=operation;
  operation.catch(error=>{this.errors.push(error.message);window.dispatchEvent(new CustomEvent('liyuan-plugin-error',{detail:error.message}));}); return operation;
 },
 async flush(){
  if(this.displayBootstrap)return;
  try{await this.saving;if(JSON.stringify(this.state())!==this.persistedStateJSON)await this.save();return await this.saving;}
  catch(error){
   if(!this.pending||this.pendingBindingGeneration!==this.bindingGeneration||this.pendingContext!==this.context)throw error;
   return this.save();
  }
 },
 getContext(){return {...this.modules['/script.js'],getCurrentLocale,chat:this.chat,characters:this.characters,chatMetadata:this.metadata,extensionSettings:this.extensions,extensionPrompts:this.prompts,eventSource,eventTypes:event_types,characterId:0,groupId:null,name1:this.context?.userName??'用户',name2:this.characters[0]?.name??'角色',saveChat:()=>this.save(),saveChatConditional:()=>this.save(),saveMetadata:()=>this.save(),getRequestHeaders:()=>({'content-type':'application/json'}),writeExtensionField:async(_id,key,value)=>{this.characters[0].data.extensions[key]=value;await this.save();}};},
 format(text){if(!window.showdown)return String(text);this.markdownConverter??=new showdown.Converter({tables:true,ghCodeBlocks:true});return this.markdownConverter.makeHtml(String(text));},
 renderChat(){const el=document.querySelector('#chat');if(!el)return;el.innerHTML='';this.chat.forEach((msg,index)=>{const node=document.createElement('div');node.className='mes';node.setAttribute('mesid',String(index));node.setAttribute('is_user',String(!!msg.is_user));node.innerHTML='<div class="mes_block"><div class="mes_text"></div></div>';node.querySelector('.mes_text').innerHTML=this.format(msg.mes);el.append(node);});},
 async book(name){const value=this.books[name]??this.context.readonlyBooks[name];if(!value)throw new Error(`找不到世界书 ${name}`);const entries=Array.isArray(value.entries)?Object.fromEntries(value.entries.map(e=>[e.uid,e])):value.entries;return {entries:clone(entries)};},
 async saveBook(name,data){if(Object.hasOwn(this.context.readonlyBooks,name))throw new Error('原卡和挂载世界书只读；请使用梨园世界书面板');this.books[name]={entries:Object.values(clone(data.entries??{}))};await this.save();},
 installModules(){
  const self=this,card=this.characters[0],names=Object.keys({...this.context.readonlyBooks,...this.books});
    const subst=(text,other={})=>String(text??'').replace(/\{\{(user|char)\}\}/gi,(_,key)=>key.toLowerCase()==='user'?self.context.userName:card.name).replace(/\{\{(\w+)\}\}/g,(all,key)=>Object.hasOwn(other,key)?String(other[key]):key==='lastMessageId'?String(self.chat.length-1):macros.has(key)?String(macros.get(key)()):all);
  const save=()=>self.save(), readonly=name=>(..._args)=>unsupported(name), empty=()=>{};
  const role={SYSTEM:0,USER:1,ASSISTANT:2}, placement={BEFORE_PROMPT:0,IN_PROMPT:1,AFTER_PROMPT:2,IN_CHAT:1};
  const script={
   chat:this.chat,characters:this.characters,chat_metadata:this.metadata,this_chid:'0',name1:this.context.userName,name2:card.name,main_api:'openai',online_status:this.context.model?.id??'no_connection',nai_settings:{},user_avatar:'user.png',default_avatar:'none.png',default_user_avatar:'user.png',system_avatar:'none.png',is_send_press:false,MAX_INJECTION_DEPTH:10000,
   eventSource,event_types,ToolManager:{isToolCallingSupported:()=>false,isToolCallingEnabled:()=>false,registerFunctionTool:readonly("酒馆独立工具模式尚未投射到正文Agent"),unregisterFunctionTool:()=>{}},extension_prompt_roles:role,extension_prompt_types:placement,extension_prompts:this.prompts,system_message_types:{},
   getCurrentChatId:()=>self.context.sessionId,getRequestHeaders:()=>({'Content-Type':'application/json','x-liyuan-tavern-revision':String(self.context.revision),'x-liyuan-tavern-scope':self.context.scopeKey,'x-liyuan-tavern-source':self.context.sourceEntryId}),
   substituteParams:subst,substituteParamsExtended:subst,messageFormatting:txt=>self.format(txt),getMaxContextSize:()=>self.context.model?.contextWindow??32768,
   saveSettingsDebounced:save,saveSettings:save,saveChatConditional:save,saveMetadata:save,saveCharacterDebounced:save,
   getCharacters:async()=>self.characters,getOneCharacter:async()=>card,unshallowCharacter:async()=>card,getCharacterCardFields:()=>({description:card.description??'',personality:card.personality??'',scenario:card.scenario??'',persona:self.context.userPersona??'',mesExamples:card.mes_example??'',system:card.data.system_prompt??'',jailbreak:card.data.post_history_instructions??''}),
   getThumbnailUrl:()=>'',getUserAvatar:()=>'',getBiasStrings:()=>({promptBias:''}),parseMesExamples:()=>[],countOccurrences:(s,q)=>String(s).split(q).length-1,isOdd:n=>n%2===1,
   setExtensionPrompt:(name,value,position=0,depth=0,scan=false,promptRole=0)=>{self.prompts[name]={value,position,depth,scan,role:promptRole};},getExtensionPromptRoleByName:name=>role[String(name).toUpperCase()]??0,
   updateMessageBlock:index=>{const node=document.querySelector(`.mes[mesid="${index}"] .mes_text`);if(node)node.innerHTML=self.format(self.chat[index]?.mes??'');},appendMediaToMessage:empty,addCopyToCodeBlocks:empty,
   printMessages:()=>self.renderChat(),printCharacters:empty,scrollChatToBottom:empty,showSwipeButtons:empty,activateSendButtons:empty,deactivateSendButtons:empty,setGenerationProgress:empty,reloadMarkdownProcessor:empty,
   reloadCurrentChat:async()=>self.renderChat(),cleanUpMessage:txt=>String(txt),stopGeneration:()=>self.request('/cancel',{}),
   Generate:async()=>unsupported('Generate直接续写（请从梨园主输入框提交）'),addOneMessage:readonly('新增故事消息'),baseChatReplace:text=>subst(text??''),clearChat:readonly('清空故事'),deleteCharacter:readonly('删除生产卡'),selectCharacterById:readonly('脚本切卡'),setUserName:readonly('脚本修改用户身份'),getPastCharacterChats:async()=>[],
  };
   const pm={getAllPresets:()=>self.presets.map(p=>p.name),getPresetList:()=>({presets:self.presets,preset_names:{[self.presets[0].name??'梨园当前预设']:0}}),getSelectedPreset:()=> '0',getSelectedPresetName:()=>self.presets[0].name??'梨园当前预设',savePreset:async(_name,preset)=>{self.presets[0].extensions=clone(preset.extensions);await self.save();},selectPreset:readonly('脚本切换预设'),updateList:empty};
  const worldPrompt=async history=>{
   const data={characterLore:[],globalLore:[],personaLore:[],chatLore:[],type:"normal"};for(const name of names){const book=await self.book(name);for(const entry of Object.values(book.entries))data[name===card.data.extensions.world?"characterLore":"globalLore"].push({...entry,world:name});}
   await eventSource.emit(event_types.WORLDINFO_ENTRIES_LOADED,data);const haystack=(history??[]).map(String).join('\n').toLowerCase();const active=[...data.characterLore,...data.globalLore].filter(e=>!e.disable&&e.enabled!==false&&(e.constant||(e.key??[]).some(key=>haystack.includes(String(key).toLowerCase())))&&(!e.selective||(e.keysecondary??[]).some(key=>haystack.includes(String(key).toLowerCase())))).sort((a,b)=>(a.order??100)-(b.order??100));
   const before=[],after=[],depth=[];for(const entry of active){const position=entry.position??entry.extensions?.position??0;if(position===0)before.push(entry.content);else if(position===1)after.push(entry.content);else if(position===4)depth.push({depth:entry.depth??4,role:entry.role??0,entries:[entry.content]});else throw new Error('当前脚本生成不支持此世界书位置，未悄悄移位：'+position);}
   await eventSource.emit(event_types.WORLD_INFO_ACTIVATED,active);return {worldInfoString:[...before,...after].join('\n'),worldInfoBefore:before.join('\n'),worldInfoAfter:after.join('\n'),worldInfoDepth:depth,worldInfoExamples:[]};
  };
  const world={DEFAULT_DEPTH:4,DEFAULT_WEIGHT:100,METADATA_KEY:'world_info',world_names:names,selected_world_info:names,world_info:{globalSelect:[],charLore:[{name:card.avatar.replace(/\.png$/,''),extraBooks:names.slice(1)}]},world_info_include_names:false,
   world_info_logic:{AND_ANY:0,NOT_ALL:1,NOT_ANY:2,AND_ALL:3},world_info_position:{before:0,after:1,ANTop:2,ANBottom:3,atDepth:4},wi_anchor_position:{before:0,after:1},
   loadWorldInfo:name=>self.book(name),saveWorldInfo:(name,data)=>self.saveBook(name,data),createNewWorldInfo:async name=>{await self.saveBook(name,{entries:{}});},deleteWorldInfo:async name=>{if(Object.hasOwn(self.context.readonlyBooks,name))throw new Error('原世界书只读');delete self.books[name];await self.save();},
   convertCharacterBook:book=>({entries:Object.fromEntries((book?.entries??[]).map(e=>[e.id??e.uid,{...e,uid:e.id??e.uid,key:e.keys??e.key??[],disable:e.enabled===false,constant:!!e.constant}]))}),newWorldInfoEntryTemplate:{uid:0,key:[],keysecondary:[],content:'',comment:'',constant:false,disable:false,position:0,depth:4,order:100},
   getWorldInfoSettings:()=>({world_info:world.world_info,world_names:names,world_info_depth:4,world_info_budget:25,world_info_recursive:true}),setWorldInfoButtonClass:empty,parseRegexFromString:value=>{const m=String(value).match(/^\/(.*)\/([a-z]*)$/);return m?new RegExp(m[1],m[2]):null;},getWorldInfoPrompt:worldPrompt,
  };
  class Value{constructor(props={}){Object.assign(this,props);}static fromProps(props){return new this(props);}static fromJSON(props){return new this(props);}}
  class Message{constructor(role,content,identifier){this.role=role;this.content=content;this.identifier=identifier;this.tokens=Math.ceil(String(content??'').length/3);}static async createAsync(role,content,id){return new Message(role,content,id);}static async fromPromptAsync(prompt){return new Message(prompt.role,prompt.content,prompt.identifier);}getChat(){return {role:this.role,content:this.content};}getTokens(){return this.tokens;}async addImage(){unsupported('脚本生成图像输入');}}
  class Collection{constructor(identifier='',...items){this.identifier=identifier;this.collection=items;}add(item){this.collection.push(item);}has(id){return this.collection.some(m=>m.identifier===id);}get(id){return this.collection.find(m=>m.identifier===id);}getChat(){return this.collection.flatMap(m=>{const item=m.getChat?m.getChat():{role:m.role,content:m.content};return Array.isArray(item)?item:[item];});}getTokens(){return this.collection.reduce((n,m)=>n+(m.getTokens?.()??m.tokens??0),0);}}
  class ChatCompletion extends Collection{constructor(){super('completion');this.entries=new Map();this.budget=32768;}setTokenBudget(context,output){this.budget=(context??32768)-(output??4096);}reserveBudget(item){this.budget-=typeof item==='number'?item:item.getTokens();}freeBudget(item){this.budget+=typeof item==='number'?item:item.getTokens();}canAfford(item){return item.getTokens()<=this.budget;}add(item,position){this.entries.set(position??this.entries.size,item);this.collection=[...this.entries].sort((a,b)=>a[0]-b[0]).map(e=>e[1]);}async squashSystemMessages(){}}
  class PromptCollection extends Collection{}
  const commands=new Map();class SlashCommandParser{static addCommandObject(cmd){commands.set(cmd.name,cmd);}static addCommand(cmd){commands.set(cmd.name,cmd);}}
   const macros=new Map();class MacrosParser{static registerMacro(name,fn){macros.set(name,fn);}static unregisterMacro(name){macros.delete(name);}static get macros(){return macros;}}
   Object.assign(script,{registerMacro:MacrosParser.registerMacro,unregisterMacro:MacrosParser.unregisterMacro});
    // Native helper takes its bounded history from the newest-first OpenAI projection.
    const chatMessages=messages=>clone(messages).reverse().map(m=>m.role?m:{role:m.is_user?'user':m.is_system?'system':'assistant',content:m.mes??'',name:m.name});
  const regexPlacement={MD_DISPLAY:1,PROMPT:2,CHARACTER_DESCRIPTION:3,USER_INPUT:1,AI_OUTPUT:2,SLASH_COMMAND:3,WORLD_INFO:5};
  const power={context:{},persona_description:self.context.userPersona??'',persona_description_position:0,persona_description_depth:4,world_info_depth:4,world_info_min_activations:0,world_info_budget:100,world_info_recursive:false,world_info_case_sensitive:false,world_info_match_whole_words:false,wiActivated:{}};
  Object.assign(script,{loadWorldInfo:world.loadWorldInfo,world_info:world.world_info,selected_world_info:world.selected_world_info,selected_global_lorebooks:world.selected_world_info,world_info_depth:4,world_info_budget:25,world_info_recursive:true,getPresetManager:()=>pm});
  const nextModules={
   '/script.js':script,'/scripts/extensions.js':{extension_settings:this.extensions,extensionTypes:{SYSTEM:0,LOCAL:1,GLOBAL:2},getContext:()=>self.getContext(),saveMetadataDebounced:save,renderExtensionTemplateAsync:async(name,file)=>{const slug=name.split('/').at(-1);const response=await fetch(`/tavern-compat/scripts/extensions/third-party/${slug}/${file}.html`);if(!response.ok)throw new Error('原插件设置模板缺失');return localizeTemplate(await response.text());}},
   '/scripts/world-info.js':world,'/scripts/preset-manager.js':{getPresetManager:()=>pm},'/scripts/macros.js':{MacrosParser,getLastMessageId:()=>self.chat.length-1},
    '/scripts/openai.js':{oai_settings:this.presets[0],chat_completion_sources:{OPENAI:'openai',CUSTOM:'custom',CLAUDE:'claude',OPENROUTER:'openrouter',MAKERSUITE:'makersuite',VERTEXAI:'vertexai',DEEPSEEK:'deepseek',XAI:'xai',AZURE_OPENAI:'azure_openai'},openai_max_stop_strings:4,getChatCompletionModel:()=>self.context.model?.id??'',promptManager:{serviceSettings:{},getPromptCollection:()=>({collection:self.presets[0].prompts??[]}),getPromptById:id=>self.presets[0].prompts?.find(p=>p.identifier===id)},ChatCompletion,Message,MessageCollection:Collection,proxies:[],isImageInliningSupported:()=>false,sendOpenAIRequest:async(_type,messages)=>self.request('/generate',{messages:messages.map(m=>({role:m.role,content:typeof m.content==='string'?m.content:(m.content??[]).filter(p=>p.type==='text').map(p=>p.text??'').join('')}))}),prepareOpenAIMessages:empty,setOpenAIMessages:messages=>clone(messages),setOpenAIMessageExamples:messages=>clone(messages??[]),setupChatCompletionPromptManager:empty,getStreamingReply:readonly('独立正文流'),tryParseStreamingError:empty},
   '/scripts/utils.js':{delay:ms=>new Promise(r=>setTimeout(r,ms)),uuidv4:()=>crypto.randomUUID(),getCharaFilename:id=>self.characters[id??0]?.avatar?.replace(/\.png$/,'')??'liyuan-current',getStringHash:s=>[...String(s)].reduce((a,c)=>(Math.imul(31,a)+c.charCodeAt(0))|0,0),regexFromString:value=>{try{const m=String(value).match(/^\/(.*)\/([a-z]*)$/);return m?new RegExp(m[1],m[2]):new RegExp(value,'g');}catch{return null;}},getSanitizedFilename:s=>String(s).replace(/[\\/:*?"<>|]/g,'_'),isDataURL:s=>String(s).startsWith('data:'),copyText:s=>navigator.clipboard?.writeText(String(s)),ensureImageFormatSupported:async f=>f,Stopwatch:class{constructor(){this.start=Date.now();}get elapsed(){return Date.now()-this.start;}},download:(text,name)=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([text]));a.download=name??'download.txt';a.click();},getBase64Async:async file=>new Promise((r,j)=>{const f=new FileReader();f.onload=()=>r(f.result);f.onerror=j;f.readAsDataURL(file);}),getImageSizeFromDataURL:src=>new Promise((resolve,reject)=>{const image=new Image();image.onload=()=>resolve({width:image.naturalWidth,height:image.naturalHeight});image.onerror=()=>reject(new Error('图像无法解码'));image.src=src;}),showFontAwesomePicker:async()=>null},
   '/scripts/i18n.js':{getCurrentLocale,t},
    '/scripts/extensions/regex/engine.js':{regex_placement:regexPlacement,getRegexedString:text=>text},'/scripts/power-user.js':{power_user:power,getCustomStoppingStrings:()=>[],flushEphemeralStoppingStrings:empty,persona_description_positions:{IN_PROMPT:0,AT_DEPTH:1}},
    '/scripts/group-chats.js':{groups:[],selected_group:null,getGroupNames:()=>[],getGroupMembers:()=>[]},'/scripts/user.js':{isAdmin:()=>false},'/scripts/RossAscends-mods.js':{isMobile:()=>innerWidth<700,favsToHotswap:empty},'/scripts/authors-note.js':{NOTE_MODULE_NAME:'2_floating_prompt',metadata_keys:{prompt:'note_prompt',depth:'note_depth',position:'note_position'},shouldWIAddPrompt:()=>false},
   '/scripts/PromptManager.js':{Prompt:Value,PromptCollection},'/scripts/reasoning.js':{extractReasoningFromData:()=>'',updateReasoningUI:()=>{},parseReasoningFromString:text=>({content:text,reasoning:''})},'/scripts/sse-stream.js':{getEventSourceStream:readonly('独立SSE故事流')},'/scripts/personas.js':{user_avatar:'user.png',getUserAvatar:()=>'',getUserAvatars:async()=>[],setUserAvatar:readonly('脚本修改生产身份')},
   '/scripts/slash-commands.js':{executeSlashCommandsWithOptions:async command=>{const match=String(command).match(/^\/([\w-]+)\s*(.*)$/s);const cmd=match&&commands.get(match[1]);if(!cmd)throw new Error('未实现的脚本命令；没有转发到系统命令');return {pipe:await cmd.callback({},match[2]),isAborted:false};}},
   '/scripts/slash-commands/SlashCommand.js':{SlashCommand:Value},'/scripts/slash-commands/SlashCommandArgument.js':{SlashCommandArgument:Value,SlashCommandNamedArgument:Value,ARGUMENT_TYPE:{STRING:'string',NUMBER:'number',BOOLEAN:'boolean',LIST:'list',DICTIONARY:'dictionary'}},'/scripts/slash-commands/SlashCommandParser.js':{SlashCommandParser},'/scripts/slash-commands/SlashCommandCommonEnumsProvider.js':{commonEnumProviders:{boolean:()=>()=>[{value:'true',description:'true'},{value:'false',description:'false'}]},enumIcons:{}},'/scripts/slash-commands/SlashCommandEnumValue.js':{SlashCommandEnumValue:Value,enumTypes:{enum:0}},
   '/scripts/popup.js':{POPUP_TYPE:{TEXT:1,CONFIRM:2,INPUT:3},callGenericPopup:async(content,type)=>{if(type===2)return window.confirm(String(content))?1:0;if(type===3)return window.prompt(String(content));return null;}},'/scripts/tokenizers.js':{getTokenCountAsync:async text=>Math.ceil(String(text).length/3)},'/scripts/events.js':{EventSource:Events,eventSource,event_types},'/lib.js':{yaml:window.YAML},
  };
   for(const path of Object.keys(this.modules))if(!Object.hasOwn(nextModules,path))delete this.modules[path];
   nextModules['/scripts/openai.js'].setOpenAIMessages=chatMessages;
  for(const [path,values] of Object.entries(nextModules))this.modules[path]=syncReferences(this.modules[path]??{},values);
  globalThis.SillyTavern={getCurrentLocale,getContext:()=>self.getContext(),...self.getContext(),loadWorldInfo:world.loadWorldInfo,getPresetManager:()=>pm};globalThis.t=this.modules['/scripts/i18n.js'].t;
 },
 resolve(path,name){const value=this.modules[path]?.[name];return value===undefined?((..._args)=>unsupported(`${path}:${name}`)):value;},
};
globalThis.LiyuanTavern=host;
export {host,eventSource,event_types,unsupported};
