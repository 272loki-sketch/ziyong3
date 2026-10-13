import test from 'node:test';import assert from 'node:assert/strict';
import{applyCardSkinProtected,restoreCardSkinProtected}from'../src/cardSkin.ts';
import{prepareDisplayText,extractScaffoldThinking,cleanAssistantText,classifyTag}from'../src/postprocess.ts';
import{toWireMsg}from'../server/wire.ts';import{splitRichContentParts}from'../web/src/richContentParts.ts';
const macros={charName:'合成师傅',userName:'合成读者'};
const rules=[
 {name:'dialogue',source:'【(.*?)】\\s*[:：]\\s*([“"「].*?[”"」])',flags:'gm',replace:'<div class="synthetic-dialogue"><b>$1</b><p>$2</p></div>'},
 {name:'inner',source:'<inner>([\\s\\S]*?)<\\/inner>',flags:'g',replace:'<div class="synthetic-inner">$1</div>'},
 {name:'check',source:'<rule_check>\\s*([\\s\\S]*?)\\s*<\\/rule_check>',flags:'gsi',replace:'<details class="synthetic-check"><summary>生成检查</summary><div>$1</div></details>'},
];
const meta='<rule_check>合成审查已经通过。心声采用<inner>标签，对话使用【角色名】：“内容”，正文由<content>包裹。</rule_check>';
const story='<content>清晨庭院里一切安静。\n【徒弟】：“师傅早。”\n<inner>今天只想安静喝茶。\n【师傅】：“早。”</inner>\n院外传来清风。</content>';
const source=meta+'\n'+story+'\n<options>继续练剑\n回屋休息</options>';
const token=(index:number)=>`\uE000${index}\uE000`;

test('parent-before-child restoration resolves actual nested dialogue in a panel, not leaked PUA markers',()=>{
 const original='<inner>先喝茶。\n【师傅】：“坐。”</inner>';
 const applied=applyCardSkinProtected(original,rules,macros,token);
 assert.ok(applied.stash.some(s=>/\uE000\d+\uE000/.test(s)),'fixture must exercise a real dependency');
 const display=restoreCardSkinProtected(applied.text,applied.stash,token);
 assert.doesNotMatch(display,/\uE000\d+\uE000/);assert.match(display,/synthetic-inner/);assert.match(display,/synthetic-dialogue/);assert.match(display,/“坐。”/);
});
test('rule-check literal tag examples cannot consume narrative; original collapsed check card remains',()=>{
 const displayed=prepareDisplayText(source,{rules,...macros}),parts=splitRichContentParts(displayed),inner=parts.filter(p=>p.kind==='html'&&p.html.includes('synthetic-inner'));
 assert.equal(inner.length,1);if(inner[0].kind!=='html')throw Error('expected inner HTML');
 assert.match(inner[0].html,/今天只想安静喝茶/);assert.doesNotMatch(inner[0].html,/合成审查|清晨庭院|角色名/);
 assert.equal(displayed.split('清晨庭院里一切安静').length-1,1);assert.doesNotMatch(displayed,/\uE000\d+\uE000/);
 assert.match(displayed,/<details class="synthetic-check">/);assert.doesNotMatch(displayed,/<details[^>]*\bopen/);
 const prose=parts.filter(p=>p.kind==='text').map(p=>p.text).join('\n');assert.doesNotMatch(prose,/合成审查|正文由|心声采用/);assert.match(prose,/清晨庭院|院外传来清风/);
 assert.equal(source,meta+'\n'+story+'\n<options>继续练剑\n回屋休息</options>','author source immutable');
});
test('without a metadata renderer rule_check folds into thought, never into visible story or history',()=>{
 assert.equal(classifyTag('rule_check'),'fold');assert.equal(classifyTag('RULE-CHECK'),'fold');
 assert.match(extractScaffoldThinking(source),/合成审查/);assert.doesNotMatch(extractScaffoldThinking(source),/清晨庭院/);
 assert.doesNotMatch(prepareDisplayText(source),/合成审查|正文由|角色名/);assert.doesNotMatch(cleanAssistantText(source),/合成审查|正文由|角色名/);
});
test('real wire and timeline preserve author source and use the same scope-safe display projection',()=>{
 const wire=toWireMsg({role:'assistant',content:[{type:'text',text:source}],stopReason:'stop',details:{rpGenerationMode:'direct',rpAuthorDraft:source,rpNarrative:'合成规范正文。',rpTimeline:[{kind:'thinking',text:'合成思考'}]}} as any,{charName:macros.charName,userName:macros.userName},{skin:{rules,...macros}})!;
 assert.equal(wire.authorDelivery,source);assert.match(wire.thinking??'',/合成审查/);assert.doesNotMatch(wire.text,/\uE000\d+\uE000/);
 assert.equal(wire.timeline?.find(s=>s.kind==='text')?.text,wire.text);
});
test('display scope isolation does not swallow unknown author formats or code examples',()=>{
 const prose='<unknown>必须保留的作者格式内容。</unknown>';assert.match(prepareDisplayText(prose),/必须保留/);
 const code='```xml\n<rule_check>这是代码示例，不是开头检查</rule_check>\n```';assert.match(prepareDisplayText(code),/这是代码示例/);
});

