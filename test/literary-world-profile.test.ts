import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
	WORLD_MANIFEST_ENTRY_TYPE,
	buildWorldProfilePrompt,
	defaultCardWorldProfile,
	loadCardWorldProfile,
	manifestFromProfile,
	normalizeCardWorldProfile,
	profileNeedsAnalysis,
	saveCardWorldProfile,
	worldManifestFromBranch,
	worldProfilePath,
} from "../src/stage/literary-world-profile.ts";

const mkcwd = () => mkdtempSync(join(tmpdir(), "liyuan-world-profile-"));

test("world profile: aggregate lore budget preserves only delivered source ids and source material bytes", async () => {
	const { normalizeCard } = await import("../src/card.ts");
	const card = normalizeCard({name:"Synthetic profile", first_mes:"Greeting".repeat(4000)});
	const entries = Array.from({length:40}, (_, index) => ({source:`synthetic:${index}`, comment:`Entry ${index}`, keys:[], enabled:true, content:`Source ${index}: ` + "资料".repeat(2000)})) as import("../src/types.ts").LorebookEntry[];
	entries.unshift({...entries[0],source:"disabled",enabled:false},{...entries[0],source:"blank",content:"  "});
	const before = JSON.stringify({card,entries});
	const payload = JSON.parse(buildWorldProfilePrompt({skillBody:"Synthetic rules",card,entries,preset:null}).userText);
	assert.equal(payload.world_lore.reduce((sum:number, entry:any) => sum + entry.content.length,0),24_000);
	assert.deepEqual(payload.world_lore.map((entry:any) => entry.source),Array.from({length:12},(_,index)=>`synthetic:${index}`));
	for (const entry of payload.world_lore) {
		assert.ok(entry.content.startsWith(`Source ${entry.source.split(":")[1]}: `));
		assert.ok(entry.content.length <= 2000);
	}
	assert.equal(payload.selected_greeting,card.firstMes);
	assert.equal(JSON.stringify({card,entries}),before);
});

test("world profile: aggregate lore budget clips final partial entry without advertising omitted sources", async () => {
	const { normalizeCard } = await import("../src/card.ts");
	const entries = Array.from({length:40}, (_, index) => ({source:`partial:${index}`, comment:"", keys:[], enabled:true, content:"x".repeat(index === 0 ? 1501 : 2001)})) as import("../src/types.ts").LorebookEntry[];
	const payload = JSON.parse(buildWorldProfilePrompt({skillBody:"Synthetic",card:normalizeCard({name:"Synthetic"}),entries,preset:null}).userText);
	assert.equal(payload.world_lore.length,13);
	assert.equal(payload.world_lore.at(-1).source,"partial:12");
	assert.equal(payload.world_lore.at(-1).content.length,499);
	assert.equal(payload.world_lore.reduce((sum:number, entry:any)=>sum+entry.content.length,0),24_000);
});

