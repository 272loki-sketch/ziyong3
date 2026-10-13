import assert from "node:assert/strict";
import test from "node:test";
import { toWireMsg } from "../server/wire.ts";
import { shouldRestoreRerollFallback } from "../server/turn-fallback.ts";
import { originalAuthorPresentation, parseAgentPresentation, parseAgentPresentationPlan, type AgentPresentationMaterials } from "../src/stage/agent-presentation.ts";
import { extractPureTextNarrative } from "../src/stage/engine.ts";

for (const generationMode of ["direct","director"]) test(generationMode+"：刷新/历史格式覆盖不能用短投影替换作者完整原稿",()=>{
 const raw="<content>他做好了晚饭。</content>\n<插图>合成插图</插图>\n另一位同伴回来，与师傅坐下吃完了饭。";
 const message={role:"assistant",content:[{type:"text",text:"他做好了晚饭。"}],stopReason:"stop",details:{rpGenerationMode:generationMode,rpNarrative:"他做好了晚饭。",rpAuthorDraft:raw,rpTimeline:[{kind:"text",text:"他做好了晚饭。"}],rpPresentationBody:"他做好了晚饭。"}};
 const wire=toWireMsg(message,{charName:"合成角色",userName:"合成用户"})!;
 assert.equal(wire.authorDelivery,raw);assert.match(wire.text,/另一位同伴回来/);assert.match(wire.timeline!.find(seg=>seg.kind==="text")!.text!,/吃完了饭/);
 assert.equal(message.details.rpAuthorDraft,raw);assert.equal(originalAuthorPresentation(message.details.rpNarrative,raw).display,raw);
});
test("缺少行动选项/图片、未知格式都不成为原稿保存的失败门槛",()=>{
 for(const raw of ["只有正文。","<自由格式>不受名单限制</自由格式>","<插图>不完整也如实保留原稿"]){const delivery=originalAuthorPresentation("已有事实。",raw);assert.equal(delivery.display,raw);assert.deepEqual(delivery.requirements,[]);}
});
test("正文边界不在第一个闭合content处截断规范故事",()=>{
 const raw="<rule_check>非故事检查</rule_check><content>先做好晚饭。</content><options>附属选项</options>另一位同伴回来。<content>师徒吃完饭。</content>";
 const narrative=extractPureTextNarrative(raw);assert.match(narrative,/先做好晚饭/);assert.match(narrative,/另一位同伴回来/);assert.match(narrative,/师徒吃完饭/);assert.doesNotMatch(narrative,/非故事|附属选项/);
});
test("重Roll新回复已保存，即使账本/世界/旧格式收据失败也不回退旧版",()=>{
 for(const error of [undefined,"格式标签名无效","presentation结算仍失败","主作者输出恢复回执无效"]){assert.equal(shouldRestoreRerollFallback({entryId:"new-saved",error,aborted:!!error}),false);}
 assert.equal(shouldRestoreRerollFallback({error:"发送前失败"}),true);assert.equal(shouldRestoreRerollFallback({aborted:true}),true);
 assert.equal(shouldRestoreRerollFallback({error:"保存后异常未返回entryId"},true),false);
});
test("历史兼容：中文标签合法，斜杠/尖括号不冒充标签名，中文闭合块可定位",()=>{
 const materials={sources:[{id:"source",title:"合成规则",content:"<插图>图像格式</插图>",formatCandidate:true}]} as AgentPresentationMaterials;
 const plan=(value:string)=>JSON.stringify({requirements:[{id:"r",name:"插图",required:true,sourceIds:["source"],quote:"图像格式",locator:{kind:"pair-tag",value}}],sourceReviews:[{id:"source",requirementIds:["r"],reason:"合成引用"}]});
 const valid=parseAgentPresentationPlan(plan("插图"),materials);assert.equal(valid.ok,true);
 for(const value of ["a/b","a<b"]){const bad={...materials,sources:[{...materials.sources[0],content:`图像格式 ${value}`}]} as AgentPresentationMaterials;assert.equal(parseAgentPresentationPlan(plan(value),bad).ok,false);}
 assert.ok(valid.ok);const body="前段。<image>合成图像</image>后段。",formats="<插图>图像格式</插图><options>继续</options>";
 const parsed=parseAgentPresentation(JSON.stringify({body,formats,requirements:[{id:"r",name:"插图",kind:"card-format",quote:"图像格式"},{name:"选项",kind:"actions",quote:"<options>继续</options>"}]}),"前段。后段。",undefined,valid.plan);
 assert.equal(parsed.ok,true);assert.equal(parseAgentPresentation(JSON.stringify({body,formats:formats.replaceAll("插图","插图x"),requirements:[{id:"r",name:"插图",kind:"card-format",quote:"图像格式"},{name:"选项",kind:"actions",quote:"<options>继续</options>"}]}),"前段。后段。",undefined,valid.plan).ok,false);
});