test('atomic audit owner renders raw examples once; inline full-document dialogue cannot nest in audit',()=>{
 const scopedRules=[
  {source:'【(.*?)】\\s*[:：]\\s*([“"「].*?[”"」])',flags:'gm',replace:'```html\n<!doctype html><html><body><div class="dialogue">$1$2</div></body></html>\n```'},
  {source:'<inner>([\\s\\S]*?)<\\/inner>',flags:'g',replace:'<div class="inner">$1</div>'},
  {source:'<rule_check>\\s*([\\s\\S]*?)\\s*<\\/rule_check>',flags:'gsi',replace:'```html\n<!doctype html><html><head><style>.check{color:#333}</style></head><body><details class="check"><summary>合成审查</summary><div class="check-body">$1</div></details></body></html>\n```'},
  {source:'【(.*?)】\\s*[:：]\\s*([“"「].*?[”"」])',flags:'gm',replace:'<div class="late-dialogue">$1$2</div>'},
 ];
 const raw='<rule_check>文字检查；心声用<inner>示例。对话为【角色名】：“内容”，正文由<content>包裹，尾部附带规范选项。</rule_check>\n正文。';
 const displayed=prepareDisplayText(raw,{rules:scopedRules,...macros}),parts=splitRichContentParts(displayed),html=parts.filter(p=>p.kind==='html');
 assert.equal(html.length,1,'one complete audit document, no child iframe');if(html[0].kind!=='html')throw Error('expected html');
 assert.equal(html[0].html.match(/<html\b/g)?.length,1);assert.equal(html[0].html.match(/<\/html>/g)?.length,1);assert.doesNotMatch(html[0].html,/```|class="dialogue"|late-dialogue/);
 assert.match(html[0].html,/【角色名】：“内容”/);assert.match(html[0].html,/尾部附带规范选项/);assert.match(parts.filter(p=>p.kind==='text').map(p=>p.text).join(''),/正文/);
 assert.doesNotMatch(parts.filter(p=>p.kind==='text').map(p=>p.text).join(''),/<\/html>|<\/body>|<\/details>|```html/);
});

test('audit captures preserve literal XML examples/entities and cannot inject new panel markup',()=>{
 const raw='<rule_check>使用<inner>和<content>，字面&与&lt;；<script>window.bad=true</script></rule_check>';
 const checkOnly=[{source:'<rule_check>([\\s\\S]*?)<\\/rule_check>',flags:'g',replace:'<details><summary>检查</summary><div>$1</div></details>'}];
 const display=prepareDisplayText(raw,{rules:checkOnly,...macros});
 assert.match(display,/使用&lt;inner&gt;和&lt;content&gt;/);assert.match(display,/字面&amp;与&amp;lt;/);assert.match(display,/&lt;script&gt;window.bad=true&lt;\/script&gt;/);assert.doesNotMatch(display,/<script>|<inner>|<content>/);
 assert.equal(raw,'<rule_check>使用<inner>和<content>，字面&与&lt;；<script>window.bad=true</script></rule_check>');
});
