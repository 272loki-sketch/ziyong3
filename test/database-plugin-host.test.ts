import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../web/public/database-plugin-host.js", import.meta.url), "utf8");

/** Exercises the host lifecycle without importing upstream bytes, private data or a browser. */
function hostFixture(view: string, options: { open?: () => Promise<boolean>; stateSave?: () => Promise<any>; contextError?: boolean; legacyOpen?: boolean; scriptLoadFailure?: boolean; standalone?: boolean; binding?: {scopeKey:string;sourceEntryId:string;sha256:string}; context?: Record<string, unknown>; contextResponse?: () => Record<string, unknown>; intercept?: (params: any) => any; suppressGeneration?: boolean; modelError?: string; generateHook?: (params:any, window:any, capture:(params:any)=>Promise<string>)=>Promise<unknown> } = {}) {
	const messages: Array<{ type: string; message?: string }> = [];
	const elements = new Map<string, any>();
	const polls: Array<() => Promise<void>> = [];
	const replacements: string[] = [];
	const savedStates: any[] = [];
	for (const id of ["host-home", "host-status", "host-open", "host-tables", "host-sync", "host-feedback", "host-retry", "send_but", "send_textarea"]) {
		elements.set(id, { dataset: {}, hidden: false, disabled: id === "host-open", textContent: "", addEventListener(name: string, cb: () => void) { this[name] = cb; }, dispatchEvent(event: any) { this[event.type]?.(); return true; } });
	}
	let opens = 0;
	const open = async () => { opens++; return await (options.open?.() ?? Promise.resolve(true)); };
 const window: any = {
  setTimeout: (fn: () => void, delay: number) => setTimeout(fn, delay === 45000 ? delay : 0),
		parent: { postMessage(message: any, origin: string) { assert.equal(origin, "https://synthetic.invalid"); messages.push(message); } },
		fetch: async (path: string, init?: {body?:string}) => {
			if (path.endsWith("/state")) { savedStates.push(JSON.parse(init?.body ?? "{}").state); return options.stateSave ? options.stateSave() : { ok: true, json: async () => ({globalRevision: 1}) }; }
			if ((path.endsWith("/completion") || path.endsWith("/generate")) && options.modelError) return new Response(JSON.stringify({error:options.modelError}),{status:400,headers:{"content-type":"application/json"}});
			if (path.endsWith("/binding")) return { ok: true, json: async () => ({ ...(options.binding ?? { scopeKey: "fixture-scope", sourceEntryId: "a-1", sha256: "verified-fixture-source" }) }) };
			if (options.contextError) throw new Error("合成登录已失效");
			return { ok: true, json: async () => ({ scopeKey: "fixture-scope", sourceEntryId: "a-1", revision: 0, scope: { sessionId: "fixture-session" }, chat: [], chatMetadata: {}, extensionSettings: {}, worldbooks: { Fixture: { entries: [] } }, primaryBook: "Fixture", character: { name: "合成人物" }, userName: "合成用户", ...(options.contextResponse?.() ?? options.context) }) };
		},
	};
	if (options.standalone) { window.postMessage = window.parent.postMessage; window.parent = window; }
	const document = {
		documentElement: { dataset: {} as Record<string, string> },
		getElementById: (id: string) => elements.get(id),
		createElement: () => ({}),
		head: { append(script: any) {
			if (script.src.endsWith("source/index.js")) {
				window.AutoCardUpdaterAPI = { triggerUpdate: async () => ({ success: true }), refreshDataAndWorldbook: async () => {}, openSettings: open };
				window.AutoCardUpdaterV2API = options.legacyOpen ? {} : { open, openVisualizer: async () => { window.tableOpens = (window.tableOpens ?? 0) + 1; return true; }, refreshVisualizer: async () => { window.tableRefreshes = (window.tableRefreshes ?? 0) + 1; } };
				const hostGenerate = window.TavernHelper.generate;
				window.TavernHelper.generate = async (params: any) => { if(options.generateHook) return options.generateHook(params,window,hostGenerate); if (options.suppressGeneration) return; return hostGenerate(options.intercept?.(params) ?? params); };
			}
			queueMicrotask(() => options.scriptLoadFailure ? script.onerror() : script.onload());
		} },
	};
	vm.runInNewContext(`(async () => { ${source} })()`, { window, document, location: { search: view, origin: "https://synthetic.invalid", href: "https://synthetic.invalid/database-plugin-host.html" + view, reload() {}, replace(url: string) { replacements.push(url); } }, URL, URLSearchParams, Response, Error, Event, clearTimeout, setInterval: (cb: () => Promise<void>, delay: number) => { assert.equal(delay,2500); polls.push(cb); }, setTimeout: (fn: () => void, delay: number) => setTimeout(fn, delay === 45000 ? delay : 0) });
	return { window, document, elements, messages, polls, replacements, savedStates, opens: () => opens };
}
async function settled(f: ReturnType<typeof hostFixture>) {
	for (let i = 0; i < 100 && !f.messages.some(m => /liyuan-database-(ready|error)/.test(m.type)); i++) await new Promise(resolve => setTimeout(resolve, 5));
	assert.ok(f.messages.some(m => /liyuan-database-(ready|error)/.test(m.type)), "the host must report readiness or an actionable failure");
}

