import assert from "node:assert/strict";
import test from "node:test";

import { defaultLiteraryEcologyState, normalizeLiteraryEcologyState } from "../src/stage/literary-ecology.ts";
import { defaultModularWorldState } from "../src/stage/literary-world-modular.ts";
import { ecologySignalsForWorld, worldSignalsForEcology } from "../src/stage/literary-world-signals.ts";
import { buildWorldProposalPrompt, normalizeBeatFactEnvelope } from "../src/stage/literary-world-transition.ts";
import type { WorldState } from "../src/types.ts";

test("世界到生态信号携带已提交日历约束且过滤秘密", () => {
	const world = defaultModularWorldState();
	world.modules["institution-calendar"] = { id: "institution-calendar", kind: "institution", revision: 1, summary: "校历", records: [
		{ id: "open", facet: "event", label: "开放日", status: "已公布", summary: "礼堂开放", visibility: "public", attributes: { date: "2015-04-08", time: "09:00", location: "礼堂" }, originRefs: [], updatedRound: 1 },
		{ id: "secret", facet: "event", label: "秘密会议", status: "筹备中", summary: "校方密谈", visibility: "secret", attributes: { date: "2015-04-09" }, originRefs: [], updatedRound: 1 },
	] };
	const signals = worldSignalsForEcology(world);
	assert.equal(signals.length, 1);
	assert.match(signals[0]?.summary ?? "", /2015-04-08.*09:00.*礼堂/);
	assert.doesNotMatch(JSON.stringify(signals), /秘密会议|2015-04-09/);
});

test("生态到世界信号只暴露秘密事件的公开痕迹", () => {
	const ecology = normalizeLiteraryEcologyState({ occurrences: [{
		id: "warehouse-private-id", name: "内部密谋名称", status: "active", patternKey: "warehouse", visibility: "secret", location: "秘密据点",
		development: "组织正在秘密转移物资", publicSurface: { publicity: "trace", trace: "夜间灯光和车辙异常", summary: "不应出现的幕后原因" },
	}] }, { ...defaultLiteraryEcologyState(), round: 2 })!;
	const signals = ecologySignalsForWorld(ecology);
	assert.equal(signals[0]?.kind, "public-trace");
	assert.match(signals[0]?.summary ?? "", /夜间灯光和车辙异常/);
	assert.doesNotMatch(signals[0]?.summary ?? "", /内部密谋名称|秘密据点|warehouse-private-id|秘密转移物资|幕后原因/);
	assert.deepEqual(signals[0]?.ref, { domain: "ecology", recordId: "warehouse-private-id" });
	assert.equal(signals[0]?.sourceRound, 2);
	assert.equal(signals[0]?.visibility, "public");
});

test("没有公开传播面的秘密生态事件不进入世界信号", () => {
	const ecology = normalizeLiteraryEcologyState({ occurrences: [{ id: "secret", name: "秘密转移", status: "active", patternKey: "secret", visibility: "secret", development: "幕后主使和藏匿地点" }] }, defaultLiteraryEcologyState())!;
	assert.deepEqual(ecologySignalsForWorld(ecology), []);
});

const ecologyWith = (occurrences: unknown[]) => normalizeLiteraryEcologyState({ occurrences }, { ...defaultLiteraryEcologyState(), round: 7 })!;
const hiddenEvent = (id: string, extra: Record<string, unknown> = {}) => ({
	id, patternKey: id, name: "内部密谋名称", location: "秘密据点", cause: "幕后原因", causedBy: ["private-cause-id"],
	development: "隐秘进展", status: "active", visibility: "secret", ...extra,
});

