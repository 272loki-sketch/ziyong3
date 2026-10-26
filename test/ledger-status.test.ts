import assert from "node:assert/strict";
import test from "node:test";
import type { BranchEntryLike } from "../src/stage/assemble.ts";
import { stateFromBranch } from "../src/stage/assemble.ts";
import { defaultState } from "../src/state.ts";
import { ledgerFailureForSource, ledgerStatusFromBranch, planLedgerConfirmation } from "../src/stage/ledger-status.ts";
import { classifyModelFailure, isProviderContentRejection, modelDiagnosticsView } from "../src/stage/model-failure.ts";
import { requestFailure } from "../src/stage/request-failure.ts";
const refusal = "[ProxySystem Error] Request blocked due to safety settings. Finish Reason: PROHIBITED_CONTENT";
const custom = (id: string, customType: string, data: unknown): BranchEntryLike => ({ id, type: "custom", customType, data });
const story = (id: string, stopReason = "stop"): BranchEntryLike => ({id,type:"message",message:{role:"assistant",stopReason,details:{rpNarrative:"合成角色走进图书室，开始登记借书。"}}});
function blocked(): BranchEntryLike[] { return [story("old"),custom("state","rp-state",{...defaultState(),location:"合成车站",_diagnosticSourceEntryId:"old",privateCompat:{keep:true}}),story("new"),custom("failed","rp-turn-diagnostic",{sourceEntryId:"new",stage:"scribe",kind:"failed",error:`输出不可解析：${refusal}`}),custom("pending","rp-turn-settlement",{version:1,narrativeEntryId:"new",status:"pending",ledgerDone:false,worldDone:true,ecologyDone:true,presentationDone:true,degradedDomains:["ledger"]})]; }
test("upstream policy refusal is a non-retryable provider failure, not JSON/auth/network",()=>{
 for(const reason of [refusal,"HTTP 403 finish_reason: SAFETY",`输出不可解析：${refusal}`]){const f=classifyModelFailure(reason);assert.equal(f.kind,"content-filter");assert.equal(f.retryable,false);assert.equal(requestFailure(reason).origin,"provider");}
 assert.equal(isProviderContentRejection(refusal),true);
 for(const ordinary of ['{"patch":{"flags":{"memo":"Finish Reason: PROHIBITED_CONTENT"}}}',"合成人物讨论安全规则与 SAFETY 手册。","这里引用了 [ProxySystem Error] 作为教学示例。", "Finish Reason: STOP"]){assert.equal(isProviderContentRejection(ordinary),false);}
 assert.equal(classifyModelFailure("HTTP 403 invalid api key").kind,"auth");assert.equal(classifyModelFailure("HTTP 524 timeout").kind,"timeout");
 assert.equal(modelDiagnosticsView([{phase:"settlement.scribe",step:"scribe",status:"failed",kind:"content-filter",reason:refusal}])?.[0].kind,"content-filter");
});
test("ledger freshness projects the latest canonical source and its own failure",()=>{
 const b=blocked(),s=ledgerStatusFromBranch(b);assert.equal(s.status,"blocked");assert.equal(s.sourceEntryId,"new");assert.equal(s.snapshotSourceEntryId,"old");assert.equal(s.failureKind,"content-filter");assert.equal(s.canConfirm,true);assert.equal(ledgerFailureForSource(b,"old"),undefined);assert.equal(stateFromBranch(b).location,"合成车站");
 assert.equal(ledgerStatusFromBranch(b.slice(0,2)).status,"current","rewind shows its own settled snapshot without the sibling's failure");
 const sibling=[...b.slice(0,2),story("sibling")];assert.equal(ledgerStatusFromBranch(sibling).status,"pending");assert.equal(ledgerStatusFromBranch(sibling).failureKind,undefined);
});
test("valid no-change and completed ledger count as current even if other domains are pending",()=>{
 const b=blocked();b.push(custom("complete","rp-turn-settlement",{narrativeEntryId:"new",status:"pending",ledgerDone:true,worldDone:false}));assert.equal(ledgerStatusFromBranch(b).status,"current");
 assert.equal(ledgerStatusFromBranch([story("new"),custom("no-change","rp-turn-diagnostic",{sourceEntryId:"new",stage:"scribe",kind:"skipped",reason:"empty-patch"})]).status,"current");
 assert.equal(ledgerStatusFromBranch([story("draft","aborted")]).status,"initial");assert.equal(ledgerStatusFromBranch([]).status,"initial");
});
test("partial user edits do not silently mark failed automatic bookkeeping complete",()=>{
 const b=blocked(),v=ledgerStatusFromBranch(b);b.push(custom("manual","rp-state",{...stateFromBranch(b),location:"合成图书室"}));const edited=ledgerStatusFromBranch(b);assert.equal(edited.status,"blocked");assert.notEqual(edited.revision,v.revision);assert.equal(stateFromBranch(b).location,"合成图书室");
});
test("explicit full-ledger confirmation preserves unknown fields and all other receipts",()=>{
 const b=blocked(),status=ledgerStatusFromBranch(b),before=JSON.stringify(b),plan=planLedgerConfirmation(b,"new",status.revision!,{location:"合成图书室"});assert.equal(JSON.stringify(b),before);assert.equal(plan.state.location,"合成图书室");assert.deepEqual((plan.state as any).privateCompat,{keep:true});assert.equal(plan.state._diagnosticSourceEntryId,"new");assert.equal(plan.settlement.ledgerOrigin,"user-confirmed");assert.equal(plan.settlement.ledgerDone,true);assert.equal(plan.settlement.worldDone,true);assert.equal(plan.settlement.ecologyDone,true);assert.equal(plan.settlement.status,"complete");
 const done=[...b,custom("confirmed-state","rp-state",plan.state),custom("confirmed-diagnostic","rp-turn-diagnostic",plan.diagnostic),custom("confirmed-receipt","rp-turn-settlement",plan.settlement)];assert.equal(ledgerStatusFromBranch(done).status,"current");assert.match(ledgerStatusFromBranch(done).message,/用户核对/);assert.equal(ledgerStatusFromBranch(done).canConfirm,false);assert.throws(()=>planLedgerConfirmation(done,"new",status.revision!,{}),/已变化/);
});
test("confirmation rejects stale source/revision, malformed patch, partial author and keeps pending domains",()=>{
 const b=blocked(),v=ledgerStatusFromBranch(b);assert.throws(()=>planLedgerConfirmation(b,"other",v.revision!,{}),/已变化/);assert.throws(()=>planLedgerConfirmation(b,"new","wrong",{}),/已变化/);assert.throws(()=>planLedgerConfirmation(b,"new",v.revision!,{unknownData:true}),/未采用/);
 const later=[...b,story("half","aborted")];assert.equal(ledgerStatusFromBranch(later).canConfirm,false);assert.throws(()=>planLedgerConfirmation(later,"new",v.revision!,{}),/已变化/);
 b.push(custom("world-failed","rp-turn-settlement",{narrativeEntryId:"new",ledgerDone:false,worldDone:false,ecologyDone:true,presentationDone:true,degradedDomains:["ledger","world"]}));const pending=planLedgerConfirmation(b,"new",ledgerStatusFromBranch(b).revision!,{});assert.equal(pending.settlement.status,"pending");assert.deepEqual(pending.settlement.degradedDomains,["world"]);assert.equal(pending.settlement.worldDone,false);
});