test("database host: background runtime stays headless; management view explicitly opens the original UI", async () => {
	const background = hostFixture(""); await settled(background);
	assert.equal(background.opens(), 0);
	assert.equal(background.window.LiyuanDatabasePluginHost.ready(), true);
	assert.equal(background.document.documentElement.dataset.view, "runtime");
	const manager = hostFixture("?view=manager"); await settled(manager);
	assert.equal(manager.opens(), 1);
	assert.equal(manager.window.LiyuanDatabasePluginHost.ready(), true);
	assert.equal(manager.elements.get("host-open").disabled, false);
	assert.equal(manager.elements.get("host-home").hidden, true, "embedded view must not navigate the parent application");
	assert.equal(manager.document.documentElement.dataset.view, "manager");
	assert.equal(manager.messages.at(-1)?.type, "liyuan-database-ready");
});

test("database host: manager readiness waits for actual upstream open, and closed UI can be reopened", async () => {
	let release!: (value: boolean) => void;
	const opening = new Promise<boolean>(resolve => { release = resolve; });
	const manager = hostFixture("?view=manager", { open: () => opening });
	for (let i = 0; i < 50 && !manager.opens(); i++) await new Promise(resolve => setTimeout(resolve, 5));
	assert.equal(manager.opens(), 1);
	assert.equal(manager.messages.some(m => m.type === "liyuan-database-ready"), false, "script load must not be mistaken for visible management UI");
	assert.equal(manager.window.LiyuanDatabasePluginHost.ready(), false);
	release(true); await settled(manager);
	manager.elements.get("host-open").click(); await new Promise(resolve => setTimeout(resolve, 5));
	assert.equal(manager.opens(), 2);
});

test("database host: failed upstream open reports error, never success, and exposes retry", async () => {
	const manager = hostFixture("?view=manager", { open: async () => false }); await settled(manager);
	assert.equal(manager.window.LiyuanDatabasePluginHost.ready(), false);
	assert.equal(manager.messages.at(-1)?.type, "liyuan-database-error");
	assert.match(manager.messages.at(-1)!.message!, /管理界面未能打开/);
	assert.equal(manager.elements.get("host-retry").hidden, false);
});

test("database host: context/login errors are surfaced and original legacy openSettings remains supported", async () => {
	const failed = hostFixture("?view=manager", { contextError: true }); await settled(failed);
	assert.match(failed.messages.at(-1)!.message!, /登录已失效/);
	assert.equal(failed.elements.get("host-open").disabled, true);
	const legacy = hostFixture("?view=manager", { legacyOpen: true }); await settled(legacy);
	assert.equal(legacy.opens(), 1);
	assert.equal(legacy.window.LiyuanDatabasePluginHost.ready(), true);
});

