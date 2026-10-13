import assert from "node:assert/strict";
import test from "node:test";
import { mvuManagementView } from "../server/mvu-view.ts";
import { emptyTavernPluginState, tavernPluginScope } from "../server/tavern-plugin-store.ts";
import type { TavernPluginContext } from "../server/tavern-plugin-http.ts";

const asset={installed:true,enabled:true,version:"synthetic",commit:"fixed",dependencies:2,sha256:"hash"};
function fixture(){
 const context:TavernPluginContext & {scopeKey:string}={sessionId:"synthetic",card:"synthetic-card",sourceEntryId:"round",visibleEntryIds:["user","round"],chat:[{__liyuanEntryId:"user",is_user:true,mes:"SYNTHETIC_INPUT"},{__liyuanEntryId:"round",is_user:false,swipe_id:1,__liyuanAuthorDelivery:"SYNTHETIC_AUTHOR_DELIVERY"}],character:{},userName:"synthetic",readonlyBooks:{},scopeKey:tavernPluginScope({sessionId:"synthetic",card:"synthetic-card"})};
 const state=emptyTavernPluginState();state.chatMetadata.__liyuanPluginProcessed={round:true};state.messages.round={variables:[{stat_data:{wrongSwipe:"WRONG"}},{stat_data:{food:"PRIVATE_SYNTHETIC_VALUE",health:{value:7}}}]};
 return {context,state};
}
test("MVU管理投影只读当前swipe根数量，不泄露正文/变量，不把启用当收据",()=>{
 const {context,state}=fixture(),before=JSON.stringify({context,state});
 const view=mvuManagementView(asset,context,state,{installed:true,enabled:true},false,false);
 assert.equal(view.canRecover,true);assert.deepEqual(view.variables,{rootCount:2,hasData:true});assert.equal(view.receipt,undefined);assert.deepEqual(view.binding,{scopeKey:context.scopeKey,sourceEntryId:"round"});
 assert.doesNotMatch(JSON.stringify(view),/PRIVATE_SYNTHETIC_VALUE|SYNTHETIC_AUTHOR_DELIVERY|SYNTHETIC_INPUT|wrongSwipe/);assert.equal(JSON.stringify({context,state}),before);
});
test("MVU状态展示缺安装/开关/助手/生成/插件忙的真实禁用原因",()=>{
 const {context,state}=fixture();
 const cases=[
  [{...asset,installed:false},{installed:true,enabled:true},false,false,/安装/],
  [{...asset,enabled:false},{installed:true,enabled:true},false,false,/关闭/],
  [asset,{installed:false,enabled:true},false,false,/助手/],
  [asset,{installed:true,enabled:false},false,false,/助手/],
  [asset,{installed:true,enabled:true},true,false,/正在生成/],
  [asset,{installed:true,enabled:true},false,true,/插件任务/],
 ] as const;
 for(const [installed,helper,streaming,busy,reason] of cases){const view=mvuManagementView(installed,context,state,helper,streaming,busy);assert.equal(view.canRecover,false);assert.match(view.recoveryReason!,reason);}
});
test("MVU恢复资格不自动选择旧正文，不允许用户输入/半稿但允许原插件未完成",()=>{
 const {context,state}=fixture();
 for(const patch of [{is_user:true},{__liyuanUnfinished:true},{__liyuanAuthorDelivery:undefined},{__liyuanAuthorDelivery:" "}]){
  const changed=structuredClone(context);Object.assign(changed.chat[1],patch);
  const view=mvuManagementView(asset,changed,state,{installed:true,enabled:true},false,false);assert.equal(view.canRecover,false);assert.match(view.recoveryReason!,/完整/);
 }
 const missing={...context,sourceEntryId:"new-user"};assert.equal(mvuManagementView(asset,missing,state,{installed:true,enabled:true},false,false).canRecover,false);
 delete state.chatMetadata.__liyuanPluginProcessed;
  assert.equal(mvuManagementView(asset,context,state,{installed:true,enabled:true},false,false).canRecover,true);
 state.chatMetadata.__liyuanMvuProcessed={round:{status:"updated",at:"2026-10-10T00:00:00.000Z",secret:"NOT_RETURNED"}};
 const view=mvuManagementView(asset,context,state,{installed:true,enabled:true},false,false);assert.equal(view.canRecover,true);assert.deepEqual(view.receipt,{status:"updated",at:"2026-10-10T00:00:00.000Z"});assert.doesNotMatch(JSON.stringify(view),/NOT_RETURNED/);
});
test("兄弟分支变量与收据不作为当前回合状态",()=>{
 const {context,state}=fixture();delete state.messages.round;state.messages.sibling={variables:{stat_data:{sibling:"NOT_RETURNED"}}};state.chatMetadata.__liyuanMvuProcessed={sibling:{status:"updated"}};
 const view=mvuManagementView(asset,context,state,{installed:true,enabled:true},false,false);assert.deepEqual(view.variables,{rootCount:0,hasData:false});assert.equal(view.receipt,undefined);
});