test("world profile：按角色卡独立持久化，稳定画像不因素材变化自动重建", () => {
	const cwd = mkcwd();
	try {
		const base = defaultCardWorldProfile(cwd, "cards/school.png", "校园卡", "source-a");
		const profile = normalizeCardWorldProfile({
			status: "stable",
			digest: "校园制度与双人关系并行",
			primaryScale: "institutional",
			defaultTimeStep: "hour",
			worldActivity: "low",
			modules: [{ id: "institution-calendar", name: "校园制度", mode: "active", cadence: "on-time-advance", confidence: 0.95, reason: "世界书含校历" }],
			userRequirements: ["不引入战争模块"],
		}, base);
		assert.ok(profile);
		saveCardWorldProfile(cwd, "cards/school.png", profile);
		assert.equal(existsSync(worldProfilePath(cwd, "cards/school.png")), true);
		const loaded = loadCardWorldProfile(cwd, "cards/school.png", "校园卡", "source-b");
		assert.equal(loaded?.digest, "校园制度与双人关系并行");
		assert.deepEqual(loaded?.userRequirements, ["不引入战争模块"]);
		assert.equal(profileNeedsAnalysis(loaded, "source-b", 100), false, "稳定画像只在用户主动要求时继续优化");
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("world profile：草稿画像在角色卡素材变化后要求重新分析", () => {
	const cwd = mkcwd();
	try {
		const base = defaultCardWorldProfile(cwd, "cards/xianxia.json", "修仙卡", "old");
		const profile = normalizeCardWorldProfile({ digest: "修仙适配", modules: [] }, base);
		assert.ok(profile);
		assert.equal(profileNeedsAnalysis(profile, "old", 7), false);
		assert.equal(profileNeedsAnalysis(profile, "old", 8), true, "未稳定画像每 8 拍结合实弹继续优化");
		assert.equal(profileNeedsAnalysis(profile, "new"), true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("world profile：Manifest 随分支取最近版本，停用模块不进入运行清单", () => {
	const cwd = mkcwd();
	try {
		const base = defaultCardWorldProfile(cwd, "cards/hybrid.png", "混合卡", "x");
		const profile = normalizeCardWorldProfile({
			digest: "校园修仙混合",
			modules: [
				{ id: "institution-calendar", name: "校园制度", mode: "active", cadence: "on-time-advance", confidence: 1 },
				{ id: "cultivation-system", name: "修炼体系", mode: "observe", cadence: "on-trigger", confidence: 0.6 },
			],
			disabledModules: ["cultivation-system"],
		}, base);
		assert.ok(profile);
		const manifest = manifestFromProfile(profile);
		assert.deepEqual(manifest.modules.map((item) => item.id), ["institution-calendar"]);
		const branch = [
			{ type: "custom", customType: WORLD_MANIFEST_ENTRY_TYPE, data: { ...manifest, profileRevision: 1 } },
			{ type: "custom", customType: WORLD_MANIFEST_ENTRY_TYPE, data: manifest },
		];
		assert.equal(worldManifestFromBranch(branch, profile.cardKey)?.profileRevision, profile.revision);
		assert.equal(worldManifestFromBranch(branch, "other"), null);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("world profile：用户长期要求和实弹优化记录在重分析时可由旧画像继承", () => {
	const cwd = mkcwd();
	try {
		const base = defaultCardWorldProfile(cwd, "cards/intimate.png", "单角色卡", "a");
		const old = normalizeCardWorldProfile({
			digest: "二人戏",
			userRequirements: ["不引入第三者"],
			optimizationNotes: ["外部事件过多会破坏节奏"],
		}, base);
		assert.ok(old);
		const next = normalizeCardWorldProfile({ digest: "继续优化", modules: [] }, old, { preserveStatus: true, sourceFingerprint: "b" });
		assert.ok(next);
		assert.deepEqual(next.userRequirements, ["不引入第三者"]);
		assert.deepEqual(next.optimizationNotes, ["外部事件过多会破坏节奏"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("world profile：模型不能删除用户已经钉死的长期要求", () => {
	const cwd = mkcwd();
	try {
		const base = defaultCardWorldProfile(cwd, "cards/user-policy.png", "用户规则卡", "a");
		const old = normalizeCardWorldProfile({ digest: "初始", userRequirements: ["不替用户接受任务", "不引入第三者"] }, base)!;
		const next = normalizeCardWorldProfile({ digest: "模型试图只保留一条", userRequirements: ["不引入第三者"] }, old)!;
		assert.deepEqual(next.userRequirements, ["不替用户接受任务", "不引入第三者"]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("world profile：不存在的模块 Skill 包确定性回落到 kind 包", () => {
	const base = defaultCardWorldProfile("/tmp", "card.json", "卡", "x");
	const profile = normalizeCardWorldProfile({ digest: "校园", modules: [{ id: "economy-market", name: "经济", mode: "active", cadence: "on-trigger", kind: "rules", skillPack: "economy" }] }, base)!;
	assert.equal(profile.modules[0]?.skillPack, "rules");
});

test("world profile：完整卡内容修订不丢显式继承的画像身份，素材指纹不被伪造刷新", async () => {
	const { normalizeCard } = await import("../src/card.ts");
	const { carryCardWorldProfile, worldCardKey, worldProfileFingerprint } = await import("../src/stage/literary-world-profile.ts");
	const cwd = mkcwd();
	try {
		const before = normalizeCard({ name: "合成卡", description: "旧资料", character_book: { entries: [{ content: "旧规则", enabled: true }] } });
		const after = normalizeCard({ name: "合成卡", description: "新资料", character_book: { entries: [{ content: "新规则", enabled: false }] } });
		const old = defaultCardWorldProfile(cwd, "card.json", before.name, "old-fingerprint", before);
		old.updatedAt = "2026-01-01T00:00:00.000Z"; old.userRequirements = ["保留我的要求"];
		saveCardWorldProfile(cwd, "card.json", old, before);
		carryCardWorldProfile(cwd, "card.json", before, after);
		const loaded = loadCardWorldProfile(cwd, "card.json", after.name, "new-fingerprint", after)!;
		assert.ok(loaded); assert.equal(loaded.cardKey, old.cardKey);
		assert.notEqual(worldCardKey(cwd, "card.json", after), old.cardKey);
		assert.equal(loaded.sourceFingerprint, "old-fingerprint"); assert.equal(loaded.updatedAt, old.updatedAt);
		assert.deepEqual(loaded.userRequirements, old.userRequirements);
		assert.equal(profileNeedsAnalysis(loaded, "new-fingerprint"), true);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("world profile：旧画像只沿明确同源卡的当前祖先找回，不按同名跨卡/兄弟分支扫描", async () => {
	const { normalizeCard } = await import("../src/card.ts");
	const { worldCardKey } = await import("../src/stage/literary-world-profile.ts");
	const cwd = mkcwd();
	try {
		const oldCard = normalizeCard({ name: "同名合成卡", description: "旧设定" });
		const card = normalizeCard({ name: "同名合成卡", description: "新设定" });
		const old = defaultCardWorldProfile(cwd, "card.json", oldCard.name, "old", oldCard); old.revision = 3;
		saveCardWorldProfile(cwd, "card.json", old, oldCard);
		const branch = [{ type: "custom", customType: "rp-card", data: { card: "card.json" } }, { type: "custom", customType: WORLD_MANIFEST_ENTRY_TYPE, data: manifestFromProfile(old) }];
		assert.equal(loadCardWorldProfile(cwd, "card.json", card.name, "new", card), null);
		const restored = loadCardWorldProfile(cwd, "card.json", card.name, "new", card, branch)!;
		assert.equal(restored?.cardKey, old.cardKey); assert.equal(restored.revision, 3);
		assert.equal(existsSync(worldProfilePath(cwd, "card.json", card)), false, "read does not migrate or overwrite disk");
		assert.equal(loadCardWorldProfile(cwd, "other.json", card.name, "new", card, branch), null);
		assert.equal(loadCardWorldProfile(cwd, "card.json", card.name, "new", card, [...branch, { type: "custom", customType: "rp-card", data: { card: "other.json" } }]), null);
		assert.equal(loadCardWorldProfile(cwd, "card.json", card.name, "new", card, branch.slice(0, 1)), null, "a sibling's manifest is unavailable");
		saveCardWorldProfile(cwd, "card.json", restored, card);
		assert.equal(loadCardWorldProfile(cwd, "card.json", card.name, "new", card)?.cardKey, old.cardKey, "new sessions reuse the explicitly saved content binding");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("world profile：拒绝无画像的JSON对象，手动与自动统一有限非流式重试并记录实弹拍数", async () => {
	const { normalizeCard } = await import("../src/card.ts");
	const { analyzeCardWorldProfile } = await import("../src/stage/literary-world-profile.ts");
	const card = normalizeCard({ name: "合成卡" });
	const base = defaultCardWorldProfile("/tmp", "card.json", card.name);
	assert.equal(normalizeCardWorldProfile({}, base), null);
	assert.equal(normalizeCardWorldProfile({ summary: "并非画像" }, base), null);
	const attempts: boolean[] = [];
	const result = await analyzeCardWorldProfile({ cwd: "/tmp", cardPath: "card.json", card, entries: [], preset: null, skillBody: "合成规则", completedTurns: 6,
		run: async (_sp, _ut, retry) => { attempts.push(retry); return retry ? JSON.stringify({ digest: "合成世界适配", modules: [] }) : "```"; } });
	assert.deepEqual(attempts, [false, true]); assert.equal(result.analyzedTurns, 6); assert.equal(result.digest, "合成世界适配");
	let calls = 0;
	await assert.rejects(analyzeCardWorldProfile({ cwd: "/tmp", cardPath: "card.json", card, entries: [], preset: null, skillBody: "合成规则", completedTurns: 0, run: async () => { calls++; return "{}"; } }), /未覆盖已有画像/);
	assert.equal(calls, 2);
});

test("world profile：手动/自动共用分析租约，失败后释放，不会重叠消耗模型",async()=>{
 const {normalizeCard}=await import("../src/card.ts");
 const {analyzeCardWorldProfile,worldProfileAnalysisRunning}=await import("../src/stage/literary-world-profile.ts");
 const cwd=mkcwd(),card=normalizeCard({name:"租约合成卡"});let release!:()=>void;
 const gate=new Promise<void>(r=>{release=r});
 const input={cwd,cardPath:"card.json",card,entries:[],preset:null,skillBody:"合成协议",completedTurns:0,run:async()=>{await gate;return JSON.stringify({digest:"合成适配",modules:[]})}};
 try{
  const first=analyzeCardWorldProfile(input);assert.equal(worldProfileAnalysisRunning(cwd,"card.json",card),true);
  await assert.rejects(analyzeCardWorldProfile(input),/正在分析/);release();await first;assert.equal(worldProfileAnalysisRunning(cwd,"card.json",card),false);
 }finally{release?.();rmSync(cwd,{recursive:true,force:true})}
});

test("world profile：旧版无contentKey画像被采用后仍可再次找到，不引用不存在的新内容路径",async()=>{
 const {normalizeCard}=await import("../src/card.ts");
 const {writeFileSync,readFileSync}=await import("node:fs");
 const cwd=mkcwd();try{
  const before=normalizeCard({name:"旧版合成卡",description:"旧内容"}),after=normalizeCard({name:"旧版合成卡",description:"新内容"});
  const old=defaultCardWorldProfile(cwd,"card.json",before.name,"old",before);saveCardWorldProfile(cwd,"card.json",old,before);
  const path=worldProfilePath(cwd,"card.json",before),raw=JSON.parse(readFileSync(path,"utf8"));delete raw.contentKey;writeFileSync(path,JSON.stringify(raw));
  const branch=[{type:"custom",customType:"rp-card",data:{card:"card.json"}},{type:"custom",customType:WORLD_MANIFEST_ENTRY_TYPE,data:manifestFromProfile({...old,contentKey:undefined})}];
  const first=loadCardWorldProfile(cwd,"card.json",after.name,"new",after,branch)!;assert.equal(first.contentKey,old.cardKey);
  branch.push({type:"custom",customType:WORLD_MANIFEST_ENTRY_TYPE,data:manifestFromProfile(first)});
  const second=loadCardWorldProfile(cwd,"card.json",after.name,"new",after,branch);assert.equal(second?.cardKey,old.cardKey);
  assert.equal(existsSync(worldProfilePath(cwd,"card.json",after)),false);
 }finally{rmSync(cwd,{recursive:true,force:true})}
});

test("world profile：模型不能自定版本、实弹拍数或把画像冻结为稳定",async()=>{
 const{normalizeCard}=await import("../src/card.ts");const{analyzeCardWorldProfile}=await import("../src/stage/literary-world-profile.ts");
 const card=normalizeCard({name:"版本合成卡"});
 const profile=await analyzeCardWorldProfile({cwd:"/tmp",cardPath:"card.json",card,entries:[],preset:null,skillBody:"合成",completedTurns:2,run:async()=>JSON.stringify({digest:"合成适配",modules:[],revision:999,analyzedTurns:999,status:"stable"})});
 assert.equal(profile.revision,1);assert.equal(profile.status,"draft");assert.equal(profile.analyzedTurns,2);
});

test("world profile：流式连接失败仅在同岗位重试一次非流式，鉴权/额度失败不重复付费",async()=>{
 const{normalizeCard}=await import("../src/card.ts");const{analyzeCardWorldProfile}=await import("../src/stage/literary-world-profile.ts");const card=normalizeCard({name:"传输合成卡"});
 const attempts:boolean[]=[];
 const input={cwd:"/tmp",cardPath:"card.json",card,entries:[],preset:null,skillBody:"合成协议",completedTurns:3};
 const result=await analyzeCardWorldProfile({...input,run:async(_sp,_ut,nonStreaming)=>{attempts.push(nonStreaming);return nonStreaming?JSON.stringify({digest:"同模型非流式画像",modules:[]}):{error:"Connection error."}}});
 assert.deepEqual(attempts,[false,true]);assert.equal(result.analyzedTurns,3);assert.equal(result.digest,"同模型非流式画像");
 const timeoutAttempts:boolean[]=[];await analyzeCardWorldProfile({...input,run:async(_sp,_ut,nonStreaming)=>{timeoutAttempts.push(nonStreaming);return nonStreaming?JSON.stringify({digest:"超时后非流式适配",modules:[]}):{error:"524 Proxy Read Timeout"}}});assert.deepEqual(timeoutAttempts,[false,true]);
 for(const error of ['401 invalid API key','403 insufficient_user_quota','404 model not found']){
  let count=0;await assert.rejects(analyzeCardWorldProfile({...input,run:async()=>{count++;return{error}}}),/画像分析失败/);assert.equal(count,1,error);
 }
});