test("database host: stale initial scope/source and source-version bindings never open another conversation's manager", async () => {
 const stale = hostFixture("?view=manager&scopeKey=other&sourceEntryId=old"); await settled(stale);
 assert.equal(stale.opens(), 0);assert.equal(stale.messages.at(-1)?.type,"liyuan-database-error");assert.match(stale.messages.at(-1)!.message!, /分支已变化/);
 const version = hostFixture("?view=manager&hostSource=old-version"); await settled(version);
 assert.equal(version.opens(), 0);assert.match(version.messages.at(-1)!.message!, /版本已变化/);
 const matched = hostFixture("?view=manager&scopeKey=fixture-scope&sourceEntryId=a-1&hostSource=verified-fixture-source"); await settled(matched);
 assert.equal(matched.opens(), 1);assert.equal(matched.window.LiyuanDatabasePluginHost.ready(),true);
});

test("database host: dependency failures expose a retry instead of a stuck loading page", async () => {
 const manager=hostFixture("?view=manager",{scriptLoadFailure:true}); await settled(manager);
 assert.equal(manager.window.LiyuanDatabasePluginHost.ready(),false);assert.equal(manager.opens(),0);
 assert.equal(manager.elements.get("host-retry").hidden,false);assert.match(manager.messages.at(-1)!.message!,/依赖加载失败/);
});

test("database host: standalone UI follows scope/source/version through lightweight polling, background runtime never polls", async () => {
 const binding={scopeKey:"fixture-scope",sourceEntryId:"a-1",sha256:"verified-fixture-source"};
 const manager=hostFixture("?view=manager",{standalone:true,binding});await settled(manager);
 assert.equal(manager.elements.get("host-home").hidden,false);
 assert.equal(manager.polls.length,1);await manager.polls[0]();assert.equal(manager.replacements.length,0);
 binding.scopeKey="new-card-scope";binding.sourceEntryId="b-1";binding.sha256="next-verified-source";
 await manager.polls[0]();const url=new URL(manager.replacements[0]);
 assert.equal(url.searchParams.get("view"),"manager");assert.equal(url.searchParams.get("scopeKey"),binding.scopeKey);
 assert.equal(url.searchParams.get("sourceEntryId"),binding.sourceEntryId);assert.equal(url.searchParams.get("hostSource"),binding.sha256);
 const background=hostFixture("",{standalone:true,binding});await settled(background);assert.equal(background.polls.length,0);
});

