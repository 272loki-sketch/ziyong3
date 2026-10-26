import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabasePluginHttp } from '../../server/database-plugin-http.ts';
import { DatabasePluginRuntime } from '../../server/database-plugin-runtime.ts';
import { createDatabasePluginReadonlyLorebooks } from '../../server/database-plugin-lorebooks.ts';
import { loadStageMaterials } from '../../src/stage/materials.ts';

/** Native preflight regression: only synthetic card/story/books and stub models; no production writes or cloud calls. */
export async function runDatabasePluginPreflightTests({ source, vendor, legacyHostScript, expectLegacyFailure = false }) {
 const cwd=mkdtempSync(join(tmpdir(),'liyuan-db-preflight-'));
 const user='继续合成测试。',large='GLOBAL_MUST_NOT_ENTER_RECALL|'+('全局合成材料\n'.repeat(50000))+'|GLOBAL_TAIL';
 const guarded='GUARDED_MUST_NOT_ENTER_BY_RECURSION|'+('关键词合成材料\n'.repeat(45000))+'|GUARDED_TAIL';
 const card={name:'合成角色',description:'合成测试，不读私人素材',character_book:{entries:[
  {id:0,constant:true,enabled:true,keys:[],content:'CARD_SAFE|原卡常驻设定包含跨条递归词|CARD_TAIL',extensions:{prevent_recursion:true,exclude_recursion:true}},
  {id:1,constant:false,enabled:true,keys:['跨条递归词'],content:guarded,extensions:{prevent_recursion:true,exclude_recursion:true}},
 ]}};
 writeFileSync(join(cwd,'card.json'),JSON.stringify(card));
 writeFileSync(join(cwd,'global.json'),JSON.stringify({entries:[{uid:0,constant:true,enabled:true,key:[],content:large}]}));
 writeFileSync(join(cwd,'liyuan.config.json'),JSON.stringify({card:'card.json',lorebooks:['global.json']}));
 writeFileSync(join(cwd,'liyuan.agent.json'),JSON.stringify({version:1,providers:{synthetic:{api:'openai-completions',baseUrl:'http://127.0.0.1:1/v1',apiKey:'SYNTHETIC_UNUSED_KEY',models:[{id:'synthetic-flash'}]}}}));
 const readonly=createDatabasePluginReadonlyLorebooks(cwd,loadStageMaterials(cwd));
 let context={scope:{sessionId:'synthetic-preflight',card:'card.json'},sourceEntryId:'u-1',visibleEntryIds:['u-1'],chat:[{mes:user,is_user:true,name:'旅人',message_id:'u-1',__liyuanEntryId:'u-1',extra:{}}],character:{name:'合成角色',description:'合成测试'},userName:'旅人',...readonly};
 const calls=[],httpErrors=[];let failModel=false;
 const db=new DatabasePluginHttp(cwd,{context:()=>context,isStreaming:()=>false,embed:async texts=>texts.map(()=>[1,0,0,0]),generate:async(prompts,_signal,options)=>{
  if(failModel)throw new Error('合成模型连接失败');
  calls.push({prompts,purpose:options?.purpose});
  return '<recall>合成召回任务正常完成。</recall><supplement>无新增事实。</supplement>';
 }});
 db.setConfig({fillModel:{provider:'synthetic',id:'synthetic-flash'},recallModel:{provider:'synthetic',id:'synthetic-flash'}});
 db.sources.fetchImpl=async()=>new Response(readFileSync(source));const installed=await db.sources.downloadSource({});await db.sources.activateRef(installed.sha256);
 mkdirSync(join(cwd,'.liyuan-database-plugin','vendor'),{recursive:true});
 for(const name of ['jquery.min.js','sql-wasm.js','sql-wasm.wasm'])copyFileSync(join(vendor,name),join(cwd,'.liyuan-database-plugin','vendor',name));
 const server=createServer((req,res)=>{const end=res.end;res.end=function(body,...rest){if(res.statusCode>=400&&req.url?.includes('completion')){try{httpErrors.push(JSON.parse(String(body)).error)}catch{}}return end.call(this,body,...rest);};void(async()=>{
  if(await db.handle(req,res))return;
  const path=(req.url??'/').split('?')[0];
  if(['/database-plugin-host.html','/database-plugin-host.js'].includes(path)){res.writeHead(200,{'content-type':path.endsWith('.js')?'application/javascript':'text/html'});res.end(readFileSync(path.endsWith('.js')&&legacyHostScript?legacyHostScript:new URL('../public'+path,import.meta.url)));return;}
  res.writeHead(404);res.end();
 })().catch(error=>{res.writeHead(500);res.end(error.message)});});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const runtime=new DatabasePluginRuntime(db,()=>`http://127.0.0.1:${server.address().port}`);
 try{
  if(expectLegacyFailure){
   await assert.rejects(runtime.before(user,AbortSignal.timeout(60000)),/未完成发送前处理/);
    assert.equal(calls.length,0);assert.equal(httpErrors.length,3);assert.ok(httpErrors.every(e=>e.startsWith('数据库模型材料过大')));
   console.log('PASS reproduced legacy native preflight: global mount misbinding → oversized request → 3 failures → no author handoff');return;
  }
  const result=await runtime.before(user,AbortSignal.timeout(60000));
  assert.ok(result.userInput.includes(user));assert.ok(result.userInput.includes('<recall>'));assert.equal(context.chat.at(-1).mes,user);
  assert.equal(calls.length,1);assert.equal(calls[0].purpose,'recall');
  const prompt=calls[0].prompts.map(p=>p.content).join('\n');
  assert.ok(prompt.includes('CARD_SAFE'));assert.ok(prompt.includes('CARD_TAIL'));
  assert.ok(!prompt.includes('GLOBAL_MUST_NOT_ENTER_RECALL'));assert.ok(!prompt.includes('GLOBAL_TAIL'));
  assert.ok(!prompt.includes('GUARDED_MUST_NOT_ENTER_BY_RECURSION'));assert.ok(!prompt.includes('GUARDED_TAIL'));
  assert.ok(prompt.length<240000);assert.equal(httpErrors.length,0);
  const bindings=await runtime.page.evaluate(async()=>({character:await window.TavernHelper.getCharWorldbookNames(),global:await window.TavernHelper.getGlobalWorldbookNames(),globalEntries:await window.TavernHelper.getLorebookEntries((await window.TavernHelper.getGlobalWorldbookNames())[0])}));
  assert.deepEqual(bindings.character.additional,readonly.characterBookNames);assert.deepEqual(bindings.global,readonly.globalBookNames);
  assert.equal(bindings.globalEntries[0].content,large,'global content remains complete and explicitly readable');
  console.log(`PASS native first-turn preflight: scoped card + preserved recursion guards → ${prompt.length} prompt chars → original recall/writeback → author handoff; no cloud calls`);

  // Isolate the second cause: even with correct book binding, dropping card guards reintroduces the large keyword entry.
  await runtime.close();
  const unguardedBooks=structuredClone(readonly.readonlyBooks);
  for(const name of readonly.characterBookNames)for(const e of unguardedBooks[name].entries){delete e.prevent_recursion;delete e.exclude_recursion;}
  context={...context,readonlyBooks:unguardedBooks,scope:{...context.scope,sessionId:'synthetic-missing-guards'},sourceEntryId:'unguarded-u',visibleEntryIds:['unguarded-u'],chat:[{mes:user,is_user:true,name:'旅人',message_id:'unguarded-u',__liyuanEntryId:'unguarded-u',extra:{}}]};
  await assert.rejects(runtime.before(user,AbortSignal.timeout(60000)),/未完成发送前处理.*数据库模型材料过大/);
   assert.equal(calls.length,1);assert.ok(httpErrors.slice(-3).every(e=>e.startsWith('数据库模型材料过大')));
  context={...context,readonlyBooks:readonly.readonlyBooks};
  console.log('PASS native counterfactual: correct bindings without recursion guards still fail; both host fixes are necessary');

  // A direct keyword match must still activate the complete entry; the host may not silently clip it.
  await runtime.close();const explicit='我现在说出跨条递归词';
  context={...context,scope:{...context.scope,sessionId:'synthetic-direct-trigger'},sourceEntryId:'direct-u',visibleEntryIds:['direct-u'],chat:[{mes:explicit,is_user:true,name:'旅人',message_id:'direct-u',__liyuanEntryId:'direct-u',extra:{}}]};
  await assert.rejects(runtime.before(explicit,AbortSignal.timeout(60000)),/未完成发送前处理.*数据库模型材料过大/);
  assert.equal(calls.length,1,'oversized native materials remain protected by the unchanged host limit');
   assert.ok(httpErrors.slice(-3).every(e=>e.startsWith('数据库模型材料过大')));

  await runtime.close();failModel=true;
  context={...context,scope:{...context.scope,sessionId:'synthetic-model-failure'},sourceEntryId:'failed-u',visibleEntryIds:['failed-u'],chat:[{mes:user,is_user:true,name:'旅人',message_id:'failed-u',__liyuanEntryId:'failed-u',extra:{}}]};
  await assert.rejects(runtime.before(user,AbortSignal.timeout(60000)),/未完成发送前处理.*合成模型连接失败/);
  console.log('PASS native failure paths: genuine direct-trigger oversize and model failure stay blocked with concrete errors; no fake recall success');
 }finally{await runtime.close();await new Promise(r=>server.close(r));rmSync(cwd,{recursive:true,force:true});}
}
