/** Synthetic host settings only; no original plugin/card/settings writes. */
import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

function host(search:string,entry="bridge.js"){
 const source=readFileSync(new URL('../web/public/tavern-compat/'+entry,import.meta.url),'utf8').replace(/^import[^\r\n]*;\r?\n/,'').replace(/^export \{[^\r\n]+\};?\r?$/m,'');
 const sandbox:any={URLSearchParams,structuredClone,location:{search},window:{dispatchEvent(){}},document:{querySelector(){return null;}},getCurrentLocale:()=>'',t:()=>'',localizeTemplate:(v:unknown)=>v};
 vm.runInNewContext(source,sandbox);return sandbox.LiyuanTavern;
}
function context(){return {sessionId:'synthetic',scopeKey:'synthetic-scope',sourceEntryId:'reply',plugins:[{id:'helper',enabled:true}],userName:'Synthetic',chat:[{__liyuanEntryId:'reply',mes:'Synthetic immutable story',is_user:false}],character:{name:'Synthetic',avatar:'synthetic.png',data:{extensions:{}}},preset:{name:'Synthetic preset',extensions:{}},readonlyBooks:{},state:{messages:{},chatMetadata:{},worldbooks:{},characterExtensions:{},presetExtensions:{},extensionSettings:{tavern_helper:{unknown:{keep:true},script:{enabled:{global:true,characters:[],presets:[]},popuped:{characters:['earlier.png'],presets:[],unknown:'KEEP'}}}}}};}
const plain=(value:unknown)=>JSON.parse(JSON.stringify(value));
test('message-render consent is local, never enables automation or persists a false user choice',async()=>{
 const h=host('?view=render'),c=context(),before=JSON.stringify(c);await h.bind(c);
 const script=h.extensions.tavern_helper.script;
 assert.deepEqual(plain(script.enabled),c.state.extensionSettings.tavern_helper.script.enabled);
 assert.deepEqual(plain(script.popuped.characters),['earlier.png','synthetic.png']);assert.deepEqual(plain(script.popuped.presets),['Synthetic preset']);
 // Native initialization may save other settings. The local consent overlay is not one.
 h.extensions.tavern_helper.unknown.nativeSetting=17;
 const saved=plain(h.state());assert.deepEqual(saved.extensionSettings.tavern_helper.script.popuped,c.state.extensionSettings.tavern_helper.script.popuped);
 assert.equal(saved.extensionSettings.tavern_helper.unknown.nativeSetting,17);assert.equal(JSON.stringify(c),before);
 await h.bind(c);assert.deepEqual(plain(h.extensions.tavern_helper.script.enabled),c.state.extensionSettings.tavern_helper.script.enabled);
});
test('manager/runtime consent and explicit settings remain native, and rebinding cannot mask another scope',async()=>{
 for(const mode of ['manager','runtime']){const h=host('?view='+mode),c=context();await h.bind(c);assert.equal(h.renderScriptConsent,undefined);assert.deepEqual(plain(h.extensions.tavern_helper.script),c.state.extensionSettings.tavern_helper.script);}
 const h=host('?view=render'),c=context();await h.bind(c);h.context={...c,scopeKey:'different'};
 assert.ok(h.state().extensionSettings.tavern_helper.script.popuped.characters.includes('synthetic.png'),'an old consent mask never alters another binding');
});
test('missing popuped settings remain absent on disk; unknown fields and disabled flags survive',async()=>{
 const h=host('?view=render'),c=context();delete (c.state.extensionSettings.tavern_helper.script as any).popuped;
 await h.bind(c);assert.equal(Object.hasOwn(h.state().extensionSettings.tavern_helper.script,'popuped'),false);
 assert.equal(h.state().extensionSettings.tavern_helper.unknown.keep,true);assert.deepEqual(plain(h.state().extensionSettings.tavern_helper.script.enabled),c.state.extensionSettings.tavern_helper.script.enabled);
});

test('the HTTP-served worldbook-aware adapter has the same transient consent behavior',async()=>{
 const h=host('?view=render','bridge-worldbooks.js'),c=context();await h.bind(c);
 assert.deepEqual(plain(h.extensions.tavern_helper.script.popuped.characters),['earlier.png','synthetic.png']);
 assert.deepEqual(plain(h.state().extensionSettings.tavern_helper.script.popuped),c.state.extensionSettings.tavern_helper.script.popuped);
 assert.deepEqual(plain(h.state().extensionSettings.tavern_helper.script.enabled),c.state.extensionSettings.tavern_helper.script.enabled);
});

test('malformed original script settings remain available for native diagnostics rather than crashing the render adapter',async()=>{
 for(const value of [false,'invalid',[],{script:false},{script:'invalid'},{script:{popuped:[]}}]){
  const h=host('?view=render'),c=context();(c.state.extensionSettings as any).tavern_helper=value;await h.bind(c);
  assert.equal(h.renderScriptConsent,undefined);assert.deepEqual(plain(h.state().extensionSettings.tavern_helper),value);
 }
});

test('template-only and disabled-helper render realms do not create helper settings or queue saves',async()=>{
 for(const plugins of [[],[{id:'template',enabled:true}],[{id:'helper',enabled:false}]]){
  const h=host('?view=render'),c=context();(c as any).plugins=plugins;delete (c.state.extensionSettings as any).tavern_helper;await h.bind(c);
  assert.equal(h.renderScriptConsent,undefined);assert.equal(Object.hasOwn(h.state().extensionSettings,'tavern_helper'),false);
 }
});