const managedModelsFixture = {
	revision: "fixture-flash-3.8-revision",
	presets: [
		{ name: "合成 3.8 填表", purpose: "fill", provider: "fixture-flash", model: "gemini-3.8-flash", url: "/api/database-plugin/connections/fill/fixture-flash/v1", maxTokens: 16384, apiKey: "synthetic-fill-secret-do-not-copy" },
		{ name: "合成 3.8 召回", purpose: "recall", provider: "fixture-flash", model: "gemini-3.8-flash", url: "/api/database-plugin/connections/recall/fixture-flash/v1", maxTokens: 8192, apiKey: "synthetic-recall-secret-do-not-copy" },
	],
};
const profileSettingsKey = "shujuku_v120_profile_v1__" + "__default__" + "__settings";
const globalMetaKey = "shujuku_v120_globalMeta_v1";
test("database sync retains upstream namespace references and crossfire settings survive save/reopen", async () => {
 const namespaceName = "shujuku_v120__userscript_settings_v1";
 const profile = { maxConcurrentGroups: 3, plotSettings: { enabled: true, tasks: [{ id: "user-task", enabled: false }] }, customUnknown: "keep" };
 const globalMeta = { version: 1, __liyuanNativeRecallBridgeVersion: 1, formFillPreferencesGlobal: { schemaVersion: 1, selectedMode: "crossfire", customUnknown: "keep" }, vectorMemoryConfigGlobal: { enabled: true, topK: 137, minScore: 0.42 } };
 const context = { extensionSettings: { __userscripts: { [namespaceName]: { [profileSettingsKey]: JSON.stringify(profile), [globalMetaKey]: JSON.stringify(globalMeta) } } } };
 const f = hostFixture("?view=manager", { context }); await settled(f);
 const root = f.window.SillyTavern.getContext().extensionSettings;
 const cachedNamespace = root.__userscripts[namespaceName];
 await f.window.LiyuanDatabasePluginHost.sync();
 assert.equal(root.__userscripts[namespaceName], cachedNamespace, "upstream writes must remain attached to the saved settings root");
 const edited = JSON.parse(cachedNamespace[globalMetaKey]); edited.vectorMemoryConfigGlobal.topK = 151;
 cachedNamespace[globalMetaKey] = JSON.stringify(edited);
 f.window.saveSettingsDebounced(); await f.window.LiyuanDatabasePluginHost.flush();
 const saved = f.savedStates.at(-1).extensionSettings;
 assert.equal(JSON.parse(saved.__userscripts[namespaceName][globalMetaKey]).vectorMemoryConfigGlobal.topK, 151);
 const reopened = hostFixture("?view=manager", { context: { extensionSettings: saved } }); await settled(reopened);
 const restored = reopened.window.SillyTavern.getContext().extensionSettings.__userscripts[namespaceName];
 assert.deepEqual(JSON.parse(restored[globalMetaKey]), edited);
 assert.deepEqual(JSON.parse(restored[profileSettingsKey]), profile);
});
function upstreamSettings(f: ReturnType<typeof hostFixture>) {
	const extensionSettings = f.window.SillyTavern.getContext().extensionSettings;
	const namespace = extensionSettings.__userscripts.shujuku_v120__userscript_settings_v1;
	assert.equal(typeof namespace[profileSettingsKey], "string", "original profile settings must remain a JSON string in the upstream namespace");
	assert.equal(typeof namespace[globalMetaKey], "string");
	return { extensionSettings, namespace, profile: JSON.parse(namespace[profileSettingsKey]), globalMeta: JSON.parse(namespace[globalMetaKey]) };
}

test("database sync removes stale chat metadata without detaching upstream references", async () => {
 const initial = { chatMetadata: { retained: { value: "old" }, stale: { value: "must disappear" } } };
 const f = hostFixture("?view=manager", { context: initial, contextResponse: () => ({ chatMetadata: { retained: { value: "new" } } }) }); await settled(f);
 const context = f.window.SillyTavern.getContext(), metadata = context.chatMetadata;
 await f.window.LiyuanDatabasePluginHost.sync();
 assert.equal(context.chatMetadata, metadata, "the original plugin may retain its metadata object");
 assert.deepEqual(JSON.parse(JSON.stringify(metadata.retained)), { value: "new" });
 assert.equal(metadata.stale, undefined, "keys removed by the authoritative context must not survive locally");
 await context.saveChat();
 assert.deepEqual(JSON.parse(JSON.stringify(f.savedStates.at(-1).chatMetadata.retained)), { value: "new" });
 assert.equal(f.savedStates.at(-1).chatMetadata.stale, undefined, "a later save must not resurrect deleted metadata");
});

test("database sync refuses a new branch even when session/card scope is unchanged", async () => {
 let sourceEntryId = "a-1";
 const f = hostFixture("?view=manager", { contextResponse: () => ({ sourceEntryId }) }); await settled(f);
 sourceEntryId = "branch-b-reply";
 await assert.rejects(f.window.LiyuanDatabasePluginHost.sync(), /分支需重新载入/);
 assert.equal(JSON.stringify(f.window.LiyuanDatabasePluginHost.binding()), JSON.stringify({ scopeKey: "fixture-scope", sourceEntryId: "a-1" }), "old manager must not silently adopt another branch");
});

