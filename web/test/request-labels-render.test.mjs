import assert from "node:assert/strict";
import test from "node:test";
import { build } from "../node_modules/esbuild/lib/main.js";

test("实战共用消息与状态条展示中文标签，保留模型、请求编号与正文", async () => {
	const result = await build({
		stdin: { resolveDir: new URL("..", import.meta.url).pathname, loader: "tsx", contents: `
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Bubble, ReadOnlyMessagesContext} from './src/components/Messages.tsx';
import {SessionStatsBar} from './src/components/StatusStrip.tsx';
const names=['database','writer','agent.evidence','agent.ideas','agent.review','settlement.scribe','worldFacts','ecology','worldProposal','worldAudit','database.before','database.after'];
const performance={version:1,totalMs:2000,phases:{'agent.evidence':{durationMs:1000,calls:3,status:'success'},'prep.database':{durationMs:1000,calls:0,status:'success'},'prep.director':{durationMs:0,calls:0,status:'skipped',reason:'merged-database-recall'},'settlement.memory':{durationMs:189344,calls:0,status:'failed'},'prep.memoryRecall':{durationMs:0,calls:0,status:'skipped'}},requests:names.map((phase,i)=>({id:'request-original-'+i,phase,model:'Original-Model',status:i===0?'aborted':'success',usageSource:i===10?'provider-sdk':'missing',...(i===10?{inputTokens:36221,outputTokens:1767,durationMs:22481}:{})}))};
export const message=renderToStaticMarkup(<ReadOnlyMessagesContext.Provider value={true}><Bubble msg={{id:'synthetic',channel:'narrative',text:'English user story success tokens unchanged',performance}} floor={1} fallbackName="测试卡" onCopy={()=>{}} /></ReadOnlyMessagesContext.Provider>);
export const stats=renderToStaticMarkup(<SessionStatsBar stats={{userMessages:1,assistantMessages:1,apiReportedTotalTokens:12345,usageKnownRequests:1,recordedRequestCount:2,contextPercent:null}}/>);
` },
		bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic", loader: { ".css": "empty" }, logLevel: "silent",
	});
	const { createRequire } = await import("node:module");
	const exports = {}, module = { exports };
	new Function("require", "module", "exports", result.outputFiles[0].text)(createRequire(import.meta.url), module, exports);
	const { message, stats } = module.exports;
	for (const text of ["主作者", "数据库记忆", "证据分析", "创意分析", "稿件审阅", "场记整理", "世界事实整理", "鲜活世界整理", "世界变化提案", "世界变化核验", "已中断", "成功", "未返回", "Original-Model", "request-original-9", "English user story success tokens unchanged"]) assert.ok(message.includes(text), text);
	assert.match(message, /三份报告/);
	assert.match(message, /不代表文学质量或审阅通过/);
	assert.match(message, /本拍有效导演候选由数据库召回交付/);
	assert.match(message, /189\.344 秒/);
	assert.match(message, /零框架调用不表示没有请求/);
	for (const text of ['数据库拍前召回','数据库拍后整理','历史数据库请求（拍前／拍后未区分）','已知输入 36,221','已知输出 1,767','22.481 秒','旧记忆路径未执行','不代表没有 API 请求或没有费用']) assert.ok(message.includes(text),text);
	assert.match(stats, /12,345 词元/);
	assert.match(stats, /1\/2次有回执/);
	assert.match(stats, /不等于汉字数/);
});
