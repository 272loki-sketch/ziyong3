import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { inspectBoundRegex, type RegexInspectorSnapshot } from "../src/regex-inspector.ts";
import { previewOriginalRegex } from "../src/regex-preview.ts";
import { loadCardFrontSnapshot, loadRegexInspectorSnapshot, handleApiRequest, type RestHost } from "../server/rest.ts";

const rule=(name:string,patch:Record<string,unknown>={})=>({scriptName:name,findRegex:"/<插图>([\\s\\S]*?)<\\/插图>/g",replaceString:'<div class="card-art">$1</div>',placement:[2],markdownOnly:true,disabled:false,...patch});
test("原正则只读投影：列出禁用/仅送模/坏表达式/不支持，和实际显示链同顺序",()=>{
 const scripts=[rule("显示"),rule("关闭",{disabled:true}),rule("送模",{markdownOnly:false,promptOnly:true}),rule("用户侧",{placement:[1]}),rule("坏表达式",{findRegex:"/[invalid/g"}),rule("不支持",{substituteRegex:1})];
 const original=JSON.stringify(scripts),result=inspectBoundRegex([{id:"card",kind:"card",path:"card.json",name:"合成卡",scripts}]);
 assert.equal(JSON.stringify(scripts),original);assert.equal(result.rules.length,6);assert.deepEqual(result.rules.map(r=>r.displayActive),[true,false,false,false,false,false]);
 assert.equal(result.rules[2].promptActive,true);assert.match(result.rules[4].notes.join(" "),/无效/);assert.match(result.rules[5].notes.join(" "),/不支持/);assert.equal(result.rules[0].find,scripts[0].findRegex);assert.equal(result.rules[0].replace,scripts[0].replaceString);
});
test("浏览器预览复用wire同一正则执行/深度，原稿与规则未改变",()=>{
 const inspected=inspectBoundRegex([{id:"preset",kind:"preset",path:"preset.json",name:"合成预设",scripts:[rule("深度",{minDepth:1,maxDepth:2})]}]);
 const snapshot:RegexInspectorSnapshot={cardPath:"card.json",charName:"合成角色",userName:"合成用户",skinEnabled:true,...inspected},text="<插图>合成图片说明</插图>\n后段同伴一起吃饭。",original=JSON.stringify(snapshot);
 assert.equal(previewOriginalRegex({snapshot,text,depth:0,applySkin:true}).steps.length,0);
 const output=previewOriginalRegex({snapshot,text,depth:1,applySkin:true});assert.equal(output.steps.length,1);assert.match(output.display,/card-art/);assert.match(output.display,/后段同伴一起吃饭/);
 assert.equal(JSON.stringify(snapshot),original);assert.equal(previewOriginalRegex({snapshot,text,depth:1,applySkin:false}).steps.length,0);
});
test("REST正则来源和cardfront共用绑定：预设→已挂载世界书→卡，忽略未挂载书，不写素材",async()=>{
 const cwd=mkdtempSync(join(tmpdir(),"liyuan-regex-inspector-"));
 try{
  const data={"card.json":{data:{name:"合成角色",description:"合成",extensions:{regex_scripts:[rule("卡"),rule("卡关闭",{disabled:true})]}}},"preset.json":{name:"合成预设",prompts:[],extensions:{regex_scripts:[rule("预设")]}},"world.json":{entries:{},extensions:{regex_scripts:[rule("世界书")]}},"unused.json":{entries:{},extensions:{regex_scripts:[rule("未挂载")]}},"liyuan.config.json":{card:"card.json",preset:"preset.json",lorebooks:["world.json"],userName:"合成用户",cardSkinOff:["card.json"]}};
  for(const[path,value]of Object.entries(data))writeFileSync(join(cwd,path),JSON.stringify(value));
  const before=Object.fromEntries(Object.keys(data).map(p=>[p,readFileSync(join(cwd,p),"utf8")]));
  const snapshot=loadRegexInspectorSnapshot(cwd),front=loadCardFrontSnapshot(cwd);
  assert.deepEqual(snapshot.rules.map(r=>r.name),["预设","世界书","卡","卡关闭"]);assert.deepEqual(snapshot.rules.filter(r=>r.displayActive).map(r=>r.displayRule),front.rules);assert.equal(snapshot.skinEnabled,false);
  const req=Readable.from([]) as any;req.method="GET";req.url="/api/cardfront/regex";let code=0,raw="";
  const res={writeHead(c:number){code=c;},end(s:string){raw=s;}};
  assert.equal(await handleApiRequest(req,res as never,{cwd,isStreaming:()=>false} as RestHost),true);assert.equal(code,200);assert.deepEqual(JSON.parse(raw),JSON.parse(JSON.stringify(snapshot)));
  for(const[path,text]of Object.entries(before))assert.equal(readFileSync(join(cwd,path),"utf8"),text);
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