test("database host: managed 3.8 fill/recall presets bootstrap original settings with host-managed credentials", async () => {
	// These synthetic credential sentinels must never be copied into upstream settings.
	const fixture = hostFixture("", { context: { managedModels: managedModelsFixture } });
	await settled(fixture);
	assert.equal(fixture.window.LiyuanDatabasePluginHost.ready(), true);
	const { namespace, profile, globalMeta } = upstreamSettings(fixture);
	const [fill, recall] = managedModelsFixture.presets;
	assert.equal(profile.tableApiPreset, fill.name);
	assert.equal(profile.defaultApiPresetName, fill.name);
	assert.equal(profile.apiPresetBindingsByChat["fixture-session"].presetName, fill.name);
	assert.equal(profile.__liyuanModelBindingRevision, managedModelsFixture.revision);
	assert.equal(globalMeta.vectorMemoryConfigGlobal.keywordApiPreset, recall.name);
	assert.equal(profile.apiMode, "custom");
	assert.deepEqual(profile.apiPresets.map((p: any) => p.name), [fill.name, recall.name]);
	for (const expected of managedModelsFixture.presets) {
		const preset = profile.apiPresets.find((p: any) => p.name === expected.name);
		assert.equal(preset.apiMode, "custom");
		assert.deepEqual(preset.apiConfig, { url: new URL(expected.url, "https://synthetic.invalid").href, apiKey: "host-managed", model: expected.model, max_tokens: expected.maxTokens, maxTokens: expected.maxTokens, temperature: 1 });
		assert.ok(!JSON.stringify(namespace).includes(expected.apiKey), "synthetic server credentials must not reach profile/global settings");
	}
	assert.deepEqual(profile.apiConfig, profile.apiPresets[0].apiConfig);
});

test("database host: rebootstrap with the same managed revision preserves later manual preset choices", async () => {
	const first = hostFixture("", { context: { managedModels: managedModelsFixture } });
	await settled(first);
	assert.equal(first.window.LiyuanDatabasePluginHost.ready(), true);
	const { profile, globalMeta, extensionSettings: initialSettings } = upstreamSettings(first);
	assert.equal(profile.__liyuanModelBindingRevision, managedModelsFixture.revision);
	const manualFill = { name: "合成手选填表", apiMode: "custom", apiConfig: { url: "https://manual-fill.synthetic.invalid/v1", apiKey: "host-managed", model: "fixture-manual-fill", maxTokens: 4096, temperature: 0.5 }, tavernProfile: "" };
	const manualRecall = { ...manualFill, name: "合成手选召回", apiConfig: { ...manualFill.apiConfig, url: "https://manual-recall.synthetic.invalid/v1", model: "fixture-manual-recall" } };
	profile.apiPresets.push(manualFill, manualRecall);
	profile.tableApiPreset = manualFill.name;
	profile.defaultApiPresetName = manualFill.name;
	profile.apiConfig = manualFill.apiConfig;
	profile.tableApiPresetOverridesByName = { "合成表": manualFill.name };
	profile.apiPresetBindingsByChat["fixture-session"] = { presetName: manualFill.name, updatedAt: 1234 };
	globalMeta.vectorMemoryConfigGlobal.keywordApiPreset = manualRecall.name;
	const extensionSettings = JSON.parse(JSON.stringify(initialSettings));
	const namespace = extensionSettings.__userscripts.shujuku_v120__userscript_settings_v1;
	namespace[profileSettingsKey] = JSON.stringify(profile);
	namespace[globalMetaKey] = JSON.stringify(globalMeta);

	const rebooted = hostFixture("", { context: { managedModels: managedModelsFixture, extensionSettings } });
	await settled(rebooted);
	assert.equal(rebooted.window.LiyuanDatabasePluginHost.ready(), true);
	const next = upstreamSettings(rebooted);
	assert.equal(next.profile.__liyuanModelBindingRevision, managedModelsFixture.revision);
	assert.equal(next.profile.tableApiPreset, manualFill.name);
	assert.equal(next.profile.defaultApiPresetName, manualFill.name);
	assert.equal(next.globalMeta.vectorMemoryConfigGlobal.keywordApiPreset, manualRecall.name);
	assert.deepEqual(next.profile.apiConfig, manualFill.apiConfig);
	assert.deepEqual(next.profile.tableApiPresetOverridesByName, profile.tableApiPresetOverridesByName);
	assert.deepEqual(next.profile.apiPresetBindingsByChat, profile.apiPresetBindingsByChat);
	for (const preset of [manualFill, manualRecall]) assert.deepEqual(next.profile.apiPresets.find((p: any) => p.name === preset.name), preset);
	for (const managed of managedModelsFixture.presets) {
		const matches = next.profile.apiPresets.filter((p: any) => p.name === managed.name);
		assert.equal(matches.length, 1, "rebootstrap must update, not duplicate, each managed preset");
		assert.equal(matches[0].apiConfig.apiKey, "host-managed");
		assert.ok(!JSON.stringify(next.namespace).includes(managed.apiKey));
	}
});