test("公开版本缺标题时不回退内部字段，并保留传闻与传播边界", () => {
	for (const claimStatus of ["fact", "mixed", "rumor"]) {
		const ecology = ecologyWith([hiddenEvent("private-record-id", { publicSurface: {
			publicity: "public", headline: "", summary: "有人声称货运暂停", result: "码头排队延长",
			claimStatus, sourceType: "unofficial", audience: ["码头工人"], scope: "港区",
		} })]);
		const [signal] = ecologySignalsForWorld(ecology);
		assert.ok(signal);
		assert.match(signal.summary, /公开消息.*有人声称货运暂停.*码头排队延长.*码头工人.*港区/);
		assert.ok(signal.summary.includes(`说法标记：${claimStatus}；unofficial`));
		assert.doesNotMatch(signal.summary, /内部密谋名称|秘密据点|隐秘进展|幕后原因|private-record-id|private-cause-id/);
		assert.deepEqual(signal.ref, { domain: "ecology", recordId: "private-record-id" });
	}
});

test("显式私有面和空公开面不能回退内部事件内容", () => {
	const occurrences = ["secret", "public", "discoverable"].flatMap(visibility => [
		hiddenEvent(`${visibility}-private`, { visibility, publicSurface: { publicity: "private" } }),
		hiddenEvent(`${visibility}-trace`, { visibility, publicSurface: { publicity: "trace", trace: "  " } }),
		hiddenEvent(`${visibility}-public`, { visibility, publicSurface: { publicity: "public", headline: "仅标题" } }),
	]);
	assert.deepEqual(ecologySignalsForWorld(ecologyWith(occurrences)), []);
});

test("普通非秘密活动保持可见性、种类、顺序和地点进展", () => {
	const ecology = ecologyWith([
		hiddenEvent("open", { name: "集市", location: "广场", development: "摊位开放", visibility: "public", kind: "ambient", status: "scheduled" }),
		hiddenEvent("lead", { name: "修缮", location: "后巷", development: "搭起脚手架", visibility: "discoverable", kind: "activity" }),
	]);
	assert.deepEqual(ecologySignalsForWorld(ecology), [
		{ source: "ecology", sourceRound: 7, ref: { domain: "ecology", recordId: "open" }, kind: "ambient", visibility: "public", summary: "集市@广场：摊位开放" },
		{ source: "ecology", sourceRound: 7, ref: { domain: "ecology", recordId: "lead" }, kind: "activity", visibility: "discoverable", summary: "修缮@后巷：搭起脚手架" },
	]);
});

test("终态公开结果和痕迹成为后果参考而不暴露秘密或重开事件", () => {
	const ecology = ecologyWith([
		hiddenEvent("rumor-result", { status: "resolved", publicSurface: { publicity: "public", headline: "停运消息", result: "据说渡口继续关闭", claimStatus: "rumor" } }),
		hiddenEvent("expired-trace", { status: "expired", publicSurface: { publicity: "trace", trace: "岸边留下围栏", result: "不应出现的结果" } }),
		hiddenEvent("open-result", { status: "resolved", visibility: "public", name: "集市", location: "广场", development: "散场后道路恢复通行" }),
		hiddenEvent("hidden-result", { status: "resolved" }),
		hiddenEvent("discoverable-result", { status: "expired", visibility: "discoverable" }),
		hiddenEvent("empty-result", { status: "resolved", visibility: "public", development: "" }),
	]);
	const before = structuredClone(ecology);
	const signals = ecologySignalsForWorld(ecology);
	assert.deepEqual(signals.map(signal => signal.ref.recordId), ["rumor-result", "expired-trace", "open-result"]);
	assert.match(signals[0]!.summary, /后果参考［resolved］.*停运消息.*rumor.*据说渡口继续关闭/);
	assert.match(signals[1]!.summary, /后果参考［expired］.*公开痕迹.*岸边留下围栏/);
	assert.equal(signals[1]!.kind, "public-trace");
	assert.match(signals[2]!.summary, /后果参考［resolved］.*集市@广场.*散场后道路恢复通行/);
	assert.doesNotMatch(signals.map(signal => signal.summary).join("\n"), /内部密谋名称|秘密据点|隐秘进展|幕后原因|不应出现的结果|private-cause-id/);
	assert.deepEqual(ecology, before);
});

