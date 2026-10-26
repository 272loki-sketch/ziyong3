/** Budget/lock crash regressions: isolated synthetic files, real local child processes, zero model calls. */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireTavernPluginLock, TAVERN_LEGACY_LOCK_GRACE_MS } from "../server/tavern-plugin-lock.ts";
import { emptyTavernPluginState, TavernPluginStore, tavernPluginScope } from "../server/tavern-plugin-store.ts";
const binding = { sessionId: "synthetic-lock-budget", card: "synthetic-card", sourceEntryId: "synthetic-source", visibleEntryIds: ["synthetic-source"] };
const lockModule = new URL("../server/tavern-plugin-lock.ts", import.meta.url).href;
const storeModule = new URL("../server/tavern-plugin-store.ts", import.meta.url).href;
async function fixture(run: (f: {cwd:string;store:TavernPluginStore;root:string;lock:string}) => void | Promise<void>) {
 const cwd = mkdtempSync(join(tmpdir(), "liyuan-tavern-lock-budget-"));
 try { const store = new TavernPluginStore(cwd); store.read(binding); const root = join(store.root, tavernPluginScope(binding)); await run({ cwd, store, root, lock:join(root, ".write-lock") }); }
 finally { rmSync(cwd, {recursive:true,force:true}); }
}
function child(code:string,...args:string[]):ChildProcess { return spawn(process.execPath, ["--input-type=module", "-e", code, ...args], {stdio:["ignore","pipe","pipe","ipc"]}); }
async function stop(proc:ChildProcess) { if (proc.exitCode === null && proc.signalCode === null) { const exited = once(proc,"exit"); proc.kill("SIGKILL"); await exited; } }

test("unlimited cumulative ledger survives store re-instantiation without changing story revision or branch inheritance", () => fixture(({cwd,store}) => {
 for(let n=1;n<=8;n++)assert.equal(store.claimModelRequest(binding,8,()=>{}).calls,n);
 const restarted=new TavernPluginStore(cwd);assert.equal(restarted.claimModelRequest(binding,8,()=>{}).calls,9);
 assert.deepEqual(restarted.read(binding),{revision:0,state:emptyTavernPluginState()});
 for(const target of [{...binding,card:"other-card"},{...binding,sessionId:"other-session"},{...binding,sourceEntryId:"other-source"}])assert.equal(restarted.claimModelRequest(target,8,()=>{}).calls,1);
}));

test("guard/invalid accounting data fail closed without clearing history", () => fixture(({store,root}) => {
 assert.throws(()=>store.claimModelRequest(binding,8,()=>{throw new Error("synthetic cancelled");}),/cancelled/);
 assert.equal(existsSync(join(root,"model-request-budget.json")),false);
 store.claimModelRequest(binding,8,()=>{});writeFileSync(join(root,"model-request-budget.json"),'{"version":99,"claims":{}}');
 assert.throws(()=>store.claimModelRequest(binding,8,()=>{}),/计数账本无效/);
 assert.equal(store.read(binding).revision,0);
}));

test("ledger is private and a failed claimed attempt is not refunded after restart", () => fixture(({cwd,store,root}) => {
 store.claimModelRequest(binding,8,()=>{});
 if(process.platform!=="win32")assert.equal(lstatSync(join(root,"model-request-budget.json")).mode&0o777,0o600);
 assert.equal(new TavernPluginStore(cwd).claimModelRequest(binding,8,()=>{}).calls,2);
}));

test("real killed writer's lock is recovered for both state saving and model allowance", () => fixture(async ({store,root,lock}) => {
 const proc=child(`import {acquireTavernPluginLock} from ${JSON.stringify(lockModule)}; const lock=acquireTavernPluginLock(process.argv[1]);process.send('ready');setInterval(()=>{},1000);`,root);
 try { await once(proc,"message");assert.throws(()=>store.save(binding,0,emptyTavernPluginState(),()=>{}),{statusCode:409});await stop(proc);
  assert.equal(existsSync(lock),true);assert.equal(store.save(binding,0,emptyTavernPluginState(),()=>{}).revision,1);assert.equal(store.claimModelRequest(binding,8,()=>{}).calls,1);assert.equal(existsSync(lock),false);
 } finally { await stop(proc); }
}));

test("still-live owner is not stolen even when its timestamps are old", () => fixture(({store,root,lock}) => {
 const held=acquireTavernPluginLock(root);try { const old=new Date(Date.now()-24*3600_000);utimesSync(lock,old,old);
 assert.throws(()=>store.claimModelRequest(binding,8,()=>{}),{statusCode:409});held.assertOwned();
 }finally{held.release();}
 assert.equal(store.claimModelRequest(binding,8,()=>{}).calls,1);
}));

test("PID reuse is distinguished by Linux starttime", {skip:process.platform!=="linux"}, () => fixture(({store,root,lock}) => {
 const held=acquireTavernPluginLock(root),path=join(lock,"owner.json"),owner=JSON.parse(readFileSync(path,"utf8"));
 owner.startTime="0";writeFileSync(path,JSON.stringify(owner));
 assert.equal(store.claimModelRequest(binding,8,()=>{}).calls,1);
 assert.throws(()=>held.release(),{statusCode:409});assert.equal(existsSync(lock),false);
}));

