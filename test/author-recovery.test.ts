import assert from "node:assert/strict";
import test from "node:test";
import { parseAuthorRecoveryReceipt } from "../src/stage/author-recovery.ts";
test("same-author recovery accepts JSON in original card containers without changing suffix bytes",()=>{
 const suffix='。\n随后他们端起碗，一起用餐。</content>\n<options>原作者选项</options>';
 for(const text of [JSON.stringify({suffix}),`\`\`\`json\n${JSON.stringify({suffix})}\n\`\`\``,`<rule_check>原卡包装</rule_check><content>${JSON.stringify({suffix})}</content>`,`接续回执：\n${JSON.stringify({suffix})}`])assert.deepEqual(parseAuthorRecoveryReceipt(text),{ok:true,suffix});
});
test("same-author recovery scanner respects escaped quotes/braces and rejects ambiguous receipts",()=>{
 const suffix='她指着符号 {x} 说："这是原文。"\\然后落座。';assert.deepEqual(parseAuthorRecoveryReceipt('回执\n'+JSON.stringify({suffix})+'\n结束'),{ok:true,suffix});
 assert.deepEqual(parseAuthorRecoveryReceipt('{"suffix":"旧版本"}\n{"suffix":"新版本"}'),{ok:false,reason:'ambiguous-json'});
 for(const text of ['补全正文。','{"suffix":"没闭合','{"not_suffix":"正文"}'])assert.equal(parseAuthorRecoveryReceipt(text).ok,false);
 for(const suffix of['',null,{},3])assert.equal(parseAuthorRecoveryReceipt(JSON.stringify({suffix})).ok,false);
});
