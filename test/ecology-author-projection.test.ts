import assert from "node:assert/strict";
import test from "node:test";
import {
	commitLiteraryEcologyRound,
	defaultLiteraryEcologyState,
	formatLiteraryEcologyInjection,
	literaryEcologyFromBranch,
	LITERARY_ECOLOGY_ENTRY_TYPE,
	normalizeLiteraryEcologyState,
} from "../src/stage/literary-ecology.ts";
import { buildDatabaseLiteraryDirectorPrompt, buildLiteraryDirectorPrompt } from "../src/stage/literary-director.ts";

const snapshot = (value: unknown) => commitLiteraryEcologyRound(normalizeLiteraryEcologyState(value, defaultLiteraryEcologyState())!, 4);

test("author projection carries completed offscreen consequences into both director paths without replay", () => {
	const state = snapshot({ occurrences: [
		{ id: "repair", name: "渡口修缮", patternKey: "repair", origin: "generated-offscreen", status: "resolved", visibility: "public", development: "渡口已恢复通行，修船匠今天补休", lastAdvancedRound: 4 },
		{ id: "market", name: "旧物集市", patternKey: "market", status: "expired", visibility: "public", development: "摊位已撤，失物交给值班室", lastAdvancedRound: 3 },
	] });
	const before = JSON.stringify(state);
	const ecology = formatLiteraryEcologyInjection(state)!;
	assert.match(ecology, /已结束事项的后果参考：渡口修缮.*已结束.*修船匠今天补休/);
	assert.match(ecology, /旧物集市.*已过期.*失物交给值班室/);
	assert.doesNotMatch(ecology, /公开可知：渡口修缮/);
	const input = { state: { time: "午后", location: "渡口", characters: {}, inventory: [], flags: {}, plot_threads: [] }, history: [], activatedLore: [], userText: "我去渡口看看。", charName: "修船匠", userName: "旅人", ecology };
	for (const prompt of [buildLiteraryDirectorPrompt(input), buildDatabaseLiteraryDirectorPrompt(input, "候选不是事实")]) {
		assert.equal(JSON.parse(prompt.userText).living_ecology, ecology);
	}
	assert.equal(JSON.stringify(state), before, "projection must not advance state or reopen terminal events");
});

test("public surfaces preserve rumor, audience and outcome without leaking backstage names or digest", () => {
	const state = snapshot({ digest: "SECRET_DIGEST", occurrences: [
		{ id: "trace", name: "SECRET_NAME", patternKey: "trace", visibility: "secret", development: "SECRET_DEVELOPMENT", publicSurface: { publicity: "trace", trace: "后门有泥印" } },
		{ id: "rumor", name: "SECRET_RUMOR_NAME", patternKey: "rumor", visibility: "secret", status: "resolved", development: "SECRET_TRUTH", publicSurface: { publicity: "public", headline: "街坊传言", summary: "听说仓库要换人值班", result: "公开排班尚未改动", claimStatus: "rumor", sourceType: "unofficial", audience: ["街坊"], scope: "码头茶摊" } },
		{ id: "private", name: "SECRET_PRIVATE", patternKey: "private", visibility: "public", development: "SECRET_PRIVATE_DETAIL", publicSurface: { publicity: "private" } },
	], actors: [{ id: "worker", name: "值班员", tier: "active", location: "码头", activity: "清点工具", shortGoal: "SECRET_MOTIVE", knowledge: ["SECRET_KNOWLEDGE"] }] });
	const ecology = formatLiteraryEcologyInjection(state)!;
	assert.match(ecology, /公开痕迹.*后门有泥印/);
	assert.match(ecology, /街坊传言［已结束；传闻；unofficial］/);
	assert.match(ecology, /公开结果：公开排班尚未改动/);
	assert.match(ecology, /受众：街坊；传播范围：码头茶摊/);
	assert.match(ecology, /值班员@码头；正在：清点工具/);
	assert.doesNotMatch(ecology, /SECRET_/);
});

test("a public version supersedes raw event details and discoverable events retain their access condition", () => {
	const state = snapshot({ occurrences: [
		{ id: "notice", name: "内部活动名", patternKey: "notice", visibility: "public", development: "不宜公开的真实原因", publicSurface: { publicity: "public", headline: "维修通知", summary: "今日暂停借用", claimStatus: "mixed" } },
		{ id: "meeting", name: "小组练习", patternKey: "meeting", visibility: "discoverable", discovery: "到排练室门口可听见节拍", development: "内部争执详情" },
	] });
	const ecology = formatLiteraryEcologyInjection(state)!;
	assert.match(ecology, /维修通知.*事实与说法混合.*今日暂停借用/);
	assert.match(ecology, /可经合理接触发现：小组练习.*发现条件：到排练室门口可听见节拍/);
	assert.doesNotMatch(ecology, /内部活动名|不宜公开|内部争执/);
});

test("crowded ecology budgets retain complete records across people, places, events and consequences", () => {
	const state = snapshot({
		locationStates: Array.from({ length: 30 }, (_, i) => ({ location: `场所${i}`, state: "日常运行".repeat(75), activities: ["收拾货架", "轮班"] })),
		actors: [{ id: "a", name: "守门人", location: "门房", tier: "active", activity: "按日程交班" }],
		occurrences: [
			{ id: "now", name: "日常交接", patternKey: "now", status: "active", visibility: "public", development: "核对钥匙" },
			{ id: "done", name: "昨日修门", patternKey: "done", status: "resolved", visibility: "public", development: "门已修好" },
		],
	});
	const full = formatLiteraryEcologyInjection(state)!;
	const compact = formatLiteraryEcologyInjection(state, 900)!;
	assert.ok(full.length <= 6000);
	assert.ok(compact.length <= 900);
	for (const label of ["公开可知：日常交接", "已结束事项的后果参考：昨日修门", "人物此刻：守门人", "场所正在运行：场所0"]) assert.ok(compact.includes(label), label);
	for (const line of compact.split("\n")) assert.ok(full.split("\n").includes(line), "never cut a record or its epistemic label in half");
	assert.equal(formatLiteraryEcologyInjection(state, 10), undefined);
	assert.equal(formatLiteraryEcologyInjection(state, 0), undefined);
	assert.equal(formatLiteraryEcologyInjection(defaultLiteraryEcologyState()), undefined);
});

test("consequence budget prioritizes recent updates and branch projection only uses the supplied ancestor", () => {
	const state = snapshot({ occurrences: [
		...Array.from({ length: 20 }, (_, i) => ({ id: `old${i}`, name: `旧事${i}`, patternKey: `old${i}`, status: "resolved", visibility: "public", development: "已告一段落", lastAdvancedRound: 1 })),
		{ id: "new", name: "刚结束的午班", patternKey: "new", status: "resolved", visibility: "public", development: "下一班需多留一把钥匙", lastAdvancedRound: 4 },
	] });
	const sibling = snapshot({ occurrences: [{ id: "sibling", name: "兄弟分支事件", patternKey: "sibling", visibility: "public" }] });
	const entry = (data: typeof state) => ({ type: "custom", customType: LITERARY_ECOLOGY_ENTRY_TYPE, data });
	const projected = formatLiteraryEcologyInjection(literaryEcologyFromBranch([entry(state)]), 250)!;
	assert.match(projected, /刚结束的午班.*下一班需多留一把钥匙/);
	assert.doesNotMatch(projected, /兄弟分支事件/);
	assert.match(formatLiteraryEcologyInjection(literaryEcologyFromBranch([entry(sibling)]))!, /兄弟分支事件/);
});