test("fresh legacy empty lock is respected; stable empty legacy lock past the grace period is recovered", () => fixture(({store,lock}) => {
 mkdirSync(lock,{mode:0o700});assert.throws(()=>store.claimModelRequest(binding,8,()=>{}),{statusCode:409});
 const old=new Date(Date.now()-TAVERN_LEGACY_LOCK_GRACE_MS-1000);utimesSync(lock,old,old);
 assert.equal(store.claimModelRequest(binding,8,()=>{}).calls,1);assert.equal(existsSync(lock),false);
}));

test("unknown/malformed owner and symlink locks are never recursively removed", () => fixture(({store,root,lock,cwd}) => {
 mkdirSync(lock,{mode:0o700});writeFileSync(join(lock,"owner.json"),"not-json");const old=new Date(Date.now()-60_000);utimesSync(lock,old,old);
 assert.throws(()=>store.claimModelRequest(binding,8,()=>{}),{statusCode:409});assert.equal(readFileSync(join(lock,"owner.json"),"utf8"),"not-json");
 rmSync(lock,{recursive:true});const outside=join(cwd,"synthetic-outside");mkdirSync(outside);writeFileSync(join(outside,"marker"),"preserved");symlinkSync(outside,lock,"dir");
 assert.throws(()=>store.claimModelRequest(binding,8,()=>{}),{statusCode:409});assert.equal(readFileSync(join(outside,"marker"),"utf8"),"preserved");
}));

test("lost lease cannot release or publish through a replacement owner's nonce", () => fixture(({root,lock}) => {
 const held=acquireTavernPluginLock(root),path=join(lock,"owner.json"),value=JSON.parse(readFileSync(path,"utf8"));value.nonce="f".repeat(48);writeFileSync(path,JSON.stringify(value));
 assert.throws(()=>held.assertOwned(),{statusCode:409});assert.throws(()=>held.release(),{statusCode:409});assert.equal(JSON.parse(readFileSync(path,"utf8")).nonce,value.nonce);
}));

test("two real processes serialize cumulative accounting without dropping requests or imposing a quota", () => fixture(async ({cwd,store}) => {
 const code=`import {TavernPluginStore} from ${JSON.stringify(storeModule)};const store=new TavernPluginStore(process.argv[1]),binding=${JSON.stringify(binding)};process.send('ready');process.once('message',async()=>{let wins=0;for(let n=0;n<80;n++){try{store.claimModelRequest(binding,8,()=>{});wins++;}catch(e){if(e.statusCode!==409)break;}await new Promise(r=>setTimeout(r,2));}process.send({wins});process.disconnect();});`;
 const a=child(code,cwd),b=child(code,cwd);
 try { await Promise.all([once(a,"message"),once(b,"message")]);const results=Promise.all([once(a,"message"),once(b,"message")]);a.send('go');b.send('go');const [[ra],[rb]]=await results;
 const total=ra.wins+rb.wins;assert.ok(total>8);assert.equal(store.modelRequestUsage(binding).used,total);assert.equal(store.claimModelRequest(binding,8,()=>{}).calls,total+1);assert.equal(store.read(binding).revision,0);
 }finally{await Promise.all([stop(a),stop(b)]);}
}));

test("a crashed recovery gate is also reclaimed, not left as a permanent conflict", () => fixture(async ({store,root,lock}) => {
 mkdirSync(lock,{mode:0o700});const old=new Date(Date.now()-60_000);utimesSync(lock,old,old);
 const code=`import {acquireTavernPluginLock} from ${JSON.stringify(lockModule)};acquireTavernPluginLock(process.argv[1]);process.send('ready');setInterval(()=>{},1000);`;
 // Acquire at an inner root to produce the same verifiable owner format for the recovery gate.
 const gateParent=join(root,"synthetic-gate-parent");mkdirSync(gateParent);const proc=child(code,gateParent);
 try {await once(proc,"message");await stop(proc);const {renameSync}=await import("node:fs");renameSync(join(gateParent,".write-lock"),join(lock,".recovery-lock"));utimesSync(lock,old,old);
 assert.equal(store.claimModelRequest(binding,8,()=>{}).calls,1);assert.equal(existsSync(lock),false);
 }finally{await stop(proc);}
}));

test("lost lock ownership before publication cannot advance the state head or budget ledger", () => fixture(({store,lock,root}) => {
 const steal=()=>{const path=join(lock,"owner.json"),owner=JSON.parse(readFileSync(path,"utf8"));owner.nonce="e".repeat(48);writeFileSync(path,JSON.stringify(owner));};
 let checks=0;assert.throws(()=>store.save(binding,0,emptyTavernPluginState(),()=>{if(++checks===2)steal();}),{statusCode:409});
 assert.equal(existsSync(join(root,"index.json")),false);rmSync(lock,{recursive:true});checks=0;
 assert.throws(()=>store.claimModelRequest(binding,8,()=>{if(++checks===2)steal();}),{statusCode:409});assert.equal(existsSync(join(root,"model-request-budget.json")),false);
}));
