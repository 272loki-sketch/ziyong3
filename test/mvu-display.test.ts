/** Synthetic native-protocol fixtures only; no card source, models or production writes. */
import assert from "node:assert/strict";
import test from "node:test";
import { mvuDisplaySuffixes } from "../server/mvu-display.ts";
import { emptyTavernPluginState } from "../server/tavern-plugin-store.ts";
import type { TavernPluginContext } from "../server/tavern-plugin-http.ts";
import { toWireHistory, toWireMsg } from "../server/wire.ts";

const marker = "<StatusPlaceHolderImpl/>";
const names = {charName:"Synthetic character",userName:"Synthetic user"};
const skin = {...names,rules:[{name:"Synthetic renderer (no name heuristics)",source:marker,flags:"g",replace:'```html\n<html><body><div id="synthetic-original-ui">SYNTHETIC ORIGINAL WIDGET</div><script>window.synthetic=true;</script></body></html>\n```',maxDepth:1}]};
function fixture() {
 const context:TavernPluginContext = {sessionId:"synthetic-session",card:"synthetic-card",sourceEntryId:"reply",visibleEntryIds:["user","reply"],userName:names.userName,character:{},readonlyBooks:{},chat:[
  {__liyuanEntryId:"user",is_user:true,mes:"SYNTHETIC INPUT"},
  {__liyuanEntryId:"reply",is_user:false,mes:"SYNTHETIC FACTS",__liyuanAuthorDelivery:"<content>SYNTHETIC FACTS</content>",swipe_id:1},
 ]};
 const state = emptyTavernPluginState();
 state.messages.reply={variables:[{stat_data:{wrongSwipe:true}},{stat_data:{syntheticProfile:{ability:23,relation:"synthetic"}}}]};
 state.chatMetadata.__liyuanMvuProcessed={reply:{status:"normal",at:"2026-01-01T00:00:00Z"}};
 return {context,state};
}
function author(mode:"direct"|"director"="direct") {
 return {role:"assistant",content:[{type:"text",text:"SYNTHETIC FACTS"}],details:{rpEntryId:"reply",rpTavernScope:"synthetic-scope",rpGenerationMode:mode,rpNarrative:"SYNTHETIC FACTS",rpAuthorDraft:"<content>SYNTHETIC FACTS</content>",rpTimeline:[{kind:"thinking",text:"SYNTHETIC PRIVATE THINKING"},{kind:"text",text:"SYNTHETIC FACTS"}]}};
}