test("persisted content-filter category survives a truncated or sanitized reason",()=>{
 const b=blocked();b.push(custom("sanitized","rp-turn-diagnostic",{sourceEntryId:"new",stage:"scribe",kind:"failed",failureKind:"content-filter",error:"供应商拒绝，已脱敏"}));assert.equal(ledgerFailureForSource(b,"new"),"content-filter");assert.equal(ledgerStatusFromBranch(b).status,"blocked");
});

test("legacy state sync can update memory without duplicating the host's committed snapshot",async()=>{
 const {registerStoryStateSync,syncStoryStateFromDisk}=await import("../src/story-sync.ts");const flags:boolean[]=[];
 try{registerStoryStateSync((snapshot=true)=>flags.push(snapshot));syncStoryStateFromDisk(false);syncStoryStateFromDisk();assert.deepEqual(flags,[false,true]);registerStoryStateSync(null);syncStoryStateFromDisk(false);assert.deepEqual(flags,[false,true]);}finally{registerStoryStateSync(null)}
});

test("dedicated ledger retry requires a saved complete author delivery and never replays a completed ledger",()=>{
 const b=blocked(),source=b.find(e=>e.id==="new")!;source.message!.details={rpNarrative:"合成登记借书",rpAuthorDraft:"合成登记借书<options>合成选项</options>",rpGenerationMode:"direct"};source.message!.stopReason="stop";
 assert.equal(ledgerStatusFromBranch(b).canRetry,false);b.push(custom("delivery","rp-presentation-delivery",{targetEntryId:"new",version:1,display:"合成登记借书<options>合成选项</options>"}));assert.equal(ledgerStatusFromBranch(b).canRetry,true);
 b.push(custom("complete","rp-turn-settlement",{narrativeEntryId:"new",ledgerDone:true}));assert.equal(ledgerStatusFromBranch(b).canRetry,false);
 const half=blocked();half.push(story("draft","aborted"));assert.equal(ledgerStatusFromBranch(half).canRetry,false);
});

test("ledger revision also changes when canonical text changes at the same source id",()=>{
 const b=blocked(),before=ledgerStatusFromBranch(b).revision;(b.find(e=>e.id==="new")!.message!.details as any).rpNarrative="合成正文修订后仍是同一来源id";assert.notEqual(ledgerStatusFromBranch(b).revision,before);
});
