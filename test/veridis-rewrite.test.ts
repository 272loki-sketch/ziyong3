import assert from'node:assert/strict';import test from'node:test';
import{computeVeridisRewrite,validateRewriteProjection,authorDraftHash,rewriteReceiptFromBranch,VERIDIS_REWRITE_ENTRY_TYPE,type VeridisRewriteProvider}from'../src/stage/veridis-rewrite.ts';
import{resolveStepModel}from'../src/model-routing.ts';
const original='他说话的语气中带着一丝不易察觉的紧张。\n<options>继续交谈\n转身离开</options>\n<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>';
const input={scope:{sessionId:'synthetic',card:'card',sourceEntryId:'source',visibleEntryIds:['source']},authorDraft:original,narrative:'他说话的语气中带着一丝不易察觉的紧张。',guard:()=>{},generate:async()=>''};
function provider(result:any):VeridisRewriteProvider{return{enabled:()=>true,claimRequest:()=>{},run:async()=>({text:original,changed:false,calls:0,errors:[],version:'3.5',commit:'b'.repeat(40),...result})};}
test('pure rewrite is a separately source/hash-bound display draft, not original story mutation',async()=>{
 const before=JSON.stringify(input),result=await computeVeridisRewrite(provider({text:original.replace('他说话的语气中带着一丝不易察觉的紧张。','他说话时停顿了一下。'),calls:1}),input);
 assert.equal(result.status,'complete');assert.equal(result.changed,true);assert.equal(result.authorHash,authorDraftHash(original));assert.equal(JSON.stringify(input),before);assert.equal(result.sourceEntryId,'source');
});
test('options, variables, code, markup and XML comments remain byte-identical',()=>{
 for(const text of [original.replace('继续交谈','承诺付款'),original.replace('[]','[{"op":"remove"}]'),original.replace('<options>','<OPTIONS>')])assert.throws(()=>validateRewriteProjection(original,text),/格式/);
 assert.doesNotThrow(()=>validateRewriteProjection(original,original.replace('一丝不易察觉的紧张','紧张')));
 assert.throws(()=>validateRewriteProjection('正文```js\nx=1\n```','正文```js\nx=2\n```'),/格式/);
});
test('model error, structural corruption or cancellation never replaces original draft',async()=>{
 for(const p of [provider({errors:['synthetic HTTP failure']}),provider({text:original.replace('转身离开','付款')})])assert.equal((await computeVeridisRewrite(p,input)).status,'failed');
 const controller=new AbortController();controller.abort();const r=await computeVeridisRewrite(provider({}),{...input,signal:controller.signal});assert.equal(r.status,'failed');assert.equal(r.text,undefined);
});
test('empty rules are explicitly skipped, not fake successful prose improvement',async()=>{
 const result=await computeVeridisRewrite(provider({skipped:true,reason:'no rule hits'}),input);assert.equal(result.status,'skipped');assert.equal(result.changed,false);assert.equal(result.calls,0);assert.equal(result.text,undefined);
});
test('rewrite display only restores exact source and original author hash',()=>{
 const r:any={version:1,sourceEntryId:'source',authorHash:authorDraftHash(original),status:'complete',text:'projection'};const branch=[{customType:VERIDIS_REWRITE_ENTRY_TYPE,data:r}];
 assert.equal(rewriteReceiptFromBranch(branch,'source',original),r);assert.equal(rewriteReceiptFromBranch(branch,'other',original),undefined);assert.equal(rewriteReceiptFromBranch(branch,'source','edited author'),undefined);
});
test('dedicated rewrite role does not silently use a writer or generic recovery model',()=>{
 assert.equal(resolveStepModel('veridisRewrite',{}, {id:'author'},()=>undefined).model,undefined);
});
test('nested protected tags never terminate options or MVU protection early',()=>{
 for(const source of ['<options><script>x=1</script>original choice</options>','<UpdateVariable><JSONPatch>[]</JSONPatch>protected tail</UpdateVariable>','<options><options>inner</options>outer</options>','<options>unfinished choice']){
  assert.throws(()=>validateRewriteProjection(source,source.replace('original choice','changed').replace('protected tail','changed').replace('outer','changed').replace('unfinished choice','changed')),/格式/);
 }
});
test('failed provider after managed request retains attempt count instead of reporting zero',async()=>{
 const p=provider({});p.run=async i=>{await i.generate({messages:[{role:'user',content:'synthetic'}],maxTokens:100});throw Error('post-generation validation failed');};
 const r=await computeVeridisRewrite(p,input);assert.equal(r.status,'failed');assert.equal(r.calls,1);
});
test('Unicode tags are byte-protected but example tags inside comments do not protect unrelated prose',()=>{
 assert.throws(()=>validateRewriteProjection('<状态栏>原值</状态栏>','<状态面板>原值</状态面板>'),/格式/);
 assert.doesNotThrow(()=>validateRewriteProjection('<!-- 示例 <options> -->一丝不易察觉的紧张。','<!-- 示例 <options> -->紧张。'));
 assert.doesNotThrow(()=>validateRewriteProjection('```html\n<options>示例\n```\n原措辞','```html\n<options>示例\n```\n新措辞'));
});


test('safe target-only projection mode is retained in the source-bound receipt without mutating the author',async()=>{
 const before=JSON.stringify(input);
 const result=await computeVeridisRewrite(provider({text:original.replace('一丝不易察觉的紧张','紧张'),calls:1,projectionMode:'ai-targets-only'}),input);
 assert.equal(result.status,'complete');assert.equal(result.projectionMode,'ai-targets-only');
 assert.equal(result.authorHash,authorDraftHash(original));assert.equal(result.sourceEntryId,'source');
 assert.equal(JSON.stringify(input),before);assert.ok(result.text?.endsWith('<UpdateVariable><JSONPatch>[]</JSONPatch></UpdateVariable>'));
});
