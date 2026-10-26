/** Synthetic host/iframe/composer only. No models, private material or Session Tree writes. */
import assert from "node:assert/strict";
import test from "node:test";
import { installFrontendApi, installFrontendDomContext } from "../web/public/tavern-compat/frontend-api.js";
import { createTavernFrontendCommands } from "../web/src/plugins/tavern-frontend-commands.ts";
import { executeNativeFrontendSlash, registerTavernChatBridge } from "../web/src/tavernShim.ts";

const tick = () => new Promise(resolve => setImmediate(resolve));
function renderer(view = "render") {
 const listeners = new Map<string, Set<(event?: any) => void>>(), sent: any[] = [], timers = new Map<number, () => void>();
 let number = 0;
 const environment: any = { location: { search: `?view=${view}&entryId=reply&scopeKey=scope`, origin: "http://synthetic.test" }, parent: { postMessage: (data: any, origin: string) => sent.push({ data, origin }) }, crypto: { randomUUID: () => `request-${++number}` }, document: { querySelector: () => null }, addEventListener(name: string, fn: any) { const set = listeners.get(name) ?? new Set(); set.add(fn); listeners.set(name, set); }, removeEventListener(name: string, fn: any) { listeners.get(name)?.delete(fn); }, setTimeout(fn: () => void) { timers.set(++number, fn); return number; }, clearTimeout(id: number) { timers.delete(id); } };
 const host: any = { context: { scopeKey: "scope", sourceEntryId: "reply", visibleEntryIds: ["user", "reply"], chat: [{ __liyuanEntryId: "reply" }] }, chat: [{ is_user: true }, { is_user: false }, { is_user: true }], errors: [], modules: {}, getContext: () => ({ getRequestHeaders: () => ({ "content-type": "application/json" }) }), installModules() { this.modules["/script.js"] = { getRequestHeaders: () => ({ "x-liyuan-tavern-scope": "scope", "x-liyuan-tavern-source": "reply", "x-liyuan-tavern-revision": "9" }) }; this.modules["/scripts/slash-commands.js"] = { executeSlashCommandsWithOptions: async (raw: string) => ({ pipe: "local:" + raw }) }; this.modules["/scripts/macros.js"] = { getLastMessageId: () => this.chat.length - 1 }; } };
 installFrontendApi(host, environment); host.installModules();
 const emit = (name: string, event?: any) => { for (const fn of listeners.get(name) ?? []) fn(event); };
 const answer = (extra: any = {}) => { const request = sent.at(-1).data; emit("message", { source: environment.parent, origin: environment.location.origin, data: { ...request, type: "liyuan-tavern-command-result", ok: true, pipe: "accepted", ...extra } }); };
 return { host, environment, listeners, timers, sent, emit, answer, execute: (raw: string) => host.modules["/scripts/slash-commands.js"].executeSlashCommandsWithOptions(raw) };
}

test("native helper UI forwards only composer commands, waits for a matching result and preserves local commands", async () => {
 const r = renderer(), pending = r.execute("/send SYNTHETIC | text|/trigger");
 assert.equal(r.sent.length, 1); assert.equal(r.sent[0].data.command, "/send SYNTHETIC | text|/trigger"); assert.equal(r.sent[0].origin, "http://synthetic.test");
 r.answer(); assert.deepEqual(await pending, { pipe: "accepted", isAborted: false, isError: false });
 assert.equal(r.timers.size, 0); assert.deepEqual(await r.execute("/local x"), { pipe: "local:/local x" }); assert.equal(r.sent.length, 1);
});

test("native command replies reject errors and ignore forged origins/sources/bindings", async () => {
 const r = renderer(), pending = r.execute("/trigger"); let resolved = false; void pending.then(() => { resolved = true; }, () => {});
 const data = { ...r.sent[0].data, type: "liyuan-tavern-command-result", ok: true };
 for (const ev of [{ source: {}, origin: r.environment.location.origin, data }, { source: r.environment.parent, origin: "http://foreign.test", data }, { source: r.environment.parent, origin: r.environment.location.origin, data: { ...data, entryScope: "sibling" } }]) r.emit("message", ev);
 await tick(); assert.equal(resolved, false);
 r.answer({ ok: false, error: "Synthetic outbox rejected" }); await assert.rejects(pending, /outbox rejected/);
});

