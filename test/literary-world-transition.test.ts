import assert from "node:assert/strict";
import test from "node:test";

import { defaultLiteraryWorldState, normalizeLiteraryWorldState } from "../src/stage/literary-world.ts";
import {
	buildWorldAuditPrompt,
	buildWorldProposalPrompt,
	changedWorldPaths,
	commitModularWorldTransition,
	normalizeBeatFactEnvelope,
	normalizeModularWorldProposal,
	normalizeWorldTransitionAudit,
	normalizeWorldTransitionProposal,
	worldAuditFromBranch,
	worldAuditEntry,
	worldTransitionHash,
} from "../src/stage/literary-world-transition.ts";
import { defaultModularWorldState, moduleKindForId, projectLiteraryWorldV1, normalizeModularWorldState } from "../src/stage/literary-world-modular.ts";
import { defaultCardWorldProfile, manifestFromProfile, normalizeCardWorldProfile } from "../src/stage/literary-world-profile.ts";
import { defaultState } from "../src/state.ts";

const sources = { userText: "我把信递给她。", narrativeText: "她接过信，却没有当场拆开。" };
const envelopeInput = {
	evidence: [
		{ id: "ev_user", source: "latest-user", locator: "latest-user", quote: "我把信递给她" },
		{ id: "ev_text", source: "narrative", locator: "narrative", quote: "她接过信" },
	],
	facts: [
		{ id: "fact_give", kind: "action", subject: "用户", predicate: "把信递给她", actuality: "established", visibility: "limited", agency: "user-voluntary", evidenceIds: ["ev_user", "ev_text"] },
	],
	elapsed: { kind: "bounded", unit: "minute", min: 0, max: 1, evidenceIds: ["ev_user"] },
	triggerFactIds: ["fact_give"],
	uncertainties: [],
};

test("world JSON candidates: unrelated objects and multiple fences do not hide the final fact envelope", () => {
	const input = { ...envelopeInput, uncertainties: ['literal { } [ ] and "quoted" text', "escaped \\ path ending \\", 'backslash then quote: \\" }'] };
	const response = [
		'Example: {"example":{"braces":"} {", "quote":"\\\""}}',
		'```json\n{"unrelated":true}\n```',
		'```text\nnot JSON {example}\n```',
		`Final:\n\`\`\`json\n${JSON.stringify(input)}\n\`\`\``,
		'Trailing note: {"done":true}',
	].join("\n");
	assert.deepEqual(normalizeBeatFactEnvelope(response, sources), normalizeBeatFactEnvelope(input, sources));
	assert.equal(normalizeBeatFactEnvelope('{"elapsed":{}}', sources).envelope, undefined, "a non-envelope object is not parsed; the engine then uses an empty envelope");
	const invented = { ...input, facts: [{ ...input.facts[0], evidenceIds: ["missing"] }] };
	assert.deepEqual(normalizeBeatFactEnvelope(`{}\n${JSON.stringify(invented)}`, sources).envelope?.facts, [], "unverifiable facts are dropped, the envelope survives");
});

test("world JSON candidates: competing fact artifacts are ambiguous, including identical copies", () => {
	const json = JSON.stringify(envelopeInput);
	for (const other of [json, JSON.stringify({ ...envelopeInput, uncertainties: ["alternative"] }), JSON.stringify({ ...envelopeInput, elapsed: null })]) {
		assert.equal(normalizeBeatFactEnvelope(`\`\`\`json\n${json}\n\`\`\`\n${other}`, sources).envelope, undefined);
	}
});

test("world JSON candidates: truncated or malformed containers cannot supply nested artifacts", () => {
	const json = JSON.stringify(envelopeInput);
	for (const response of [
		json.slice(0, -1),
		json.slice(0, -2),
		`{"wrapper":${json}`,
		`[${json}`,
		`{"wrapper":${json},}`,
		`[${json}]`,
		`{"wrapper":${json}]`,
		`${json}\n{"facts":[`,
		`${json}\n{"wrapper":]`,
		`{"wrapper":]\n${json}`,
		JSON.stringify(json),
		json.replace('"uncertainties":[]', '"uncertainties":["unterminated }'),
	]) {
		assert.equal(normalizeBeatFactEnvelope(response, sources).envelope, undefined, response);
	}
});

