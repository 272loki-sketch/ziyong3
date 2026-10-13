import assert from 'node:assert/strict';
import { runDatabasePluginPreflightTests } from './database-plugin-preflight-fixture.mjs';
import { createServer } from 'node:http';
import { mkdtempSync,mkdirSync,readFileSync,copyFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabasePluginHttp } from '../../server/database-plugin-http.ts';
import { DatabasePluginRuntime } from '../../server/database-plugin-runtime.ts';
const upstream=process.env.LIYUAN_DATABASE_PLUGIN_TEST_SOURCE;
const vendor=process.env.LIYUAN_DATABASE_PLUGIN_TEST_VENDOR;
if(!upstream||!vendor){console.log('SKIP unchanged-upstream browser integration: set explicit verified synthetic fixture paths');process.exit(0);}
const cwd=mkdtempSync(join(tmpdir(),'liyuan-plugin-browser-'));
let context={scope:{sessionId:'synthetic-session',card:'synthetic-card.json'},sourceEntryId:'a-1',visibleEntryIds:['greeting','u-1','a-1'],chat:[{mes:'合成测试开场，青梧在桥边。',is_user:false,name:'青梧',message_id:'greeting',__liyuanEntryId:'greeting',extra:{}},{mes:'把铜钥匙交给青梧，请她次日归还。',is_user:true,name:'旅人',message_id:'u-1',__liyuanEntryId:'u-1',extra:{}},{mes:'青梧收下铜钥匙，承诺次日傍晚在桥边归还。',is_user:false,name:'青梧',message_id:'a-1',__liyuanEntryId:'a-1',extra:{}}],character:{name:'青梧',description:'合成角色，不读取生产素材',personality:'友好',scenario:'桥边'},userName:'旅人'};
let calls=0,embeddingCalls=0,recallCalls=0;
const db=new DatabasePluginHttp(cwd,{context:()=>context,isStreaming:()=>false,embed:async texts=>{embeddingCalls++;return texts.map(t=>t.includes('铜钥匙')?[1,0,0,0]:[0,1,0,0]);},generate:async (prompts,_signal,options)=>{if(prompts.some(p=>p.content.includes('交火模式纪要索引召回'))){return '<keywords>青梧，铜钥匙，归还，承诺</keywords>';}if(prompts.some(p=>p.content.includes('You select AM from')||p.content.includes('从纪要索引召回相关记忆')||p.content.includes('剧情记忆召回')||p.content.includes('记忆索引召回与补充信息提取'))){recallCalls++;assert.ok(prompts.some(p=>p.content.includes('青梧')&&p.content.includes('AM0003')));return '<match>\nAM0003 | now | 1m | 青梧与铜钥匙归还承诺\n</match>\n<recall>\nnow =\nAM0003 | 1m\n</recall>';}calls++;assert.ok(prompts.length>2);return '<thought>'+('合成测试：仅记录已发生的归还约定，不添加未执行的计划。'.repeat(30))+'</thought><content><tableEdit>\ninsertRow(6,{"0":"AM0001","1":"2026-10-07 08:00 ~ 2026-10-07 08:10","2":"青梧接受铜钥匙归还约定","3":"旅人把铜钥匙交给青梧，青梧接受并承诺次日傍晚在桥边归还。此刻尚未归还。","4":"青梧：次日傍晚在桥边归还。"})\n</tableEdit></content>';}});
db.sources.fetchImpl=async()=>new Response(readFileSync(upstream));
const source=await db.sources.downloadSource({});await db.sources.activateRef(source.sha256);
mkdirSync(join(cwd,'.liyuan-database-plugin','vendor'),{recursive:true});
for(const name of ['jquery.min.js','sql-wasm.js','sql-wasm.wasm'])copyFileSync(join(vendor,name),join(cwd,'.liyuan-database-plugin','vendor',name));
const server=createServer((req,res)=>{if(process.env.LIYUAN_DATABASE_PLUGIN_TEST_TRACE==='1')console.log('HTTPPATH',(req.url??'').split('?')[0]);void(async()=>{if(await db.handle(req,res))return;const path=(req.url??'/').split('?')[0];if(['/database-plugin-host.html','/database-plugin-host.js'].includes(path)){res.writeHead(200,{'content-type':path.endsWith('.js')?'application/javascript':'text/html'});res.end(readFileSync(new URL('../public'+path,import.meta.url)));return;}res.writeHead(404);res.end();})().catch(error=>{res.writeHead(500);res.end(error.message)});});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const runtime=new DatabasePluginRuntime(db,()=>origin);
const generateFixture=db.host.generate;
db.host.generate=async(prompts,signal,options)=>{
 if(options?.purpose!=='recall')assert.ok(prompts.some(p=>p.content.includes('纪要表')&&p.content.includes('编码索引')),'native request must actually include chronicle schema, not just generic instructions');
 return generateFixture(prompts,signal,options);
};
// Native automatic grouping checks the original API setting, unlike legacy triggerUpdate.
await db.store.saveState(context.scope,context.sourceEntryId,0,{messages:{},chatMetadata:{},worldbooks:{},extensionSettings:{__userscripts:{shujuku_v120__userscript_settings_v1:{
  shujuku_v120_profile_v1____default____settings:JSON.stringify({apiMode:'custom',apiConfig:{useMainApi:true},autoUpdateEnabled:true,autoUpdateFrequency:1,autoUpdateThreshold:3,autoUpdateTokenThreshold:0,updateBatchSize:3,maxConcurrentGroups:3}),
 shujuku_v120_globalMeta_v1:JSON.stringify({version:1,activeIsolationCode:'',isolationCodeList:[],migratedLegacySingleStore:true,zeroTkOccupyModeGlobal:true,summaryVectorIndexModeGlobal:false,plotEnabledGlobal:true,formFillPreferencesGlobal:{schemaVersion:1,selectedMode:'classic'},vectorMemoryConfigGlobal:{enabled:true,embeddingEndpoint:origin+'/api/database-plugin/embeddings',embeddingModel:'synthetic',embeddingApiKey:'host-managed'}})
}}}});
try {
  await runtime.rpc('getUpdateConfigParams');
  await runtime.page.evaluate(async()=>{
   const namespace=window.SillyTavern.getContext().extensionSettings.__userscripts.shujuku_v120__userscript_settings_v1;
   window.__fixtureCachedNamespace=namespace;
   await window.LiyuanDatabasePluginHost.sync();
   if(namespace!==window.SillyTavern.getContext().extensionSettings.__userscripts.shujuku_v120__userscript_settings_v1)throw Error('settings namespace detached');
   const meta=JSON.parse(namespace.shujuku_v120_globalMeta_v1);meta.vectorMemoryConfigGlobal.topK=137;
   namespace.shujuku_v120_globalMeta_v1=JSON.stringify(meta);
   window.saveSettingsDebounced();await window.LiyuanDatabasePluginHost.flush();
  });
  const persistedSettings=(await db.context()).extensionSettings.__userscripts.shujuku_v120__userscript_settings_v1;
  assert.equal(JSON.parse(persistedSettings.shujuku_v120_globalMeta_v1).vectorMemoryConfigGlobal.topK,137);
  assert.equal(JSON.parse(persistedSettings.shujuku_v120_profile_v1____default____settings).maxConcurrentGroups,3);
  await runtime.close();await runtime.rpc('getUpdateConfigParams');
  assert.equal(await runtime.page.evaluate(()=>JSON.parse(window.SillyTavern.getContext().extensionSettings.__userscripts.shujuku_v120__userscript_settings_v1.shujuku_v120_globalMeta_v1).vectorMemoryConfigGlobal.topK),137);
  const result=await runtime.after('a-1');assert.equal(result.success,true);assert.equal(calls,1);
 const first=await db.context();const frame=first.chat.find(m=>m.__liyuanEntryId==='a-1');assert.ok(frame.TavernDB_ACU_IsolatedData,'original upstream must persist its own real storage frame');
  assert.ok(first.revision>0);
  assert.equal(await runtime.page.evaluate(()=>Object.values(window.AutoCardUpdaterAPI.exportTableAsJson()).find(t=>t?.name==='纪要表').content.length-1),1,'native grouping must persist chronicle, not just a header-only seed');
  await runtime.close();await runtime.after('a-1');assert.equal(calls,1);
  assert.equal(await runtime.page.evaluate(()=>Object.values(window.AutoCardUpdaterAPI.exportTableAsJson()).find(t=>t?.name==='纪要表').content.length-1),1,'chronicle must survive a fresh original-plugin realm without duplicate filling');
 if(process.env.LIYUAN_DATABASE_PLUGIN_TEST_LONG==='1'){
  const page=runtime.page;
  const tableCount=await page.evaluate(async()=>{const api=window.AutoCardUpdaterAPI;const data=api.exportTableAsJson();const key=Object.keys(data).find(k=>data[k]?.name==='纪要表');const header=data[key].content[0];const cols=Object.fromEntries(header.map((x,i)=>[x,i]));data[key].content=[header,...Array.from({length:2000},(_,i)=>{const row=Array(header.length).fill('');row[0]=String(i+1);row[cols['编码索引']]='AM'+String(i+1).padStart(4,'0');row[cols['时间跨度']]='2026-10-07 08:00 ~ 2026-10-07 08:10';row[cols['概览']]=i===2?'青梧承诺归还铜钥匙':'合成普通日常记录'+i;row[cols['纪要']]=i===2?'青梧接受铜钥匙，承诺次日傍晚在桥边归还，尚未兑现。':'合成故事中讨论课程、天气与晚餐安排，序号'+i;if(cols['重要对话']!==undefined)row[cols['重要对话']]='';return row;})];const ok=await api.importTableAsJson(JSON.stringify(data));if(!ok)throw new Error('上游2000纪要导入失败');return api.exportTableAsJson()[key].content.length-1;});
  assert.equal(tableCount,2000);console.log('PASS original upstream durable 2000-row chronicle import; no production data');
  await new Promise(r=>setTimeout(r,6000));context={...context,sourceEntryId:'u-2',visibleEntryIds:[...context.visibleEntryIds,'u-2'],chat:[...context.chat,{mes:'还记得青梧答应归还的铜钥匙吗',is_user:true,name:'旅人',message_id:'u-2',__liyuanEntryId:'u-2',extra:{}}]};const prepared=await runtime.before('还记得青梧答应归还的铜钥匙吗');assert.ok(prepared.userInput.includes('<本轮用户输入>'));assert.ok(prepared.userInput.includes('<recall>'));assert.ok(prepared.userInput.includes('AM0003'));assert.ok(prepared.userInput.indexOf('<recall>')>prepared.userInput.indexOf('还记得青梧答应归还的铜钥匙吗'));assert.ok(recallCalls>0,'original recall task must run, not a host AM selector');const recalled=await db.injection(prepared.userInput);assert.ok(recalled.some(b=>b.text.includes('铜钥匙')));if(!embeddingCalls)console.log('CROSSFIRE_DEBUG',JSON.stringify(await runtime.page.evaluate(()=>({helperWrapped:typeof window.original_TavernHelper_generate_ACU,tables:Object.values(window.AutoCardUpdaterAPI.exportTableAsJson()).filter(x=>x?.name).map(x=>x.name),errors:window.LiyuanDatabasePluginHost.errors(),metadata:window.LiyuanDatabasePluginHost.diagnostics().metadata,latest:window.SillyTavern.getContext().chat.at(-1),scoped:window.SillyTavern.getContext().chat[0].TavernDB_ACU_ScopedConfig}))).slice(0,3500));assert.ok(embeddingCalls>0,'original crossfire must actually invoke the host embedding channel');const zero=await db.context();const index=Object.values(zero.worldbooks).flatMap(b=>b.entries).find(e=>String(e.comment??'').endsWith('纪要索引'));assert.equal(index?.enabled,false,'original 0TK mode keeps overview index disabled');assert.ok(!recalled.some(b=>b.tag.endsWith('纪要索引')),'0TK disabled overview must never be a host shortcut to memory');assert.equal(context.chat.at(-1).mes,'还记得青梧答应归还的铜钥匙吗');console.log('PASS original 2000-row crossfire → original recall task → original writeback template → native worldbook keys + original 0TK disabled overview');
 }

 await runtime.after('a-1');assert.equal(calls,1,'saved source recovery must not refill the same narrative');
 context={...context,sourceEntryId:'sibling-u',visibleEntryIds:['greeting','sibling-u'],chat:[context.chat[0],{mes:'另一分支输入，尚无正文',is_user:true,name:'旅人',message_id:'sibling-u',__liyuanEntryId:'sibling-u',extra:{}}]};
 const sibling=await db.context();assert.ok(!sibling.chat.some(m=>m.TavernDB_ACU_IsolatedData));assert.ok(Object.values(sibling.worldbooks).every(b=>b.entries.length===0));
  console.log('PASS unchanged upstream: native grouped fill → durable chronicle → fresh realm replay → dedupe → sibling isolation; no cloud calls');
}finally{await runtime.close();await new Promise(r=>server.close(r));rmSync(cwd,{recursive:true,force:true});}

await runDatabasePluginPreflightTests({source:upstream,vendor});
