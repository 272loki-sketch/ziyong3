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

