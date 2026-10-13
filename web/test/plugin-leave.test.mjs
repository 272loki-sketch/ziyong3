import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {build} from '../node_modules/esbuild/lib/main.js';

test('known adapter flush: missing API, swallowed failure and growing queue',async()=>{
 const result=await build({entryPoints:[new URL('../src/plugins/usePluginLeave.tsx',import.meta.url).pathname],bundle:true,platform:'node',format:'esm',write:false,jsx:'automatic'});
 const {flushPluginFrame}=await import('data:text/javascript;base64,'+Buffer.from(result.outputFiles[0].text).toString('base64'));
 const frame=(host,hidden=false)=>({contentWindow:host,getAttribute:()=>hidden?'true':'false'});
 await assert.rejects(flushPluginFrame(frame({})),/保存接口/);
 await flushPluginFrame(frame({},true));
 await assert.rejects(flushPluginFrame(frame({LiyuanVeridisRewrite:{flush:async()=>{},failed:true}})),/保存失败/);
 let calls=0;
 await flushPluginFrame(frame({LiyuanVeridisRewrite:{flush:async()=>{calls++;},get pending(){return calls<2?1:0;}}}));
 assert.equal(calls,2);
 await assert.rejects(flushPluginFrame(frame({LiyuanTavernPlugins:{host:{flush:async()=>{throw Error('CAS conflict');}}}})),/CAS conflict/);
});

test('NPC real adapter queue: flush drains debounce, retains failure and explicitly retries',async()=>{
 const source=await readFile(new URL('../public/npc-parallel/host.js',import.meta.url),'utf8');
 const functions=source.slice(source.indexOf('  function scheduleSave()'),source.indexOf('  window.LiyuanNpcParallelHost ='));
 let writes=0,fail=false,resolveWrite;
 const timers=new Map();let id=0;
 const context=vm.createContext({setTimeout:fn=>{timers.set(++id,fn);return id;},clearTimeout:id=>timers.delete(id),setStatus:()=>{},window:{toastr:{error:()=>{}}},saveStateNow:async()=>{writes++;if(fail)throw Error('synthetic CAS');if(resolveWrite!==undefined)await new Promise(resolve=>{resolveWrite=resolve;});}});
 vm.runInContext(`let mode='manager',saveQueue=Promise.resolve(),saveTimer=null,savePending=false,saveFailure=null;${functions};globalThis.adapter={scheduleSave,flushSettings}`,context);
 context.adapter.scheduleSave();context.adapter.scheduleSave();
 await context.adapter.flushSettings();assert.equal(writes,1);assert.equal(timers.size,0);
 fail=true;context.adapter.scheduleSave();await assert.rejects(context.adapter.flushSettings(),/synthetic CAS/);
 fail=false;await context.adapter.flushSettings();assert.equal(writes,3);
 resolveWrite=null;context.adapter.scheduleSave();const pending=context.adapter.flushSettings();
 await new Promise(resolve=>setImmediate(resolve));assert.equal(writes,4);
 const release=resolveWrite;resolveWrite=undefined;release();await pending;
});