test("database host: captures original interceptor writeback byte-for-byte, without rewriting the canonical user message", async () => {
 const original = "继续找回那把钥匙。";
 const native = "以下是用户的本轮输入：\n<本轮用户输入>\n" + original + "\n</本轮用户输入>\n\n<recall>\nnow =\nAM0001 | 3m\n</recall>";
 const f = hostFixture("", {context:{chat:[{is_user:true,mes:original,__liyuanEntryId:"u-1"}]},intercept:params=>({...params,user_input:native})});
 await settled(f);
 const result = await f.window.LiyuanDatabasePluginHost.before(original);
 assert.equal(result.userInput, native);
 assert.equal(f.window.SillyTavern.getContext().chat.at(-1).mes, original);
 assert.equal(f.elements.get("send_textarea").value, "");
 assert.ok(!result.userInput.includes("【剧情记忆】"));
});

test("database host: no intercepted host generation means no fake recall success or fallback author input", async () => {
 const f = hostFixture("", {suppressGeneration:true}); await settled(f);
 await assert.rejects(f.window.LiyuanDatabasePluginHost.before("合成输入"), /未完成发送前处理/);
 assert.equal(f.elements.get("send_textarea").value, "");
});

test("database host: one-time migration restores native recall and recall preset, then preserves user switches", async () => {
 const first = hostFixture("", {context:{managedModels:managedModelsFixture}}); await settled(first);
 const settings = upstreamSettings(first);
 assert.equal(settings.globalMeta.plotEnabledGlobal, true);
 assert.equal(settings.profile.plotApiPreset, managedModelsFixture.presets.find(p=>p.purpose==='recall')!.name);
 assert.equal(settings.profile.__liyuanNativeRecallBridgeVersion, 1);
 settings.globalMeta.plotEnabledGlobal = false;
 settings.profile.plotApiPreset = "手动召回预设";
 settings.namespace[globalMetaKey] = JSON.stringify(settings.globalMeta);
 settings.namespace[profileSettingsKey] = JSON.stringify(settings.profile);
 const next = hostFixture("", {context:{managedModels:managedModelsFixture,extensionSettings:settings.extensionSettings}}); await settled(next);
 const saved = upstreamSettings(next);
 assert.equal(saved.globalMeta.plotEnabledGlobal, false);
 assert.equal(saved.profile.plotApiPreset, "手动召回预设");
});


