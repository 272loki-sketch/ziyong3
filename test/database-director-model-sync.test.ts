import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabasePluginHttp} from '../server/database-plugin-http.ts';

test('settings literaryDirector is authoritative and atomically mirrors recall only, preserving all other roles and fields',()=>{
 const cwd=mkdtempSync(join(tmpdir(),'liyuan-unified-director-'));
 try{
  const flash={provider:'secondary',id:'gemini-3.8-flash'},argon={provider:'primary',id:'gemini-4-argon'};
  writeFileSync(join(cwd,'liyuan.agent.json'),JSON.stringify({version:1,defaultProvider:'primary',defaultModel:argon.id,providers:{primary:{apiKey:'SYNTHETIC_ONLY',baseUrl:'https://primary.synthetic.invalid/v1',models:[{id:argon.id}]},secondary:{apiKey:'SYNTHETIC_ONLY',baseUrl:'https://secondary.synthetic.invalid/v1',models:[{id:flash.id}]}}}));
  const settings={generationMode:'direct',card:'synthetic-card.json',stepModels:{literaryDirector:argon,scribe:flash},unknownSetting:{keep:true}};
  const settingsFile=join(cwd,'liyuan.config.json');writeFileSync(settingsFile,JSON.stringify(settings));const original=readFileSync(settingsFile,'utf8');
  const api=new DatabasePluginHttp(cwd,{context:()=>({scope:{sessionId:'synthetic'},sourceEntryId:'synthetic',visibleEntryIds:[],chat:[],character:{name:'synthetic'},userName:'synthetic'}),generate:async()=>{throw Error('No paid request');},isStreaming:()=>false});
  const file=join(cwd,'.liyuan-database-plugin','config.json');writeFileSync(file,JSON.stringify({version:1,enabled:false,fillModel:flash,recallModel:flash,unknownDatabase:{keep:true}}));
  assert.deepEqual(api.config().recallModel,argon);assert.equal(api.syncDirectorModel(),true);
  let stored=JSON.parse(readFileSync(file,'utf8'));assert.deepEqual(stored.recallModel,argon);assert.deepEqual(stored.fillModel,flash);assert.deepEqual(stored.unknownDatabase,{keep:true});assert.equal(readFileSync(settingsFile,'utf8'),original);assert.equal(api.syncDirectorModel(),false);
  const next={...settings,stepModels:{...settings.stepModels,literaryDirector:flash}};writeFileSync(settingsFile,JSON.stringify(next));assert.deepEqual(api.config().recallModel,flash);assert.equal(api.syncDirectorModel(),true);stored=JSON.parse(readFileSync(file,'utf8'));assert.deepEqual(stored.recallModel,flash);assert.deepEqual(stored.fillModel,flash);assert.deepEqual(api.managedPresets().find(p=>p.purpose==='recall')?.model,flash.id);
  assert.throws(()=>api.setConfig({recallModel:argon}),/统一跟随/);assert.deepEqual(JSON.parse(readFileSync(file,'utf8')).recallModel,flash);
  delete (next.stepModels as any).literaryDirector;writeFileSync(settingsFile,JSON.stringify(next));assert.deepEqual(api.config().recallModel,argon,'unset settings role follows configured main model, not stale DB recall');
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