test("native UI is not available to runtime/manager scripts; closed or rebound contexts reject late results", async () => {
 for (const view of ["runtime", "manager"]) { const r = renderer(view); assert.throws(() => r.execute("/trigger"), /不是当前来源/); assert.equal(r.sent.length, 0); }
 const r = renderer(), late = r.execute("/trigger"); r.host.context = { ...r.host.context }; r.answer(); await assert.rejects(late, /来源已变化/);
 const closed = renderer(), work = closed.execute("/trigger"); closed.emit("pagehide"); await assert.rejects(work, /已关闭/); assert.equal(closed.timers.size, 0); assert.throws(() => closed.execute("/trigger"), /不是当前来源/);
 const timeout = renderer(), waiting = timeout.execute("/trigger"); [...timeout.timers.values()][0](); await assert.rejects(waiting, /不会自动重试/);
});

test("native API host preserves source headers and the actual last-message filter/empty result", () => {
 const r = renderer(); assert.equal(r.host.getContext().getRequestHeaders()["x-liyuan-tavern-source"], "reply");
 const last = r.host.modules["/scripts/macros.js"].getLastMessageId;
 assert.equal(last(), 2); assert.equal(last({ filter: (row: any) => !row.is_user }), 1); assert.equal(last({ filter: () => false }), null);
 assert.throws(() => last({ filter: "invalid" }), /过滤器/); r.host.chat.length = 0; assert.equal(last(), null);
});

function parentHost() {
 const replies: any[] = [], requests: string[] = []; let reads = 0;
 const child = { postMessage: (data: any) => replies.push(data) } as unknown as Window;
 let target = { window: child, token: 1, enabled: true, entryId: "reply", entryScope: "scope" };
 let binding = { scopeKey: "scope", sourceEntryId: "reply" }, stale = false, hold: Promise<void> | undefined;
 const receiver = createTavernFrontendCommands({ origin: "http://synthetic.test", target: () => target, stale: () => stale, loadBinding: async () => { reads++; await hold; return binding; }, execute: command => { requests.push(command); return { ok: true, text: "accepted" }; } });
 const event = (extra: any = {}) => ({ source: child, origin: "http://synthetic.test", data: { type: "liyuan-tavern-command", requestId: "request-one", entryId: "reply", entryScope: "scope", sourceEntryId: "reply", command: "/send SYNTHETIC|/trigger", ...extra } }) as MessageEvent;
 return { receiver, event, replies, requests, get reads() { return reads; }, setTarget(next: any) { target = { ...target, ...next }; }, setBinding(next: any) { binding = next; }, setStale() { stale = true; }, hold(value: Promise<void>) { hold = value; } };
}

test("current identity tables are read-only projections and preset writes cannot silently drop requested fields", async () => {
 const r = renderer(), h = r.host;
 h.context.userName = "SYNTHETIC user"; h.context.userPersona = "SYNTHETIC profile";
 h.context.plugins = [{id:"helper",version:"synthetic"}];h.presets=[{name:"Synthetic preset",prompts:[],extensions:{}}];h.characters=[{data:{}}];
 let writes=0;
 const previous=h.installModules;
 h.installModules=()=>{previous.call(h);};
 // Fresh adapter installation wraps the synthetic underlying module builder.
 delete h.frontendApiInstalled;
 h.installModules=function(){
  h.modules={"/script.js":{},"/scripts/personas.js":{user_avatar:"user.png"},"/scripts/power-user.js":{power_user:{}},"/scripts/extensions.js":{extensionTypes:{}},"/scripts/slash-commands.js":{executeSlashCommandsWithOptions:()=>{}},"/scripts/macros.js":{},"/scripts/preset-manager.js":{getPresetManager:()=>manager}};
 };
 const manager={async savePreset(){writes++;}};
 installFrontendApi(h,r.environment);h.installModules();
 const power=h.modules["/scripts/power-user.js"].power_user;
 assert.equal(power.personas["user.png"],"SYNTHETIC user");assert.equal(power.persona_descriptions["user.png"].description,"SYNTHETIC profile");assert.equal(power.default_persona,null);
 assert.throws(()=>{power.personas={};},/只读/);assert.throws(()=>{power.personas["user.png"]="other";},TypeError);assert.deepEqual(h.characters[0].data.alternate_greetings,[]);
 assert.equal(h.modules["/scripts/extensions.js"].extensionTypes["third-party/JS-Slash-Runner"],"local");
 await assert.rejects(manager.savePreset("Other preset",h.presets[0]),/生产预设/);
 await assert.rejects(manager.savePreset("Synthetic preset",{...h.presets[0],prompts:[{content:"changed"}]}),/生产预设/);assert.equal(writes,0);
 await manager.savePreset("Synthetic preset",{...h.presets[0],extensions:{synthetic:true}});assert.equal(writes,1);
});