test("native MVU receipt + exact saved swipe restores only the display protocol without writes",()=>{
 const {context,state}=fixture(),before=JSON.stringify({context,state});
 assert.deepEqual([...mvuDisplaySuffixes(context,state,true)],[['reply','\n\n'+marker]]);
 assert.equal(JSON.stringify({context,state}),before);
 assert.equal(mvuDisplaySuffixes(context,state,false).size,0);
 for(const status of ["normal","updated","unchanged"]) {
  state.chatMetadata.__liyuanMvuProcessed={reply:{status}};
  assert.equal(mvuDisplaySuffixes(context,state,true).get("reply"),'\n\n'+marker);
 }
});
test("no invented UI from enabled-only, inherited data, a receipt alone or an invalid swipe",()=>{
 for(const change of [
  ({state}:ReturnType<typeof fixture>)=>{delete state.chatMetadata.__liyuanMvuProcessed;},
  ({state}:ReturnType<typeof fixture>)=>{state.chatMetadata.__liyuanMvuProcessed={reply:{status:"pending"}};},
  ({state}:ReturnType<typeof fixture>)=>{state.chatMetadata.__liyuanMvuProcessed={reply:{status:"failed"}};},
  ({state}:ReturnType<typeof fixture>)=>{delete state.messages.reply;},
  ({state}:ReturnType<typeof fixture>)=>{state.messages.reply.variables=[{stat_data:{other:true}},{}];},
  ({state}:ReturnType<typeof fixture>)=>{state.messages.reply.variables=[{stat_data:{other:true}},{stat_data:{}}];},
  ({context}:ReturnType<typeof fixture>)=>{context.chat[1].swipe_id=8;},
 ]) {const f=fixture();change(f);assert.equal(mvuDisplaySuffixes(f.context,f.state,true).size,0);}
});
test("user/unfinished/system/unknown/sibling sources do not receive another message's UI",()=>{
 for(const patch of [{is_user:true},{is_system:true},{__liyuanUnfinished:true},{__liyuanEntryId:"sibling"},{__liyuanAuthorDelivery:""}]){
  const f=fixture();Object.assign(f.context.chat[1],patch);assert.equal(mvuDisplaySuffixes(f.context,f.state,true).size,0);
 }
 const f=fixture();f.context.visibleEntryIds=["user","sibling"];assert.equal(mvuDisplaySuffixes(f.context,f.state,true).size,0);
});
test("an author-supplied native marker is never duplicated",()=>{
 const f=fixture();f.context.chat[1].__liyuanAuthorDelivery+=marker;
 assert.equal(mvuDisplaySuffixes(f.context,f.state,true).size,0);
});
for(const mode of ["direct","director"] as const)test(`${mode}: original card regex expands the source-bound suffix in both body and timeline, not the author/facts`,()=>{
 const {context,state}=fixture(),message=author(mode),before=JSON.stringify(message);
 const displaySuffixes=mvuDisplaySuffixes(context,state,true),wire=toWireHistory([message],names,{skin,displaySuffixes})[0];
 assert.match(wire.text,/id="synthetic-original-ui"/);assert.match(wire.text,/SYNTHETIC FACTS/);
 assert.doesNotMatch(wire.text,/StatusPlaceHolderImpl|SYNTHETIC PRIVATE THINKING/);
 assert.equal(wire.authorDelivery,message.details.rpAuthorDraft);
 assert.match(wire.timeline!.filter(s=>s.kind==="text").map(s=>s.text).join(""),/synthetic-original-ui/);
 assert.equal(JSON.stringify(message),before);assert.equal(state.messages.reply.extra,undefined);
 assert.equal(toWireHistory([message],names,{skin,displaySuffixes})[0].text,wire.text,"hello/reconnect is read-only and idempotent");
});
test("original renderer depth limits, off/absent rules and no-skin fallback never leak an added marker",()=>{
 const {context,state}=fixture(),displaySuffixes=mvuDisplaySuffixes(context,state,true),message=author();
 const next=[message,{role:"user",content:"NEXT SYNTHETIC INPUT"},{role:"assistant",content:"NEXT SYNTHETIC REPLY",details:{rpEntryId:"next"}}];
 const old=toWireHistory(next,names,{skin,displaySuffixes})[0];assert.doesNotMatch(old.text,/synthetic-original-ui|StatusPlaceHolderImpl/);
 for(const originalSkin of [null,{...skin,rules:[]},{...skin,rules:[{...skin.rules[0],minDepth:1}]}]){
  const wire=toWireHistory([message],names,{skin:originalSkin,displaySuffixes})[0];assert.doesNotMatch(wire.text,/synthetic-original-ui|StatusPlaceHolderImpl/);
 }
 assert.doesNotMatch(toWireMsg({...message,stopReason:"aborted"},names,{skin,displaySuffixes})!.text,/synthetic-original-ui|StatusPlaceHolderImpl/);
});
test("legacy saved timeline receives the native display suffix but is not persisted/replaced",()=>{
 const message=author();delete (message.details as Partial<typeof message.details>).rpGenerationMode;
 delete (message.details as Partial<typeof message.details>).rpAuthorDraft;
 const {context,state}=fixture(),displaySuffixes=mvuDisplaySuffixes(context,state,true),before=JSON.stringify(message);
 const wire=toWireHistory([message],names,{skin,displaySuffixes})[0];
 assert.match(wire.text,/synthetic-original-ui/);assert.match(wire.timeline!.filter(s=>s.kind==="text").map(s=>s.text).join(""),/synthetic-original-ui/);
 assert.equal(JSON.stringify(message),before);
});

for(const mode of ["direct","director"] as const)test(`${mode}: verified display rewrite keeps native MVU UI in both text/timeline without replacing author facts`,()=>{
 const {context,state}=fixture(),message=author(mode),before=JSON.stringify(message),displaySuffixes=mvuDisplaySuffixes(context,state,true);
 const displayOverrides=new Map([["reply","<content>SYNTHETIC POLISHED DISPLAY</content>"]]);
 const wire=toWireHistory([message],names,{skin,displaySuffixes,displayOverrides})[0];
 assert.match(wire.text,/SYNTHETIC POLISHED DISPLAY/);assert.match(wire.text,/synthetic-original-ui/);
 const timeline=wire.timeline!.filter(s=>s.kind==="text").map(s=>s.text).join("");assert.match(timeline,/SYNTHETIC POLISHED DISPLAY/);assert.match(timeline,/synthetic-original-ui/);
 assert.equal(wire.authorDelivery,message.details.rpAuthorDraft);assert.equal(JSON.stringify(message),before);
 const noRenderer=toWireHistory([message],names,{skin:null,displaySuffixes,displayOverrides})[0];assert.match(noRenderer.text,/SYNTHETIC POLISHED DISPLAY/);assert.doesNotMatch(noRenderer.text,/StatusPlaceHolderImpl/);
 const half=toWireMsg({...message,stopReason:"aborted"},names,{skin,displaySuffixes,displayOverrides})!;assert.doesNotMatch(half.text,/POLISHED|synthetic-original-ui/);
});
