import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { VeridisRewriteRuntime, defaultVeridisHostSettings, type VeridisRewriteRunInput, type VeridisRewriteSourceLike } from '../server/veridis-rewrite-runtime.ts';
import type { VeridisRewriteCandidate } from '../server/veridis-rewrite-source.ts';

// Explicit synthetic public-module protocol fixture, not a copy of upstream code.
const DEFAULTS = `export const extensionName = 'synthetic-rewrite';
export const defaultAiRewriteSettings = {enabled:true,autoTriggerEnabled:true,xmlScopeTag:'content',temperature:0.3,maxTokens:512,promptTemplate:'SYNTHETIC ORIGINAL PROMPT'};
export const defaultSettings = {rules:[],aiRewrite:defaultAiRewriteSettings};`;
const HOST = `let context={};export function initAppContext(value){context=value;}export function getAppContext(){return context;}`;
const RESPONSE = `export function parseAiRewriteResponseObject(text){const parsed=JSON.parse(text);if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('invalid object');return parsed;}export function parseAiResponse(text, items){const value=JSON.parse(text);if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).length!==items.size)throw Error('invalid map');const result=new Map;for(const [id,replacement] of Object.entries(value)){if(!items.has(id)||typeof replacement!=='string')throw Error('invalid id/value');result.set(id,replacement);}return result;}`;
const ENGINE = `
import {getAppContext} from '../host/appContext.js';
import {extensionName} from '../settings/defaults.js';
import {parseAiResponse} from './response.js';
export function resetAiRewriteRuntimeState(){}
export function buildAiRewriteTaskCheck(){
 const context=getAppContext(),settings=context.extension_settings[extensionName],message=context.chat[0];
 if(settings.aiRewrite.enabled===false||settings.aiRewrite.autoTriggerEnabled===false)return {task:null,reason:'synthetic disabled'};
 const triggers=(settings.rules||[]).filter(rule=>rule.enabled!==false).flatMap(rule=>(rule.subRules||[]).filter(rule=>rule.enabled!==false&&rule.rewriteMode==='ai').flatMap(rule=>rule.targets||[]));
 const matches=[...message.mes.matchAll(/[^<>。\\n]+。/g)].filter(match=>triggers.some(trigger=>match[0].includes(trigger)));
 return matches.length?{task:{items:matches.map((match,index)=>({id:'hit-'+(index+1),start:match.index,end:match.index+match[0].length,text:match[0]})),settings,message},reason:''}:{task:null,reason:'synthetic no-match'};
}
export async function runAiRewriteForMessageNow(_payload,{preparedTask:task}){
 const context=getAppContext(),settings=context.extension_settings[extensionName];
 if(settings.privateRead){await import('node:fs').then(fs=>fs.readFileSync(settings.privateRead));}
 if(settings.privateWrite){await import('node:fs').then(fs=>fs.writeFileSync(settings.privateWrite,'should never happen'));}
 if(settings.unknownHostApi)await globalThis.unknownNewHostApi();
 if(settings.throwCustomError){const error=new Error('PRIVATE_ERROR_MARKER synthetic_secret ghp_secret');error.name='synthetic_secret';error.code='ghp_secret';throw error;}
 const maxBatch=Math.max(1,settings.aiRewrite.maxItemsPerRequest||20),accepted=new Map;
 for(let index=0;index<task.items.length;index+=maxBatch){
   const items=task.items.slice(index,index+maxBatch),prompt=settings.aiRewrite.promptTemplate+'\\n'+items.map(item=>'<rewrite_target id="'+item.id+'">'+item.text+'</rewrite_target>').join('\\n');
   try {const config={generation_id:'fixture-'+index,ordered_prompts:[{role:'user',content:prompt}],custom_api:{key:settings.aiRewrite.apiKey,max_tokens:settings.aiRewrite.maxTokens,temperature:settings.aiRewrite.temperature}};
    const value=await globalThis.TavernHelper.generateRaw(config);
    parseAiResponse(value,new Map(items.map(item=>[item.id,item]))).forEach((text,id)=>accepted.set(id,text));
   }catch{return {status:'fallback-applied'};}
 }
 let output=task.message.mes;
 for(const item of [...task.items].sort((a,b)=>b.start-a.start))output=output.slice(0,item.start)+accepted.get(item.id)+output.slice(item.end);
 if(settings.fault==='format-tail')output+='UNAUTHORIZED';
 if(settings.fault==='program-inside-target')output=output.replace('细微','轻微');
 if(settings.fault==='program-protected-option')output=output.replace('<options>不易察觉。</options>','<options>。</options>');
 task.message.mes=output;
 return {status:'applied'};
}
`;
async function fixture(run: (state: { base: string; root: string; runtime: VeridisRewriteRuntime; candidate: VeridisRewriteCandidate; setCandidate: (candidate: VeridisRewriteCandidate | null) => void }) => Promise<void>, options: { pathAlias?: boolean } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'liyuan-veridis-runtime-test-'));
  const alias = options.pathAlias ? join(base, 'path-alias') : undefined;
  if (alias) symlinkSync(base, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const root = join(alias ?? base, 'private-assets');
  const modules: Record<string, string> = { 'src/settings/defaults.js': DEFAULTS, 'src/host/appContext.js': HOST, 'src/aiRewrite/response.js': RESPONSE, 'src/aiRewrite/runtime.js': ENGINE };
  for (const [path, body] of Object.entries(modules)) { const file=join(root,path);mkdirSync(dirname(file),{recursive:true,mode:0o700});writeFileSync(file,body,{mode:0o600}); }
  const candidate: VeridisRewriteCandidate = { root, version: 'synthetic-3.5', commit: '1'.repeat(40), sha256: '2'.repeat(64), manifest: { version: 'synthetic-3.5', js: 'index.js' } };
  let active: VeridisRewriteCandidate | null = candidate;
  const sources: VeridisRewriteSourceLike = { active: () => active, resolveAsset: (path, requested) => Object.hasOwn(modules, path) && (!requested || requested.root === root) ? join(root,path) : null };
  const runtime = new VeridisRewriteRuntime({ assetsCwd: base, sources });
  try { await run({ base, root, runtime, candidate, setCandidate: value => active=value }); }
  finally { await runtime.close(); if (alias) rmSync(alias, { force: true }); rmSync(base, { recursive: true, force: true }); }
}
const narrative = '他说了不易察觉的变化。';
const input = (patch: Partial<VeridisRewriteRunInput> = {}): VeridisRewriteRunInput => ({
  sourceEntryId: 'synthetic-source', authorDraft: narrative, narrative, guard: () => {},
  generate: async request => JSON.stringify(Object.fromEntries([...request.messages[0].content.matchAll(/<rewrite_target id="([^"]+)"[^>]*>([\s\S]*?)<\/rewrite_target>/g)].map(match => [match[1], match[2].replace('不易察觉', '细微')]))),
  ...patch,
});

test('Worker canonicalizes module file URLs and read permissions through a platform path alias', () => fixture(async ({ runtime }) => {
  const result = await runtime.run(input());
  assert.equal(result.text, '他说了细微的变化。');
  assert.equal(result.changed, true);
  assert.equal(result.calls, 1);
}, { pathAlias: true }));

test('finite host starting rules are optional data and never contain a copied global prompt', () => {
  const initial = defaultVeridisHostSettings();
  assert.equal((initial.aiRewrite as Record<string, unknown>).enabled, true);
  assert.equal((initial.aiRewrite as Record<string, unknown>).promptTemplate, undefined);
  assert.ok((initial.rules as unknown[]).length > 0);
  (initial.rules as unknown[]).length=0;
  assert.ok((defaultVeridisHostSettings().rules as unknown[]).length > 0);
});

test('original public modules execute in an isolated Worker and return source-bound projection only', () => fixture(async ({ runtime }) => {
  const original=input();
  const result=await runtime.run(original);
  assert.equal(result.text, '他说了细微的变化。');
  assert.equal(result.changed,true);assert.equal(result.calls,1);assert.equal(result.hits,1);
  assert.equal(result.version,'synthetic-3.5');assert.deepEqual(result.errors,[]);
  assert.equal(original.authorDraft,narrative);assert.equal(original.narrative,narrative);
  assert.equal(runtime.busy(),false);
}));

test('default prompt comes from original module while unknown settings and private stored credentials are retained', () => fixture(async ({ runtime }) => {
  const originalSettings={branding:{label:'unchanged'},aiRewrite:{apiKey:'SYNTHETIC-PRIVATE-KEY-NOT-FOR-PROVIDER',baseUrl:'https://private-fixture.invalid',unknownAiFlag:{keep:1}},otherUnknown:[false,null,'metadata']};
  const original=input({settings:originalSettings,generate:async request=>{
    assert.match(request.messages[0].content,/SYNTHETIC ORIGINAL PROMPT/);
    assert.doesNotMatch(JSON.stringify(request),/SYNTHETIC-PRIVATE-KEY|private-fixture/);
    assert.equal(request.maxTokens,512);
    return '{"hit-1":"他说了细微的变化。"}';
  }});
  const result=await runtime.run(original);
  assert.deepEqual(result.settings?.branding,originalSettings.branding);
  assert.deepEqual(result.settings?.otherUnknown,originalSettings.otherUnknown);
  assert.equal((result.settings?.aiRewrite as Record<string,unknown>).apiKey,originalSettings.aiRewrite.apiKey);
  assert.deepEqual((result.settings?.aiRewrite as Record<string,unknown>).unknownAiFlag,{keep:1});
  assert.equal(originalSettings.aiRewrite.apiKey,'SYNTHETIC-PRIVATE-KEY-NOT-FOR-PROVIDER');
}));

test('empty/disabled rules and absent exact narrative ranges explicitly skip with zero calls', () => fixture(async ({ runtime }) => {
  for(const patch of [{settings:{rules:[]}},{settings:{enabled:false}},{settings:{aiRewrite:{autoTriggerEnabled:false}}},{settings:{rules:(defaultVeridisHostSettings().rules as any[]).map(rule=>({...rule,enabled:false}))}},{narrative:'unknown source body'}]){
    const result=await runtime.run(input({...patch,generate:async()=>{throw Error('must not charge')}}));
    assert.equal(result.skipped,true);assert.equal(result.calls,0);assert.equal(result.changed,false);assert.equal(result.text,narrative);
  }
}));

test('target filtering preserves full options/MVU/HTML/fences and never submits their protected matches', () => fixture(async ({ runtime }) => {
  const suffix='\n<options>不易察觉。</options>\n<UpdateVariable>不易察觉。</UpdateVariable>\n<StatusPlaceHolderImpl/>\n<div>不易察觉。</div>\n```html\n不易察觉。\n```';
  const author='<content>'+narrative+'</content>'+suffix;
  const result=await runtime.run(input({authorDraft:author}));
  assert.equal(result.text,'<content>他说了细微的变化。</content>'+suffix);
  assert.equal(result.calls,1);assert.equal(result.hits,1);
}));

test('host discards changed complement bytes but still rejects structured AI replacements', () => fixture(async ({ runtime }) => {
  const result=await runtime.run(input({settings:{fault:'format-tail'}}));
  assert.equal(result.text,'他说了细微的变化。');assert.equal(result.projectionMode,'ai-targets-only');
  assert.equal(result.text.includes('<options>'),false);
  await assert.rejects(runtime.run(input({generate:async()=>'{"hit-1":"<options>new</options>"}'})),/新的结构/);
}));

test('original Markdown/emphasis and quotation structure are protected inside admitted targets', () => fixture(async ({ runtime }) => {
  const quoted='“他的**不易察觉**变化。”';
  await assert.rejects(runtime.run(input({authorDraft:quoted,narrative:quoted,generate:async()=>'{"hit-1":"他的细微变化。"}'})),/Markdown 或引号/);
}));

test('invalid original JSON target protocol is not called successful or admitted as a fallback', () => fixture(async ({ runtime }) => {
  for(const value of ['```json\n{"hit-1":"change"}\n```','{"other":"change"}','{"hit-1":0}','{}']){
    const result=await runtime.run(input({generate:async()=>value}));
    assert.equal(result.changed,false);assert.equal(result.text,narrative);assert.equal(result.calls,1);assert.ok(result.errors.length>0);
  }
}));

test('custom prompt example IDs do not replace the original actual target map', () => fixture(async ({ runtime }) => {
  const result=await runtime.run(input({settings:{aiRewrite:{promptTemplate:'SYNTHETIC EXAMPLE <rewrite_target id="example-only">not an actual target</rewrite_target>'}},generate:async()=>'{"hit-1":"他说了细微的变化。"}'}));
  assert.equal(result.changed,true);assert.equal(result.calls,1);assert.deepEqual(result.errors,[]);
}));

test('per-run hard limit is eight managed generation calls', () => fixture(async ({ runtime }) => {
  const repeated=Array.from({length:10},(_,index)=>`${index}处不易察觉。`).join('');
  const result=await runtime.run(input({authorDraft:repeated,narrative:repeated,settings:{aiRewrite:{maxItemsPerRequest:1}}}));
  assert.equal(result.calls,8);assert.equal(result.changed,false);assert.equal(result.text,repeated);assert.ok(result.errors.length>0);
}));

test('late provider result is rejected by source guard and does not alter the original', () => fixture(async ({ runtime }) => {
  let current=true;
  await assert.rejects(runtime.run(input({guard:()=>current,generate:async()=>{current=false;return '{"hit-1":"changed"}';}})),/过期/);
  assert.equal(runtime.busy(),false);
}));

test('cancellation terminates a Worker without waiting for a provider that ignores abort', () => fixture(async ({ runtime }) => {
  let started!:()=>void;const began=new Promise<void>(resolve=>started=resolve);
  const controller=new AbortController();
  const task=runtime.run(input({signal:controller.signal,generate:async(_request,signal)=>{assert.equal(signal?.aborted,false);started();return await new Promise<string>(()=>{});}}));
  await began;controller.abort();
  await assert.rejects(task,/取消/);assert.equal(runtime.busy(),false);
}));

test('source-version changes before result admission reject the late projection', () => fixture(async ({ runtime,candidate,setCandidate }) => {
  await assert.rejects(runtime.run(input({generate:async()=>{setCandidate({...candidate,commit:'3'.repeat(40)});return '{"hit-1":"changed"}';}})),/版本或字节已变化/);
}));

test('concurrent Workers have independent original appContext and settings', () => fixture(async ({ runtime }) => {
  const results=await Promise.all([
    runtime.run(input({sourceEntryId:'branch-a',generate:async()=>'{"hit-1":"甲的变化。"}'})),
    runtime.run(input({sourceEntryId:'branch-b',generate:async()=>'{"hit-1":"乙的变化。"}'})),
  ]);
  assert.equal(results[0].text,'甲的变化。');assert.equal(results[1].text,'乙的变化。');assert.equal(runtime.busy(),false);
}));

test('Worker permissions refuse private filesystem reads and writes outside verified asset root', () => fixture(async ({ runtime,base }) => {
  const outside=join(base,'synthetic-private.txt');writeFileSync(outside,'PRIVATE SYNTHETIC ONLY');
  for (const settings of [{privateRead:outside},{privateWrite:outside}]) {
    await assert.rejects(runtime.run(input({settings})), error => {
      assert.match((error as Error).message,/初始化或执行失败/);
      assert.equal(((error as Error & { cause?: Error }).cause)?.message, 'Worker Error ERR_ACCESS_DENIED');
      return true;
    });
  }
  assert.equal(readFileSync(outside,'utf8'),'PRIVATE SYNTHETIC ONLY');
}));

test('unknown new host API fails before generation and is never claimed compatible', () => fixture(async ({ runtime }) => {
  await assert.rejects(runtime.run(input({settings:{unknownHostApi:true},generate:async()=>{throw Error('must never generate');}})), error => {
    assert.match((error as Error).message,/初始化或执行失败/);
    assert.equal(((error as Error & { cause?: Error }).cause)?.message, 'Worker TypeError');
    return true;
  });
}));

test('custom Worker error name/code and message are not forwarded as diagnostics', () => fixture(async ({ runtime }) => {
  await assert.rejects(runtime.run(input({settings:{throwCustomError:true}})), error => {
    const caught = error as Error & { cause?: Error };
    assert.match(caught.message,/初始化或执行失败/);
    assert.equal(caught.cause, undefined);
    assert.doesNotMatch(`${caught.message}\n${caught.stack ?? ''}`, /synthetic_secret|ghp_secret|PRIVATE_ERROR_MARKER/);
    return true;
  });
}));

test('missing/changed source and unsafe settings fail without provider calls', () => fixture(async ({ runtime,setCandidate }) => {
  const unsafe=JSON.parse('{"branding":{"__proto__":{"x":1}}}');
  await assert.rejects(runtime.run(input({settings:unsafe})),/危险 JSON/);
  setCandidate(null);await assert.rejects(runtime.run(input()),/尚未安装/);
}));


test('host projects parsed AI targets without trusting the unrestricted original Program postpass', () => fixture(async ({runtime}) => {
 const original=input({authorDraft:narrative+'\n<options>keep</options>',settings:{fault:'program-inside-target'}});const result=await runtime.run(original);
 assert.equal(result.text,'他说了细微的变化。\n<options>keep</options>');assert.equal(result.projectionMode,'ai-targets-only');assert.equal(result.calls,1);assert.equal(result.changed,true);
 assert.equal(original.authorDraft,narrative+'\n<options>keep</options>');
}));


test('valid original AI targets remain usable when its global Program postpass edits a protected option', () => fixture(async ({ runtime }) => {
 const draft=narrative+'\n<options>不易察觉。</options>';
 const result=await runtime.run(input({authorDraft:draft,settings:{fault:'program-protected-option'}}));
 assert.equal(result.text,'他说了细微的变化。\n<options>不易察觉。</options>');assert.equal(result.calls,1);
 assert.equal(result.projectionMode,'ai-targets-only');assert.deepEqual(result.errors,[]);
 assert.equal(draft,narrative+'\n<options>不易察觉。</options>');
}));


test('adjacent targets and repeated complement anchors are projected by original offsets, not guessed anchors', () => fixture(async ({ runtime }) => {
 const repeated=narrative+narrative+'\n<options>不易察觉。</options>';
 const result=await runtime.run(input({authorDraft:repeated,narrative:narrative+narrative}));
 assert.equal(result.text,'他说了细微的变化。'.repeat(2)+'\n<options>不易察觉。</options>');
 assert.equal(result.hits,2);assert.equal(result.calls,1);assert.equal(result.changed,true);
}));