test("native non-streaming generation retains its AbortSignal without rewriting message content", async () => {
 const r=renderer(),h=r.host;delete h.frontendApiInstalled;
 h.installModules=()=>{h.modules={"/script.js":{},"/scripts/macros.js":{},"/scripts/slash-commands.js":{executeSlashCommandsWithOptions:()=>{}},"/scripts/openai.js":{}};};
 let captured:any;h.request=async(...args:any[])=>{captured=args;return {candidateOnly:true};};installFrontendApi(h,r.environment);h.installModules();
 const controller=new AbortController();await h.modules["/scripts/openai.js"].sendOpenAIRequest("normal",[{role:"user",content:"SYNTHETIC prompt"}],controller.signal);
 assert.equal(captured[0],"/generate");assert.equal(captured[2],h.context);assert.equal(captured[3],controller.signal);assert.equal(captured[1].messages[0].content,"SYNTHETIC prompt");
});

test("native generation applies its existing request hook and refuses unsupported options before any request", async () => {
 const r=renderer(),h=r.host;delete h.frontendApiInstalled;let change:any,calls=0;
 h.installModules=()=>{h.modules={"/script.js":{eventSource:{emit:async(_name:any,data:any)=>{Object.assign(data,change);}},event_types:{CHAT_COMPLETION_SETTINGS_READY:"ready"}},"/scripts/macros.js":{},"/scripts/slash-commands.js":{executeSlashCommandsWithOptions:()=>{}},"/scripts/openai.js":{oai_settings:{openai_max_tokens:512,temp_openai:0.4}}};};
 h.request=async(_path:any,payload:any)=>{calls++;return payload;};installFrontendApi(h,r.environment);h.installModules();
 const generate=h.modules["/scripts/openai.js"].sendOpenAIRequest;
 for(const unsupported of [{tools:[]},{json_schema:{}},{response_format:{}},{tool_choice:"auto"}]){change=unsupported;await assert.rejects(generate("normal",[{role:"user",content:"SYNTHETIC"}]),/未调用模型/);}
 assert.equal(calls,0);change={top_p:0.5};await assert.rejects(generate("normal",[{role:"user",content:"SYNTHETIC"}]),/不支持参数 top_p/);assert.equal(calls,0);change={};await assert.rejects(generate("normal",[{role:"user",content:[{type:"image_url",image_url:{url:"SYNTHETIC"}}]}]),/未丢弃输入/);assert.equal(calls,0);
 change={temperature:0.7};const result=await generate("normal",[{role:"user",content:"SYNTHETIC"}]);assert.equal(result.max_tokens,512);assert.equal(result.temperature,0.7);assert.equal(calls,1);
});

test("parent runs a source-bound command once and returns the cached receipt for an identical id", async () => {
 const r = parentHost(); r.receiver.receive(r.event()); r.receiver.receive(r.event()); await tick();
 assert.equal(r.reads, 1); assert.deepEqual(r.requests, ["/send SYNTHETIC|/trigger"]); assert.equal(r.replies.length, 2); assert.equal(r.replies[0].ok, true);
 r.receiver.receive(r.event({ command: "/send DIFFERENT|/trigger" })); await tick(); assert.match(r.replies.at(-1).error, /其他命令/); assert.equal(r.requests.length, 1); r.receiver.dispose();
});

test("parent rejects wrong-window/origin/scope/disabled and changed-head commands without side effects", async () => {
 const r = parentHost(); r.receiver.receive({ ...r.event(), source: {} } as any); r.receiver.receive({ ...r.event(), origin: "http://foreign.test" }); assert.equal(r.reads, 0);
 r.receiver.receive(r.event({ entryScope: "sibling" })); assert.equal(r.reads, 0); assert.equal(r.replies.at(-1).ok, false);
 r.setBinding({ scopeKey: "scope", sourceEntryId: "new-reply" }); r.receiver.receive(r.event()); await tick(); assert.equal(r.requests.length, 0); assert.match(r.replies.at(-1).error, /分支已变化/);
 r.setTarget({ enabled: false }); r.receiver.receive(r.event({ requestId: "disabled" })); assert.equal(r.requests.length, 0); r.receiver.dispose();
});