test("database host: character bindings do not absorb global books, but explicit book reads remain available", async () => {
 const f=hostFixture("",{context:{characterBookNames:["CardBook","MissingBook"],globalBookNames:["GlobalBook"],readonlyBooks:{CardBook:{entries:[{uid:0,content:"合成卡",prevent_recursion:true}]},GlobalBook:{entries:[{uid:0,content:"合成全局"}]}}}});
 await settled(f);const api=f.window.TavernHelper;
 assert.deepEqual(JSON.parse(JSON.stringify(await api.getCharWorldbookNames("current"))),{primary:"Fixture",additional:["CardBook"]});
 assert.deepEqual(JSON.parse(JSON.stringify(api.getGlobalWorldbookNames())),["GlobalBook"]);
 assert.deepEqual(JSON.parse(JSON.stringify(await api.getWorldbookNames())),["Fixture","CardBook","GlobalBook"]);
 assert.equal((await api.getLorebookEntries("CardBook"))[0].prevent_recursion,true);
 assert.equal((await api.getLorebookEntries("GlobalBook"))[0].content,"合成全局");
 await assert.rejects(api.setLorebookEntries("GlobalBook",[{uid:0,content:"不得写入"}]),/只读/);
 const legacy=hostFixture("",{context:{readonlyBooks:{GlobalBook:{entries:[]}}}});await settled(legacy);
 assert.deepEqual(JSON.parse(JSON.stringify(await legacy.window.TavernHelper.getCharWorldbookNames())).additional,[],"unclassified books must not be silently bound");
});

test("database host: retry exhaustion reports the concrete model error, and a later successful turn does not inherit it", async () => {
 let failing=true;
 const f=hostFixture("",{modelError:"数据库模型材料过大",generateHook:async(params,w,capture)=>{if(failing){await w.fetch("/api/backends/chat-completions/generate",{method:"POST",body:"{}"});return;}return capture(params);}});
 await settled(f);
 await assert.rejects(f.window.LiyuanDatabasePluginHost.before("合成输入"),/未完成发送前处理.*原因：数据库模型材料过大/);
 assert.equal(f.elements.get("send_textarea").value,"");
 assert.deepEqual(JSON.parse(JSON.stringify(f.window.LiyuanDatabasePluginHost.errors())),["数据库模型材料过大"]);
 failing=false;const result=await f.window.LiyuanDatabasePluginHost.before("合成第二拍");
 assert.equal(result.userInput,"合成第二拍");assert.equal(result.errors.length,0);
});


test("database host: generateRaw task errors survive upstream retry handling without a fake author handoff", async () => {
 const f=hostFixture("",{modelError:"合成召回模型鉴权不可用",generateHook:async(_params,w)=>{try{await w.TavernHelper.generateRaw({ordered_prompts:[{role:"user",content:"合成资料"}]});}catch{} }});
 await settled(f);
 await assert.rejects(f.window.LiyuanDatabasePluginHost.before("合成输入"),/未完成发送前处理.*原因：合成召回模型鉴权不可用/);
 assert.equal(f.elements.get("send_textarea").value,"");
});

test("database host: original realtime tables have a direct entry and explicit refresh", async () => {
 const f=hostFixture("?view=manager&panel=tables");await settled(f);
 assert.equal(f.window.tableOpens,1);
 await f.window.LiyuanDatabasePluginHost.openTables();assert.equal(f.window.tableOpens,2);
 await f.window.LiyuanDatabasePluginHost.refreshTables();assert.equal(f.window.tableRefreshes,1);
 assert.match(f.elements.get("host-feedback").textContent,/实时表格已刷新/);
});

test("database host: failed persistence is visible to flush but does not poison subsequent saves", async () => {
 let fail=true,calls=0;
 const f=hostFixture("?view=manager",{stateSave:async()=>{calls++;return {ok:!fail,json:async()=>fail?{error:"合成保存冲突"}:{globalRevision:2}};}});await settled(f);
 const ctx=f.window.SillyTavern.getContext();
 await assert.rejects(ctx.saveChat(),/合成保存冲突/);
 assert.match(f.elements.get("host-feedback").textContent,/保存失败/);
 await assert.rejects(f.window.LiyuanDatabasePluginHost.flush(),/合成保存冲突/);
 fail=false;await ctx.saveChat();await f.window.LiyuanDatabasePluginHost.flush();
 assert.equal(calls,2);assert.match(f.elements.get("host-feedback").textContent,/已保存.*版本 2/);
});

