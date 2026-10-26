import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@liyuan/agent-runtime";
import { persistNavigation } from "../server/navigation-receipt.ts";

test("a selected earlier branch survives reopen without rewriting or dropping the abandoned story", () => {
 const cwd=mkdtempSync(join(tmpdir(),"liyuan-navigation-"));
 try {
  const sm=SessionManager.create(cwd,join(cwd,"sessions"));
  const first=sm.appendMessage({role:"user",content:"synthetic first input",timestamp:1});
  const second=sm.appendMessage({role:"user",content:"synthetic later input",timestamp:2});sm.flush();
  const before=readFileSync(sm.getSessionFile()!,"utf8"),oldLeaf=sm.getLeafId();sm.branch(first);
  const receipt=persistNavigation(sm,oldLeaf);assert.ok(receipt);assert.equal(sm.getBranch().some(e=>e.id===second),false);
  const reopened=SessionManager.open(sm.getSessionFile()!,join(cwd,"sessions"),cwd);
  assert.equal(reopened.getLeafId(),receipt);assert.equal(reopened.getBranch().some(e=>e.id===first),true);assert.equal(reopened.getBranch().some(e=>e.id===second),false);
  assert.equal(reopened.getEntries().some(e=>e.id===second),true);assert.ok(readFileSync(sm.getSessionFile()!,"utf8").startsWith(before));
  const length=reopened.getEntries().length;persistNavigation(reopened,reopened.getLeafId());assert.equal(reopened.getEntries().length,length,"non-navigation refresh must not append markers");
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
test("navigating before the first input persists a root cursor without forging a user or narrative", () => {
 const cwd=mkdtempSync(join(tmpdir(),"liyuan-navigation-root-"));
 try {
  const sm=SessionManager.create(cwd,join(cwd,"sessions"));sm.appendMessage({role:"user",content:"synthetic",timestamp:1});sm.flush();const previous=sm.getLeafId();sm.resetLeaf();persistNavigation(sm,previous);
  const reopened=SessionManager.open(sm.getSessionFile()!,join(cwd,"sessions"),cwd);assert.equal(reopened.getBranch().filter(e=>e.type==="message").length,0);
  assert.equal(reopened.getBranch().at(-1)?.customType,"rp-navigation");
 }finally{rmSync(cwd,{recursive:true,force:true});}
});

test("restoring the old reply after an uncompleted reroll also restores its durable cursor", () => {
 const cwd=mkdtempSync(join(tmpdir(),"liyuan-navigation-reroll-"));
 try {
  const sm=SessionManager.create(cwd,join(cwd,"sessions")),user=sm.appendMessage({role:"user",content:"synthetic input",timestamp:1});
  const reply=sm.appendCustomEntry("rp-synthetic-reply",{text:"retained reply"});sm.flush();sm.branch(user);sm.appendCustomEntry("rp-model-diagnostics",{cancelled:true});
  const interrupted=sm.getLeafId();sm.branch(reply);persistNavigation(sm,interrupted);
  const reopened=SessionManager.open(sm.getSessionFile()!,join(cwd,"sessions"),cwd);assert.ok(reopened.getBranch().some(e=>e.id===reply));assert.equal(reopened.getBranch().some(e=>e.id===interrupted),false);assert.ok(reopened.getEntries().some(e=>e.id===interrupted));
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