test("parent refuses late validation after navigation or disposal and never submits from a stale workspace", async () => {
 for (const action of ["navigation", "dispose", "stale"]) {
  const r = parentHost(); let release!: () => void; r.hold(new Promise<void>(resolve => { release = resolve; }));
  r.receiver.receive(r.event()); if (action === "navigation") r.setTarget({ token: 2 }); else if (action === "dispose") r.receiver.dispose(); else r.setStale();
  release(); await tick(); assert.equal(r.requests.length, 0); if (action === "dispose") assert.equal(r.replies.length, 0); else assert.equal(r.replies.at(-1).ok, false); r.receiver.dispose();
 }
});

test("native composer supports fill/trigger/plain pipes and propagates real outbox refusal, without system commands", () => {
 const fills: string[] = [], sends: string[] = []; let accepted = true;
 registerTavernChatBridge({ getInput: () => "SYNTHETIC current input", setInput: value => fills.push(value), sendPrompt: value => { sends.push(value); return accepted ? { accepted: true } : { accepted: false, reason: "Synthetic persistence failed" }; }, runCommand: () => { throw new Error("must not execute commands"); } });
 try {
  assert.equal(executeNativeFrontendSlash("/setinput SYNTHETIC").filledOnly, true); assert.deepEqual(fills, ["SYNTHETIC"]);
  assert.equal(executeNativeFrontendSlash("/setinput").ok, true); assert.equal(fills.at(-1), "");
  assert.equal(executeNativeFrontendSlash("/send SYNTHETIC | plain|/trigger").ok, true); assert.equal(sends.at(-1), "SYNTHETIC | plain");
  assert.equal(executeNativeFrontendSlash("/trigger").ok, true); assert.equal(sends.at(-1), "SYNTHETIC current input");
  const before = sends.length;
  for (const command of ["/send text|/trigger|/trigger", "/send x|/rewind", "/send /rewind|/trigger", "/send role=system text|/trigger", "/trigger|/send x", "/sendas name=system x"]) assert.equal(executeNativeFrontendSlash(command).ok, false, command);
  assert.equal(sends.length, before); accepted = false; const result = executeNativeFrontendSlash("/send text|/trigger"); assert.equal(result.ok, false); assert.match(result.error!, /persistence failed/);
 } finally { registerTavernChatBridge(null); }
});

test("legacy postMessage input accepts only a mounted card frame, not foreign or same-origin unrelated windows", async () => {
 const global=globalThis as any, before={window:global.window,document:global.document};
 const owned={},foreign={},listeners=new Map<string,any>(),fills:string[]=[];
 global.window={location:{origin:"http://synthetic.test"},addEventListener:(name:string,fn:any)=>listeners.set(name,fn)};
 global.document={querySelectorAll:(selector:string)=>{assert.equal(selector,"iframe.msg-html-frame");return[{contentWindow:owned}];}};
 try{
  const {installParentTavernShim}=await import("../web/src/tavernShim.ts");installParentTavernShim();registerTavernChatBridge({setInput:text=>fills.push(text),sendPrompt:()=>{throw Error("must not send");}});
  const receive=listeners.get("message"),data={liyuanTriggerSlash:"/send SYNTHETIC draft"};
  receive({source:foreign,origin:"http://foreign.test",data});receive({source:foreign,origin:"http://synthetic.test",data});receive({source:foreign,origin:"null",data});assert.deepEqual(fills,[]);
  receive({source:owned,origin:"null",data});await tick();assert.deepEqual(fills,["SYNTHETIC draft"]);
 }finally{registerTavernChatBridge(null);if(before.window===undefined)delete global.window;else global.window=before.window;if(before.document===undefined)delete global.document;else global.document=before.document;}
});


test("native displayed-message jQuery context stays in its host without replacing the helper function", () => {
 const document={synthetic:'host'},parent={document:{synthetic:'App'}},calls:any[]=[];
 const native=(selector:any,context:any)=>{calls.push({selector,context});return{selector,context};};
 const helper={retrieveDisplayedMessage:()=>{}};
 const environment:any={$:native,jQuery:native,document,parent,TavernHelper:helper};
 const original=helper.retrieveDisplayedMessage;installFrontendDomContext({},environment);
 assert.equal(environment.$('#chat > .mes[mesid="1"]',parent.document).context,document);
 assert.equal(environment.$('#send_textarea',parent.document).context,parent.document);
 assert.equal(environment.$(document,parent.document).context,parent.document);
 assert.equal(environment.$,environment.jQuery);assert.equal(helper.retrieveDisplayedMessage,original);
 assert.equal(calls.length,3);
});