test("database host: repeated identical upstream saves share the durable revision without extra snapshots", async () => {
 let calls=0;const f=hostFixture("?view=manager",{stateSave:async()=>{calls++;return {ok:true,json:async()=>({globalRevision:calls})};}});await settled(f);
 const ctx=f.window.SillyTavern.getContext();await Promise.all([ctx.saveChat(),ctx.saveChat(),ctx.saveChat()]);
 assert.equal(calls,1);ctx.chatMetadata.synthetic="changed";await ctx.saveChat();assert.equal(calls,2);
});

test("database host: background execution boundaries propagate saves even when upstream catches persistence errors", async () => {
 for(const boundary of ["before","after-update","after-worldbook","rpc"]){
  const f=hostFixture("",{stateSave:async()=>({ok:false,json:async()=>({error:"合成后台持久化失败"})})});await settled(f);
  const ctx=f.window.SillyTavern.getContext(),api=f.window.AutoCardUpdaterAPI;
  const caughtSave=async()=>{try{await ctx.saveChat();}catch{}return {success:true};};
  api.exportTableAsJson=()=>({sheet_fixture:{}});
  if(boundary==="before"){
   const generate=f.window.TavernHelper.generate;
   f.window.TavernHelper.generate=async(params:any)=>{await generate(params);await caughtSave();return "";};
   await assert.rejects(f.window.LiyuanDatabasePluginHost.before("合成输入"),/合成后台持久化失败/);
  }else if(boundary==="rpc"){
   api.setZeroTkOccupyMode=caughtSave;
   await assert.rejects(f.window.LiyuanDatabasePluginHost.rpc("setZeroTkOccupyMode",[true]),/合成后台持久化失败/);
  }else{
    api.getRecentPerformanceSpans=()=>[];
    ctx.eventSource.on('GENERATION_ENDED',()=>f.window.setTimeout(boundary==="after-update"?caughtSave:async()=>{},500));
    if(boundary==="after-update")api.triggerUpdate=()=>{throw new Error('legacy standard fill must not run');};
   else api.syncWorldbookEntries=caughtSave;
   await assert.rejects(f.window.LiyuanDatabasePluginHost.after(),/合成后台持久化失败/);
  }
 }
});

test("database host: missing original refresh API never reports realtime tables refreshed", async () => {
 const f=hostFixture("?view=manager");await settled(f);
 delete f.window.AutoCardUpdaterV2API.refreshVisualizer;
 await assert.rejects(f.window.LiyuanDatabasePluginHost.refreshTables(),/刷新接口不可用/);
 assert.equal(f.messages.some(m=>m.type==="liyuan-database-feedback"&&m.message?.includes("实时表格已刷新")),false);
});

test("database host: after joins native grouped event and rejects failed groups without legacy standard fill", async () => {
 const f=hostFixture('');await settled(f);
 const api=f.window.AutoCardUpdaterAPI,ctx=f.window.SillyTavern.getContext();
 api.exportTableAsJson=()=>({sheet_fixture:{}});
 api.triggerUpdate=()=>{throw new Error('legacy standard fill excludes chronicles');};
 const spans:any[]=[];api.getRecentPerformanceSpans=()=>spans;
 let release!:()=>void;const work=new Promise<void>(yes=>{release=yes;});let done=false;
 ctx.eventSource.on('GENERATION_ENDED',(index:number)=>{assert.equal(index,-1);f.window.setTimeout(async()=>{await work;spans.push({id:'native-1',name:'auto-update-execute',metrics:{success:false}});done=true;},500);});
 const after=f.window.LiyuanDatabasePluginHost.after();
 await new Promise(r=>setTimeout(r,10));assert.equal(done,false);
 release();await assert.rejects(after,/自动分组填表失败/);assert.equal(done,true);
});