test("过滤后按原顺序最多二十条，终态不另开无界信号列表", () => {
	const ecology = ecologyWith([
		hiddenEvent("excluded"),
		...Array.from({ length: 24 }, (_, index) => hiddenEvent(`event-${index}`, {
			status: index % 2 ? "resolved" : "active", lastAdvancedRound: 24 - index,
			publicSurface: { publicity: "public", summary: `公开内容${index}`, claimStatus: "mixed" },
		})),
	]);
	const signals = ecologySignalsForWorld(ecology);
	assert.equal(signals.length, 20);
	assert.deepEqual(signals.map(signal => signal.ref.recordId), Array.from({ length: 20 }, (_, index) => `event-${index}`));
	assert.ok(signals.every(signal => signal.sourceRound === 7 && signal.visibility === "public"));
});

test("世界提案收到安全后果与来源引用，信号不成为正文事实证据", () => {
	const ecology = ecologyWith([hiddenEvent("internal-source-id", { status: "resolved", publicSurface: {
		publicity: "public", summary: "传言仓库停止营业", result: "商贩绕行", claimStatus: "rumor",
	} })]);
	const envelope = normalizeBeatFactEnvelope({ facts: [], evidence: [], elapsed: { kind: "none", unit: "scene", min: 0, max: 0, evidenceIds: [] }, triggerFactIds: [], uncertainties: [] }, { userText: "等候", narrativeText: "街上很安静。" }).envelope!;
	assert.ok(envelope);
	const prompt = buildWorldProposalPrompt("synthetic fixture", {
		world: defaultModularWorldState(), rpState: { time: "午后", location: "广场" } as WorldState,
		manifest: null, sourceEntryId: "saved-narrative", envelope, ecologySignals: ecologySignalsForWorld(ecology),
	});
	const payload = JSON.parse(prompt.userText);
	assert.equal(payload.ecology_signals.length, 1);
	assert.deepEqual(payload.ecology_signals[0].ref, { domain: "ecology", recordId: "internal-source-id" });
	assert.match(payload.ecology_signals[0].summary, /后果参考.*rumor.*传言仓库停止营业.*商贩绕行/);
	assert.doesNotMatch(payload.ecology_signals[0].summary, /internal-source-id|内部密谋名称|秘密据点|隐秘进展|幕后原因/);
	assert.deepEqual(payload.fact_envelope, envelope);
	const unsupported = normalizeBeatFactEnvelope({ ...envelope,
		evidence: [{ id: "claimed-proof", source: "narrative", locator: "narrative", quote: "传言仓库停止营业" }],
		facts: [{ id: "claimed-fact", kind: "event", subject: "仓库", predicate: "停止营业", actuality: "established", visibility: "public", agency: "none", evidenceIds: ["claimed-proof"] }],
	}, { userText: "等候", narrativeText: "街上很安静。" });
	assert.deepEqual(unsupported.envelope?.facts, []);
});

test("世界到生态仍按模块记录顺序过滤并截取三十条且保留来源", () => {
	const world = defaultModularWorldState();
	world.round = 9;
	world.modules["public-information"] = { id: "public-information", kind: "social", revision: 1, summary: "合成公告", records:
		Array.from({ length: 35 }, (_, index) => ({ id: `record-${index}`, facet: "event", label: `公告${index}`, status: "已公布", summary: "告示", visibility: index === 0 ? "secret" : index % 2 ? "public" : "discoverable", attributes: {}, originRefs: [], updatedRound: 9 })),
	};
	const signals = worldSignalsForEcology(world);
	assert.equal(signals.length, 30);
	assert.deepEqual(signals.map(signal => signal.ref.recordId), Array.from({ length: 30 }, (_, index) => `record-${index + 1}`));
	assert.ok(signals.every(signal => signal.source === "world" && signal.sourceRound === 9 && signal.ref.moduleId === "public-information"));
	assert.equal(signals[1]!.visibility, "discoverable");
});