test("world JSON candidates: modular proposals select by shape without bypassing baseline or module validation", () => {
	const envelope = normalizeBeatFactEnvelope(envelopeInput, sources).envelope!;
	const profile = normalizeCardWorldProfile({ digest: "Synthetic information flow", modules: [{ id: "public-information", name: "Information", mode: "active", cadence: "on-trigger", confidence: 1 }] }, defaultCardWorldProfile("/tmp", "card.json", "Synthetic", "x"))!;
	const manifest = manifestFromProfile(profile), previous = defaultModularWorldState(manifest);
	const input = { version: 2, baseRound: previous.round, baseStateHash: worldTransitionHash(previous), outcome: "stable", moduleChanges: [], nextLinks: [], digest: 'literal { "quoted" } \\' };
	const parse = (value: unknown) => normalizeModularWorldProposal(value, previous, envelope, manifest);
	const wrap = (value: unknown) => `\`\`\`json\n{"baseRound":99}\n\`\`\`\nExample: {}\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``;
	assert.ok(parse(wrap(input)).proposal);
	assert.deepEqual(parse(wrap(input)), parse(input));
	assert.equal(parse(`${JSON.stringify(input)}\n${JSON.stringify({ ...input, digest: "alternative" })}`).proposal, undefined);
	assert.equal(parse(JSON.stringify(input).slice(0, -1)).proposal, undefined);
	assert.equal(parse(`${JSON.stringify(input)}\n{"moduleChanges":[`).proposal, undefined);
	for (const invalid of [
		{ ...input, baseRound: previous.round + 1 },
		{ ...input, baseStateHash: "wrong" },
		{ ...input, outcome: "changed", moduleChanges: [{ moduleId: "inactive", factIds: ["fact_give"] }] },
		{ ...input, outcome: "changed", moduleChanges: [{ moduleId: "public-information", factIds: ["missing"] }] },
		{ ...input, outcome: "changed", moduleChanges: [{ moduleId: "public-information", factIds: ["fact_give"], baseRevision: 99, nextModule: { id: "public-information", kind: "social", records: [] } }] },
	]) {
		const result = parse(wrap(invalid));
		assert.equal(result.proposal, undefined);
		assert.deepEqual(result, parse(invalid));
	}
});

test("world JSON candidates: audit selection preserves verdict and fact reference checks", () => {
	const envelope = normalizeBeatFactEnvelope(envelopeInput, sources).envelope!;
	const input = { verdict: "approve", issues: [], summary: 'Braces } { and "quotes" \\' };
	const parse = (value: unknown) => normalizeWorldTransitionAudit(value, envelope);
	const wrap = (value: unknown) => `\`\`\`json\n{"summary":"example"}\n\`\`\`\n${JSON.stringify(value)}\n{"other":{}}`;
	assert.deepEqual(parse(wrap(input)), parse(input));
	assert.ok(parse(wrap(input)).audit);
	assert.equal(parse(`${JSON.stringify(input)}\n${JSON.stringify({ ...input, verdict: "reject" })}`).audit, undefined);
	assert.equal(parse(JSON.stringify(input).slice(0, -1)).audit, undefined);
	assert.equal(parse(`${JSON.stringify(input)}\n{"verdict":"reject","issues":[`).audit, undefined);
	for (const issue of [
		{ severity: "error", factIds: ["fact_give"] },
		{ severity: "warning", factIds: ["missing"] },
	]) {
		const invalid = { ...input, issues: [issue] };
		assert.equal(parse(wrap(invalid)).audit, undefined);
		assert.deepEqual(parse(wrap(invalid)), parse(invalid));
	}
});

test("world JSON candidates: legacy world proposals still accept one complete matching artifact", () => {
	const previous = defaultLiteraryWorldState();
	const envelope = normalizeBeatFactEnvelope(envelopeInput, sources).envelope!;
	const input = { baseRound: 0, outcome: "stable", changes: [], nextState: previous };
	const parse = (value: unknown) => normalizeWorldTransitionProposal(value, previous, envelope, null, normalizeLiteraryWorldState);
	assert.deepEqual(parse(`{"example":true}\n${JSON.stringify(input)}\n{}`), parse(input));
	assert.ok(parse(JSON.stringify(input)).proposal);
	assert.equal(parse(`${JSON.stringify(input)}\n${JSON.stringify(input)}`).proposal, undefined);
	assert.equal(parse(JSON.stringify(input).slice(0, -1)).proposal, undefined);
});

test("world transition：事实信封校验证据引文、用户主权与触发引用", () => {
	const valid = normalizeBeatFactEnvelope(envelopeInput, sources);
	assert.ok(valid.envelope);
	assert.equal(valid.envelope.facts[0]?.agency, "user-voluntary");
	const invented = normalizeBeatFactEnvelope({ ...envelopeInput, facts: [{ ...envelopeInput.facts[0], evidenceIds: ["ev_text"] }] }, sources);
	assert.deepEqual(invented.envelope?.facts, []);
	assert.match(invented.envelope!.uncertainties.join("；"), /没有用户输入证据/);
	const badQuote = normalizeBeatFactEnvelope({ ...envelopeInput, evidence: [{ id: "ev_user", source: "latest-user", quote: "我烧掉了信" }] }, sources);
	assert.match(badQuote.envelope!.uncertainties.join("；"), /不在对应原文/);
	assert.equal(badQuote.envelope!.elapsed.kind, "unknown", "time evidence that fails verification never advances time");
	const emptyQuote = normalizeBeatFactEnvelope({ ...envelopeInput, evidence: [{ id: "ev_user", source: "latest-user", quote: "" }] }, sources);
	assert.match(emptyQuote.envelope!.uncertainties.join("；"), /缺少原文引文/);
	const spacing = normalizeBeatFactEnvelope({ ...envelopeInput, evidence: [{ id: "ev_user", source: "latest-user", quote: "我把信 递给她" }, envelopeInput.evidence[1]] }, sources);
	assert.equal(spacing.envelope?.facts.length, 1, "whitespace-only differences in a quote are tolerated");
});

test("world evidence: frozen input field maps only to narrative and keeps exact JSON-decoded quotes", () => {
	const narrativeText = 'Archive "A" \\ shelf\r\n\u{1F4DA} Cafe\u0301: sealed.';
	const input = {
		evidence: [{ id: "ev", source: "frozen_narrative", quote: narrativeText }],
		facts: [{ id: "fact", actuality: "established", agency: "other", evidenceIds: ["ev"] }],
		elapsed: { kind: "bounded", unit: "minute", min: 0, max: 1, evidenceIds: ["ev"] },
		triggerFactIds: ["fact"],
	};
	const parse = (value: unknown, text = narrativeText) => normalizeBeatFactEnvelope(JSON.stringify(value), { userText: "Continue.", narrativeText: text });
	const result = parse(input);
	assert.ok(result.envelope);
	assert.equal(result.envelope.evidence[0].source, "narrative");
	assert.equal(result.envelope.evidence[0].quote, narrativeText);
	assert.deepEqual(result.envelope.elapsed.evidenceIds, ["ev"]);
	assert.deepEqual(parse({ ...input, facts: [{ ...input.facts[0], agency: "user-voluntary" }] }).envelope?.facts, []);
	for (const source of ["recent_history", "final_rp_state", "unknown"]) {
		assert.deepEqual(parse({ ...input, evidence: [{ ...input.evidence[0], source }] }).envelope?.facts, []);
	}
	assert.deepEqual(parse(input, "").envelope?.facts, []);
	const longQuote = "x".repeat(240) + "\u{1F4DA} exact ending";
	assert.equal(parse({ ...input, evidence: [{ ...input.evidence[0], quote: longQuote }] }, longQuote).envelope?.evidence[0].quote, longQuote);
	assert.deepEqual(parse(input, narrativeText.normalize("NFC")).envelope?.facts, []);
});

	test("world evidence: source labels cannot bypass strict contiguous quotation validation", () => {
	const narrativeText = "The archivist sealed the blue envelope. The courier left the room.";
	for (const source of ["narrative", "frozen_narrative", "latest-user"]) {
		for (const quote of [
			"The archivist sealed the blue envelope... The courier left the room.",
			"The archivist sealed the red envelope.",
			"The archivist sealed the blue envelope. The courier entered the room.",
			narrativeText.toUpperCase(),
			"x".repeat(240) + " invented suffix",
			"", ".", "\uFF34he archivist",
		]) {
			const result = normalizeBeatFactEnvelope({
				evidence: [{ id: "ev", source, quote }],
				facts: [{ id: "fact", evidenceIds: ["ev"] }],
				elapsed: { kind: "bounded", min: 0, max: 1, evidenceIds: ["ev"] },
			}, { userText: narrativeText, narrativeText: narrativeText + "x".repeat(240) });
			// A literal punctuation mark is valid only when actually present in the source.
			if (quote === ".") assert.equal(result.envelope?.facts.length, 1);
			else assert.deepEqual(result.envelope?.facts, [], `${source}: ${quote}`);
		}
	}
});

test("world evidence: repaired exact facts alone form proposal and audit inputs", () => {
	const narrativeText = "The archivist sealed the envelope. The courier waited. The archivist left.";
	const input = {
		evidence: [{ id: "bad", source: "narrative", quote: "The archivist sealed the envelope... The archivist left." }],
		facts: [{ id: "discarded", actuality: "established", agency: "other", evidenceIds: ["bad"] }],
		elapsed: { kind: "bounded", unit: "minute", min: 0, max: 1, evidenceIds: ["bad"] },
		triggerFactIds: ["discarded"],
	};
	const sources = { userText: "Continue.", narrativeText };
	assert.deepEqual(normalizeBeatFactEnvelope(input, sources).envelope?.facts, []);
	const repaired = {
		...input,
		evidence: [{ id: "exact", source: "narrative", quote: "The archivist left." }],
		facts: [{ ...input.facts[0], id: "repaired", evidenceIds: ["exact"] }],
		elapsed: { ...input.elapsed, evidenceIds: ["exact"] },
		triggerFactIds: ["repaired"],
	};
	const envelope = normalizeBeatFactEnvelope(repaired, sources).envelope!;
	assert.ok(envelope);
	const world = defaultModularWorldState();
	const proposal = normalizeModularWorldProposal({ baseRound: 0, baseStateHash: worldTransitionHash(world), outcome: "stable", moduleChanges: [], nextLinks: [] }, world, envelope, null).proposal!;
	const common = { envelope, world, rpState: defaultState(), manifest: null };
	for (const prompt of [buildWorldProposalPrompt("", common), buildWorldAuditPrompt("", { ...common, proposal, preflightWarnings: [] })]) {
		const payload = JSON.parse(prompt.userText);
		assert.deepEqual(payload.fact_envelope, envelope);
		assert.deepEqual(payload.fact_envelope.facts.map((fact: { id: string }) => fact.id), ["repaired"]);
		assert.equal(prompt.userText.includes("discarded"), false);
		assert.equal(prompt.userText.includes("..."), false);
	}
});

test("world proposal: missing fact references are distinct from nonexistent references", () => {
	const envelope = normalizeBeatFactEnvelope(envelopeInput, sources).envelope!;
	const profile = normalizeCardWorldProfile({ digest: "Synthetic economy", modules: [{ id: "economy-market", name: "Economy", mode: "active", cadence: "every-beat", confidence: 1 }] }, defaultCardWorldProfile("/tmp", "card.json", "Synthetic", "x"))!;
	const manifest = manifestFromProfile(profile), previous = defaultModularWorldState(manifest);
	for (const factIds of [[], ["missing"], ["fact_give"]]) {
		const result = normalizeModularWorldProposal({ baseRound: 0, baseStateHash: worldTransitionHash(previous), outcome: "changed", moduleChanges: [{ moduleId: "economy-market", baseRevision: 0, factIds, nextModule: { id: "economy-market", kind: "infrastructure", records: [] } }], nextLinks: [] }, previous, envelope, manifest, "saved-turn");
		assert.ok(result.proposal, "the world may develop offscreen without narrative facts");
		const change = result.proposal.moduleChanges[0];
		if (factIds[0] === "fact_give") { assert.deepEqual(change.factIds, ["fact_give"]); assert.equal(change.provenance, undefined); }
		else { assert.deepEqual(change.factIds, []); assert.equal(change.provenance?.kind, "generated-offscreen"); }
		if (factIds[0] === "missing") assert.match(result.warnings.join("；"), /忽略了无效/);
	}
});

test("world v2: novel offscreen development uses source and time anchors, never invented canonical quotes", () => {
	const envelope = normalizeBeatFactEnvelope(envelopeInput, sources).envelope!;
	const profile = normalizeCardWorldProfile({ digest: "Synthetic regional world", modules: [{ id: "regional-environment", name: "Environment", mode: "active", cadence: "every-beat", confidence: 1 }] }, defaultCardWorldProfile("/tmp", "card.json", "Synthetic", "x"))!;
	const manifest = manifestFromProfile(profile), previous = defaultModularWorldState(manifest);
	const provenance = { kind: "generated-offscreen", sourceEntryId: "saved-turn", worldRefs: [], timeEvidenceIds: ["ev_user"] };
	const change = { moduleId: "regional-environment", baseRevision: 0, factIds: [], reason: "A small local change during the elapsed minute, not an extracted letter fact.", provenance, nextModule: { id: "regional-environment", kind: "environment", summary: "Local visibility", records: [{ id: "fog", facet: "event", label: "Valley fog", status: "forming", summary: "Mist begins to gather in the distant valley.", visibility: "discoverable", attributes: {}, originRefs: [] }] } };
	const input = { baseRound: 0, baseStateHash: worldTransitionHash(previous), outcome: "changed", moduleChanges: [change], nextLinks: [], digest: "Local conditions changed offscreen." };
	const parse = (value: unknown, source = "saved-turn", base = previous, facts = envelope) => normalizeModularWorldProposal(value, base, facts, manifest, source);
	const result = parse(input);
	assert.ok(result.proposal);
	assert.deepEqual(result.proposal.moduleChanges[0].factIds, []);
	assert.deepEqual(result.proposal.moduleChanges[0].provenance, provenance);
	assert.equal(JSON.stringify(envelope).includes("Mist"), false);
	const prompt = buildWorldProposalPrompt("", { envelope, world: previous, rpState: defaultState(), manifest, sourceEntryId: "saved-turn" });
	assert.equal(JSON.parse(prompt.userText).source_entry_id, "saved-turn");
	const auditPrompt = buildWorldAuditPrompt("", { envelope, world: previous, rpState: defaultState(), manifest, proposal: result.proposal, preflightWarnings: [] });
	assert.deepEqual(JSON.parse(auditPrompt.userText).transition_proposal.moduleChanges[0].provenance, provenance);
	const rejected = normalizeWorldTransitionAudit({ verdict: "reject", issues: [{ code: "causal-gap", severity: "error", path: "moduleChanges[0]", factIds: [], message: "Setting excludes fog." }] }, envelope);
	assert.equal(rejected.audit?.verdict, "reject", "generated candidates still face independent setting/causal review");
	for (const code of ["user-action-invented", "secret-leak", "time-scale-violation"]) {
		assert.equal(normalizeWorldTransitionAudit({ verdict: "approve", issues: [{ code, severity: "error", factIds: [], message: "Generated provenance does not waive this boundary." }] }, envelope).audit, undefined);
	}
	const approved = normalizeWorldTransitionAudit({ verdict: "approve", issues: [], summary: "Consistent local offscreen change." }, envelope).audit!;
	const committed = commitModularWorldTransition(previous, result.proposal, worldTransitionHash(approved), manifest);
	assert.equal(committed.round, 1);
	assert.deepEqual(normalizeModularWorldState(JSON.parse(JSON.stringify(committed)), manifest)?.modules[change.moduleId].provenance, provenance);
	assert.deepEqual(envelope.facts.map(fact => fact.id), ["fact_give"]);
	assert.equal(previous.round, 0);
	// Hard boundaries: wrong branch/source, stale base or revision.
	for (const modified of [
		{ ...change, provenance: { ...provenance, sourceEntryId: "fabricated" } },
		{ ...change, baseRevision: 99 },
	]) assert.equal(parse({ ...input, moduleChanges: [modified] }).proposal, undefined);
	assert.equal(parse(input, "other-branch-turn").proposal, undefined);
	assert.equal(parse({ ...input, baseStateHash: "stale" }).proposal, undefined);
	// Soft anchors: invented facts/anchors are dropped, the offscreen development stays.
	for (const modified of [
		{ ...change, factIds: ["invented-fog-fact"] },
		{ ...change, provenance: { ...provenance, timeEvidenceIds: ["missing"] } },
		{ ...change, provenance: { ...provenance, timeEvidenceIds: [], worldRefs: [{ moduleId: change.moduleId, recordId: "fabricated" }] } },
		{ ...change, provenance: { ...provenance, timeEvidenceIds: [] } },
	]) {
		const kept = parse({ ...input, moduleChanges: [modified] }).proposal!;
		assert.ok(kept);
		assert.deepEqual(kept.moduleChanges[0].factIds, []);
		assert.deepEqual(kept.moduleChanges[0].provenance?.worldRefs, []);
		assert.ok(kept.moduleChanges[0].provenance!.timeEvidenceIds.every(id => id === "ev_user"));
	}
	const link = { id: "fog-link", from: { domain: "world", moduleId: change.moduleId, recordId: "fog" }, to: { domain: "world", moduleId: change.moduleId, recordId: "fog" }, relation: "local consequence", factIds: [] };
	assert.ok(parse({ ...input, nextLinks: [link] }).proposal);
	assert.deepEqual(parse({ ...input, nextLinks: [{ ...link, factIds: ["generated-event-is-not-a-canonical-fact"] }] }).proposal?.nextLinks[0].factIds, []);
	assert.deepEqual(parse({ ...input, nextLinks: [{ ...link, from: { ...link.from, recordId: "missing" }, to: { ...link.to, recordId: "missing" } }] }).proposal?.nextLinks, []);
	assert.deepEqual(parse(input, "saved-turn", previous, { ...envelope, elapsed: { ...envelope.elapsed, kind: "none", max: 0 } }).proposal?.moduleChanges[0].provenance?.timeEvidenceIds, [], "no elapsed time means no time anchor");
	const withWorld = structuredClone(committed);
	const worldAnchored = { ...change, baseRevision: 1, provenance: { ...provenance, timeEvidenceIds: [], worldRefs: [{ moduleId: change.moduleId, recordId: "fog" }] } };
	assert.ok(parse({ ...input, baseRound: 1, baseStateHash: worldTransitionHash(withWorld), moduleChanges: [worldAnchored] }, "saved-turn", withWorld, { ...envelope, elapsed: { ...envelope.elapsed, kind: "unknown", evidenceIds: [] } }).proposal);
	assert.deepEqual(normalizeBeatFactEnvelope({ ...envelopeInput, evidence: [{ id: "ev_user", source: "narrative", quote: change.nextModule.records[0].summary }] }, sources).envelope?.facts, []);
});

test("world transition：计划和假设不能成为世界触发", () => {
	const result = normalizeBeatFactEnvelope({
		...envelopeInput,
		facts: [{ ...envelopeInput.facts[0], id: "fact_plan", actuality: "plan", agency: "none" }],
		triggerFactIds: ["fact_plan"],
	}, sources);
	assert.ok(result.envelope, "计划可以作为认识论事实保留，但不能进入触发清单");
	assert.deepEqual(result.envelope.triggerFactIds, []);
	assert.match(result.envelope.uncertainties.join("；"), /不能作为世界触发/);
});

test("world transition：提案只允许活跃模块、声明变化与满足 cadence", () => {
	const envelope = normalizeBeatFactEnvelope(envelopeInput, sources).envelope!;
	const profile = normalizeCardWorldProfile({
		digest: "消息传播",
		modules: [{ id: "public-information", name: "消息传播", mode: "active", cadence: "on-trigger", confidence: 1 }],
	}, defaultCardWorldProfile("/tmp", "card.json", "卡", "x"))!;
	const manifest = manifestFromProfile(profile);
	const previous = defaultLiteraryWorldState();
	const proposal = normalizeWorldTransitionProposal({
		baseRound: 0,
		outcome: "changed",
		changes: [{ moduleId: "public-information", paths: ["winds", "digest"], factIds: ["fact_give"], reason: "有限知情" }],
		nextState: { ...previous, digest: "她已经收到信", winds: [{ id: "wind_letter", topic: "递信", type: "report", level: 1, content: "她收到一封信", scope: "当事人", source: "亲手递交" }] },
	}, previous, envelope, manifest, normalizeLiteraryWorldState);
	assert.ok(proposal.proposal);
	assert.equal(proposal.proposal.nextState.round, 1);
	assert.deepEqual(changedWorldPaths(previous, proposal.proposal.nextState).sort(), ["digest", "winds"]);

	const blocked = normalizeWorldTransitionProposal({
		baseRound: 0,
		changes: [{ moduleId: "war-front", paths: ["events"], factIds: ["fact_give"], reason: "无" }],
		nextState: { ...previous, events: [{ id: "war", name: "战争", type: "conflict", level: 4, stage: "已爆发", description: "战争爆发" }] },
	}, previous, envelope, manifest, normalizeLiteraryWorldState);
	assert.match(blocked.errors.join("；"), /未激活/);
});

test("world transition：短时间不满足日级模块，未声明变化原子拒绝", () => {
	const envelope = normalizeBeatFactEnvelope(envelopeInput, sources).envelope!;
	const profile = normalizeCardWorldProfile({
		digest: "日历",
		modules: [{ id: "institution-calendar", name: "日历", mode: "active", cadence: "per-day", confidence: 1 }],
	}, defaultCardWorldProfile("/tmp", "card.json", "卡", "x"))!;
	const previous = defaultLiteraryWorldState();
	const result = normalizeWorldTransitionProposal({
		baseRound: 0,
		changes: [{ moduleId: "institution-calendar", paths: ["events"], factIds: ["fact_give"], reason: "推进一天" }],
		nextState: { ...previous, digest: "第二天", events: [{ id: "exam", name: "考试", type: "progress", level: 1, stage: "执行", description: "考试开始" }] },
	}, previous, envelope, manifestFromProfile(profile), normalizeLiteraryWorldState);
	assert.match(result.errors.join("；"), /未满足日级频率/);
	assert.match(result.errors.join("；"), /实际变化 digest 未在 changes 声明/);
});

test("world transition：独立审计不能一边 approve 一边报告 error", () => {
	const envelope = normalizeBeatFactEnvelope(envelopeInput, sources).envelope!;
	const invalid = normalizeWorldTransitionAudit({ verdict: "approve", issues: [{ code: "secret-leak", severity: "error", factIds: ["fact_give"], message: "泄密" }], summary: "通过" }, envelope);
	assert.equal(invalid.audit, undefined);
	const valid = normalizeWorldTransitionAudit({ verdict: "reject", issues: [{ code: "causal-gap", severity: "error", factIds: ["fact_give"], message: "因果不足" }], summary: "拒绝" }, envelope);
	assert.equal(valid.audit?.verdict, "reject");
});

test("world transition：审计 wire 投影只暴露状态、摘要和 warning", () => {
	const entry = worldAuditEntry({ status: "committed", narrativeEntryId: "n1", baseRound: 1, nextRound: 2, baseStateHash: "x", errors: [], audit: { version: 1, verdict: "approve", summary: "因果成立", issues: [{ code: "other", severity: "warning", factIds: [], message: "保持克制" }] } });
	const view = worldAuditFromBranch([{ type: "custom", customType: "rp-world-audit", data: entry }]);
	assert.deepEqual(view?.warnings, ["保持克制"]);
	assert.equal(view?.summary, "因果成立");
	assert.equal("proposalHash" in (view ?? {}), false);
});

test("world audit receipt: recovered completion without an audit uses neutral wording", () => {
	const receipt = worldAuditEntry({ status: "committed", narrativeEntryId: "saved-turn", baseRound: 0, baseStateHash: "bootstrap-hash", cardKey: "synthetic-card", manifestRevision: 1, errors: [] });
	const branch = [
		{ type: "custom", customType: "rp-world-audit", data: worldAuditEntry({ status: "fact-failed", narrativeEntryId: "saved-turn", baseRound: 0, baseStateHash: "bootstrap-hash", errors: ["Synthetic extraction failure"] }) },
		{ type: "custom", customType: "rp-world-audit", data: receipt },
		{ type: "custom", customType: "rp-turn-settlement", data: { status: "complete", worldDone: true } },
	];
	const before = structuredClone(branch);
	assert.deepEqual(worldAuditFromBranch(branch), { status: "committed", baseRound: 0, summary: "本拍世界结算已完成。", warnings: [] });
	assert.deepEqual(branch, before, "display must not rewrite legacy receipts or infer missing metadata");
});

test("world audit receipt: snapshot reconciliation is completion without a new audit claim", () => {
	const snapshot = { ...defaultModularWorldState(), round: 3, digest: "Synthetic retained snapshot" };
	const snapshotHash = worldTransitionHash(snapshot);
	const receipt = worldAuditEntry({ status: "committed", narrativeEntryId: "saved-turn", baseRound: 3, nextRound: 3, baseStateHash: snapshotHash, nextStateHash: snapshotHash, errors: [] });
	const branch = [
		{ type: "custom", customType: "rp-world-state", data: { ...snapshot, sourceEntryId: "saved-turn" } },
		{ type: "custom", customType: "rp-world-audit", data: receipt },
	];
	const before = structuredClone(branch);
	assert.deepEqual(worldAuditFromBranch(branch), { status: "committed", baseRound: 3, nextRound: 3, summary: "本拍世界结算已完成。", warnings: [] });
	assert.deepEqual(branch, before);
});

test("world audit receipt: supplied audit and no-due summaries retain their meaning", () => {
	const elapsed = { kind: "bounded" as const, unit: "minute" as const, min: 0, max: 1, evidenceIds: ["synthetic-evidence"] };
	for (const { summary, nextRound } of [{ summary: "因果与知情边界经独立审计通过。", nextRound: 2 }, { summary: "本拍没有到期的世界模块，世界保持稳定。", nextRound: 1 }]) {
		const receipt = worldAuditEntry({ status: "committed", narrativeEntryId: "saved-turn", baseRound: 1, nextRound, baseStateHash: "synthetic-base", elapsed, errors: [], audit: { version: 1, verdict: "approve", summary, issues: [{ code: "other", severity: "warning", factIds: [], message: "保留有限知情范围" }] } });
		assert.deepEqual(worldAuditFromBranch([{ type: "custom", customType: "rp-world-audit", data: receipt }]), { status: "committed", baseRound: 1, nextRound, summary, warnings: ["保留有限知情范围"], elapsed });
	}
});

test("world audit receipt: empty audit summary uses neutral completion wording", () => {
	for (const summary of ["", " \n\t "]) {
		const receipt = worldAuditEntry({ status: "committed", narrativeEntryId: "saved-turn", baseRound: 1, baseStateHash: "synthetic-base", errors: [], audit: { version: 1, verdict: "approve", summary, issues: [] } });
		assert.equal(worldAuditFromBranch([{ type: "custom", customType: "rp-world-audit", data: receipt }])?.summary, "本拍世界结算已完成。");
	}
});

test("world audit receipt: failures preserve fallback wording and actual rejection summaries", () => {
	for (const status of ["rejected", "fact-failed", "proposal-failed", "audit-failed"] as const) {
		const receipt = worldAuditEntry({ status, narrativeEntryId: "saved-turn", baseRound: 2, baseStateHash: "synthetic-base", errors: ["Synthetic failure"] });
		assert.deepEqual(worldAuditFromBranch([{ type: "custom", customType: "rp-world-audit", data: receipt }]), { status, baseRound: 2, summary: "本拍世界变化未提交，保留上一快照。", warnings: [] });
	}
	const rejected = worldAuditEntry({ status: "rejected", narrativeEntryId: "saved-turn", baseRound: 2, baseStateHash: "synthetic-base", errors: [], audit: { version: 1, verdict: "reject", summary: "提案因果不足，未采纳。", issues: [] } });
	assert.equal(worldAuditFromBranch([{ type: "custom", customType: "rp-world-audit", data: rejected }])?.summary, "提案因果不足，未采纳。");
});

test("world transition v2：模块提案原子提交并派生兼容 v1 投影", async () => {
	const { normalizeModularWorldProposal, commitModularWorldTransition, worldTransitionHash } = await import("../src/stage/literary-world-transition.ts");
	const envelope = normalizeBeatFactEnvelope(envelopeInput, sources).envelope!;
	const profile = normalizeCardWorldProfile({ digest: "消息", modules: [{ id: "public-information", name: "消息传播", mode: "active", cadence: "on-trigger", confidence: 1 }] }, defaultCardWorldProfile("/tmp", "card.json", "卡", "x"))!;
	const manifest = manifestFromProfile(profile), previous = defaultModularWorldState(manifest);
	const result = normalizeModularWorldProposal({ version: 2, baseRound: 0, baseStateHash: worldTransitionHash(previous), outcome: "changed", digest: "当事人已经收到信", moduleChanges: [{ moduleId: "public-information", baseRevision: 0, factIds: ["fact_give"], reason: "亲手递交", nextModule: { id: "public-information", kind: "social", summary: "消息仍局限于当事人", records: [{ id: "letter_received", facet: "wind", label: "递信", status: "report", summary: "她已收到信", visibility: "discoverable", attributes: { level: 1, scope: "当事人" }, originRefs: [], updatedRound: 1 }] } }], nextLinks: [] }, previous, envelope, manifest);
	assert.ok(result.proposal);
	const committed = commitModularWorldTransition(previous, result.proposal, "audit", manifest);
	assert.equal(committed.round, 1);
	assert.equal(committed.modules["public-information"]?.revision, 1);
	assert.equal(projectLiteraryWorldV1(committed).winds[0]?.topic, "递信");
	assert.equal(moduleKindForId("cultivation-system"), "rules");
});


test("world transition：正文演出的主角日常行动可结算，但不冒充用户授权", () => {
	const sources = { userText: "继续当前场景。", narrativeText: "沈舟把折好的信收进外套内袋。" };
	const input = {
		evidence: [{ id: "ev_narrative", source: "narrative", locator: "narrative", quote: sources.narrativeText }],
		facts: [{ id: "fact_store_letter", kind: "action", subject: "沈舟", predicate: "把信收进内袋", actuality: "established", visibility: "limited", agency: "other", evidenceIds: ["ev_narrative"] }],
		elapsed: { kind: "unknown", evidenceIds: [] }, triggerFactIds: ["fact_store_letter"], uncertainties: [],
	};
	const narrated = normalizeBeatFactEnvelope(input, sources);
	assert.ok(narrated.envelope, "镜头内已提交的普通主角行动仍可作为剧情事实");
	assert.equal(narrated.envelope.facts[0].agency, "other");
	const inventedConsent = normalizeBeatFactEnvelope({ ...input, facts: [{ ...input.facts[0], agency: "user-voluntary" }] }, sources);
	assert.deepEqual(inventedConsent.envelope?.facts, [], "叙事代写许可不等于屏幕外用户本人作出事件承诺");
	assert.match(inventedConsent.envelope!.uncertainties.join("；"), /没有用户输入证据/);
});
