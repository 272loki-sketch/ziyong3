import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

test('MVU retry persistence masks only source variables/receipt and extra_analysis, never another binding',()=>{
 const code=readFileSync(new URL('../web/public/tavern-compat/bridge.js',import.meta.url),'utf8').replace(/^import .*;\n/,'').replace(/export \{[^}]+\};\s*$/,'');
 const sandbox:any={getCurrentLocale:()=>'',t:()=>'',localizeTemplate:(v:any)=>v};vm.runInNewContext(code,sandbox);
 const h=sandbox.LiyuanTavern,context={scopeKey:'scope',sourceEntryId:'reply'};h.context=context;h.chat=[{__liyuanEntryId:'ancestor',variables:[{stat_data:{safe:1}}]},{__liyuanEntryId:'reply',variables:[{stat_data:{lost:0}}],extra:{new:true}}];
 h.metadata={unrelated:42,__liyuanMvuProcessed:{reply:{status:'updated'},other:{status:'normal'}}};h.extensions={variables:{global:{extra_analysis:true,unrelated:true}},mvu_settings:{keep:true}};h.characters=[{data:{extensions:{keep:true}}}];h.presets=[{extensions:{keep:true}}];h.books={};
 h.mvuRetryBaseline={context,id:'reply',hasVariables:true,variables:[{stat_data:{safe:3}}],receipt:{status:'normal'},hasExtraAnalysis:true,extraAnalysis:false};
 let state=JSON.parse(JSON.stringify(h.state()));assert.deepEqual(state.messages.reply.variables,[{stat_data:{safe:3}}]);assert.equal(state.chatMetadata.__liyuanMvuProcessed.reply.status,'normal');assert.equal(state.extensionSettings.variables.global.extra_analysis,false);assert.equal(state.extensionSettings.variables.global.unrelated,true);assert.equal(state.chatMetadata.unrelated,42);assert.equal(state.messages.reply.extra.new,true);assert.deepEqual(state.messages.ancestor.variables,[{stat_data:{safe:1}}]);
 h.context={scopeKey:'sibling-scope',sourceEntryId:'sibling'};state=JSON.parse(JSON.stringify(h.state()));assert.deepEqual(state.messages.reply.variables,[{stat_data:{lost:0}}]);assert.equal(state.extensionSettings.variables.global.extra_analysis,true,'old baseline must never project into another scope');
});
