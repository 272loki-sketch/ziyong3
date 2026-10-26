import assert from "node:assert/strict";
import test from "node:test";
import { PERFORMANCE_PHASES } from "../src/stage/performance.ts";
import { messageRoleLabel, phaseLabel, phasePurpose, requestStatusLabel, stopReasonLabel, TOKEN_HELP } from "../web/src/request-labels.ts";

test("请求展示覆盖全部现行阶段及历史短名，不丢未知协议值", () => {
	for (const phase of [...PERFORMANCE_PHASES, "database", "embedding", "tavern-helper", "worldFacts", "ecology", "worldProposal", "worldAudit"]) {
		assert.doesNotMatch(phaseLabel(phase), /其他阶段/);
		assert.notEqual(phaseLabel(phase), phase);
		assert.doesNotMatch(phasePurpose(phase), /未提供/);
	}
	assert.equal(phaseLabel("worldFacts"), phaseLabel("settlement.worldFacts"));
	assert.equal(phaseLabel("future.phase"), "其他阶段（future.phase）");
	assert.equal(phaseLabel("toString"), "其他阶段（toString）");
	assert.match(phasePurpose("agent.evidence"), /三份报告/);
	assert.match(phasePurpose("agent.review"), /两份审阅报告/);
	assert.match(phasePurpose("settlement.worldProposal"), /不等于已发生事实/);
	assert.match(phasePurpose("database.before"), /合并文学导演/);
	assert.match(phasePurpose("prep.director"), /不另发独立导演请求/);
	assert.match(phasePurpose("settlement.memory"), /零框架调用不表示没有请求/);
});

test("状态、消息角色、结束原因与用量单位只做展示翻译", () => {
	for (const status of ["running", "success", "failed", "aborted", "degraded", "skipped", "reused"]) assert.notEqual(requestStatusLabel(status), status);
	assert.equal(requestStatusLabel(), "未标注");
	assert.equal(requestStatusLabel("future"), "未知状态（future）");
	assert.equal(messageRoleLabel("user"), "用户消息");
	assert.equal(messageRoleLabel("assistant"), "模型回复");
	assert.equal(stopReasonLabel("length"), "达到输出上限");
	assert.equal(stopReasonLabel("custom"), "其他结束原因（custom）");
	assert.match(TOKEN_HELP, /不等于汉字数/);
	assert.match(TOKEN_HELP, /不代表账单/);
});
