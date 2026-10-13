import assert from "node:assert/strict";
import test from "node:test";
import {mvuRecoveryMessage,mvuReceiptMessage,sameMvuBinding} from "../web/src/mvu-ui.ts";
test("MVU四种恢复结果如实说明，未知结果不是成功",()=>{
 for(const [status,pattern] of [["updated",/更新并保存/],["unchanged",/未发现新的变量变动/],["existing",/已有变量数据已采用/],["reused",/已经处理过/]] as const){const text=mvuRecoveryMessage({sourceEntryId:"synthetic",status,variableRootKeys:3});assert.match(text,pattern);assert.match(text,/根分组 3 个/);}
 for(const status of ["unrecognized","toString","constructor","__proto__"]){assert.throws(()=>mvuRecoveryMessage({sourceEntryId:"synthetic",status}),/不把未知结果当作成功/);}assert.match(mvuReceiptMessage("normal"),/正常拍后处理/);assert.match(mvuReceiptMessage("legacy"),/历史状态/);
});
test("MVU界面绑定比较包含会话/卡作用域及回合来源，未读取不算相同",()=>{
 assert.equal(sameMvuBinding({scopeKey:"one",sourceEntryId:"round"},{scopeKey:"one",sourceEntryId:"round"}),true);
 assert.equal(sameMvuBinding({scopeKey:"one",sourceEntryId:"round"},{scopeKey:"two",sourceEntryId:"round"}),false);
 assert.equal(sameMvuBinding({scopeKey:"one",sourceEntryId:"round"},{scopeKey:"one",sourceEntryId:"sibling"}),false);
 assert.equal(sameMvuBinding(undefined,undefined),false);
});
