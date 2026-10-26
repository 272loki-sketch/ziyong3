import assert from 'node:assert/strict';
import test from 'node:test';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';

const context=()=>({sessionId:'synthetic-session',card:'synthetic-card',scopeKey:'synthetic-scope',sourceEntryId:'reply',visibleEntryIds:['reply'],revision:4,chat:[{__liyuanEntryId:'reply',mes:'SYNTHETIC IMMUTABLE STORY',is_user:false,swipe_id:0}],character:{name:'Synthetic',data:{extensions:{}}},preset:{name:'Synthetic',extensions:{}},readonlyBooks:{},plugins:[],state:{chatMetadata:{variables:{counter:1}},extensionSettings:{variables:{global:{synthetic:1}}},characterExtensions:{},presetExtensions:{},messages:{reply:{variables:[{stat_data:{ability:37,obsolete:true}}]}},worldbooks:{}}});
for(const file of ['bridge.js','bridge-worldbooks.js'])test(file+' refreshes only the same saved source without rendering, saving, or losing imported references',async()=>{
 const previous={window:globalThis.window,document:globalThis.document,location:globalThis.location,SillyTavern:globalThis.SillyTavern,LiyuanTavern:globalThis.LiyuanTavern,t:globalThis.t};
 globalThis.window={YAML:{}} as any;globalThis.document={querySelector:()=>null} as any;globalThis.location={search:'?view=render&entryId=reply'} as any;
 try{
  const {host}=await import(pathToFileURL(resolve('web/public/tavern-compat',file)).href+'?refresh='+Date.now());const h=host as any;
  let renders=0,writes=0;h.renderChat=()=>renders++;const start=context();await h.bind(start);h.persistedStateJSON=JSON.stringify(h.state());h.request=async()=>{writes++;throw Error('READ_ONLY');};
  const module=h.modules['/script.js'],message=h.chat[0],slot=message.variables[0],metadata=h.metadata,extensions=h.extensions,global=extensions.variables.global;const next=structuredClone(start);next.revision++;
  next.state.messages.reply.variables[0]={stat_data:{ability:81}} as any;next.state.chatMetadata.variables.counter=2;next.state.extensionSettings.variables.global.synthetic=2;
  assert.deepEqual(h.refreshDisplayState(next),{changed:true,variablesChanged:true});assert.strictEqual(h.chat[0],message);assert.strictEqual(message.variables[0],slot);assert.strictEqual(h.metadata,metadata);assert.strictEqual(h.extensions,extensions);assert.strictEqual(extensions.variables.global,global);assert.strictEqual(h.modules['/script.js'],module);assert.equal(slot.stat_data.ability,81);assert.equal(slot.stat_data.obsolete,undefined);assert.equal(global.synthetic,2);assert.equal(metadata.variables.counter,2);assert.equal(message.mes,'SYNTHETIC IMMUTABLE STORY');assert.equal(renders,1);
  await h.flush();assert.equal(writes,0);assert.deepEqual(h.refreshDisplayState(next),{changed:false,variablesChanged:false});
  for(const patch of [{scopeKey:'foreign'},{sourceEntryId:'foreign'},{sessionId:'foreign'},{card:'foreign'},{revision:3},{chat:[]},{chat:[{...next.chat[0],mes:'OTHER STORY'}]},{chat:[{...next.chat[0],swipe_id:1}]}])assert.throws(()=>h.refreshDisplayState({...next,...patch}),/来源或配置/);
  const wrongSettings=structuredClone(next);wrongSettings.revision++;(wrongSettings.state.extensionSettings as any).tavern_helper={script:{enabled:{global:true}}};assert.throws(()=>h.refreshDisplayState(wrongSettings),/来源或配置/,'saved-state refresh cannot enable scripts');
  message.mes='SYNTHETIC UNAUTHORIZED STORY EDIT';assert.throws(()=>h.refreshDisplayState(next),/来源或配置/);message.mes='SYNTHETIC IMMUTABLE STORY';
  const before=JSON.stringify(h.state()),newer=structuredClone(next);newer.revision++;newer.state.messages.reply.variables[0].stat_data.ability=99;h.chat[0].variables[0].stat_data.ability=82;assert.deepEqual(h.refreshDisplayState(next),{changed:false,variablesChanged:false},'a duplicate revision never overwrites local edits');assert.throws(()=>h.refreshDisplayState(newer),/尚未保存/);assert.equal(slot.stat_data.ability,82,'local edit is retained');slot.stat_data.ability=81;
  h.pending=true;assert.throws(()=>h.refreshDisplayState(newer),/尚未保存/);h.pending=false;assert.equal(JSON.stringify(h.state()),before);assert.equal(writes,0);assert.equal(renders,1);
  h.request=async(path:any,body:any,binding:any)=>{writes++;assert.equal(path,'/state');assert.equal(body.revision,next.revision,'explicit later save uses the refreshed CAS, not the initial revision');assert.equal(binding.sourceEntryId,'reply');return{revision:body.revision+1};};slot.stat_data.ability=82;await h.save();assert.equal(writes,1);assert.equal(h.context.state.messages.reply.variables[0].stat_data.ability,82,'saved baseline follows successful explicit writes');
 }finally{Object.assign(globalThis,previous);}
});
