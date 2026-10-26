/** Exact synchronous opening API contract; all data and requests are synthetic. */
import assert from "node:assert/strict";
import vm from "node:vm";
import test from "node:test";
import {getChatMessages,getLastMessageId,setChatMessages,IFRAME_TAVERN_BRIDGE_SNIPPET,type TavernGreetingContext} from "../web/src/tavernShim.ts";
const initial=():TavernGreetingContext=>({sessionId:"synthetic-opening",card:"synthetic.json",leafId:"opening-leaf",messageCount:1,greetingIndex:0,greetings:["Synthetic selector","Synthetic selected opening"]});
test("getLastMessageId and getChatMessages are synchronous and getLast is an index rather than count",()=>{
 const old=(globalThis as any).XMLHttpRequest;let ctx=initial();
 (globalThis as any).XMLHttpRequest=class{status=200;responseText="";open(method:string,path:string,async:boolean){assert.equal(method,"GET");assert.equal(path,"/api/tavern/greeting-context");assert.equal(async,false);}send(){this.responseText=JSON.stringify(ctx);}};
 try{assert.equal(getLastMessageId(),0);const chat=getChatMessages(0,{include_swipes:true});assert.equal(typeof (chat as any).then,"undefined");assert.deepEqual(chat[0].swipes,ctx.greetings);assert.equal(chat[0].swipe_id,0);ctx.messageCount=3;assert.equal(getLastMessageId(),2);assert.throws(()=>getChatMessages(2),/第0楼/);}finally{(globalThis as any).XMLHttpRequest=old;}
});
test("bulk opening setter refuses story text and nonzero-floor modifications before any transport",async()=>{
 for(const update of [[{message_id:0,message:"forbidden"}],[{message_id:1,swipe_id:1}],[{message_id:0,swipe_id:-1}],[],[{message_id:0,swipe_id:1},{message_id:0,swipe_id:0}]])await assert.rejects(()=>setChatMessages(update as any),/第0楼/);
});
test("script frame exposes exact camel-case global API and selects a greeting through its captured binding",async()=>{
 let ctx=initial(),writes=0;const source=IFRAME_TAVERN_BRIDGE_SNIPPET.slice(8,-9);
 const parent={__liyuanTavernGreeting:{read(expected:any){if(expected)assert.deepEqual(JSON.parse(JSON.stringify(expected)),{sessionId:ctx.sessionId,card:ctx.card,leafId:ctx.leafId,greetingIndex:ctx.greetingIndex});return structuredClone(ctx);},async select(index:number,expected:any){assert.equal(expected.leafId,"opening-leaf");writes++;ctx={...ctx,greetingIndex:index,leafId:"selected-leaf"};return structuredClone(ctx);}},TavernHelper:{},toastr:{info(){},success(){},warning(){},error(){}}};
 const context:any={console,Map,Set,Promise,setTimeout,clearTimeout};context.window=context;context.parent=parent;vm.createContext(context);vm.runInContext(source,context);
 assert.equal(vm.runInContext("typeof getLastMessageId",context),"function");assert.equal(vm.runInContext("typeof getlastmessageid",context),"undefined","upstream casing is respected; actual card calls camel case");
 assert.equal(vm.runInContext("getLastMessageId()",context),0);
 const result=await vm.runInContext(`(async()=>{if(getLastMessageId()!==0)throw new Error('already started');const before=getChatMessages(0,{include_swipes:true})[0];await setChatMessages([{message_id:0,swipe_id:1}],{refresh:'affected'});const after=getChatMessages(0,{include_swipes:true})[0];return {sync:!before.then,swipe:after.swipe_id};})()`,context);
 assert.equal(result.sync,true);assert.equal(result.swipe,1);assert.equal(writes,1);
 ctx={...ctx,messageCount:2};await assert.rejects(()=>vm.runInContext(`(async()=>{if(getLastMessageId()!==0)throw new Error('already started');await setChatMessages([{message_id:0,swipe_id:0}]);})()`,context),/already started/);assert.equal(writes,1);
 ctx={...ctx,card:"different-card.json"};assert.throws(()=>vm.runInContext("getChatMessages(0)",context),/Expected values/);assert.equal(writes,1);
});

test("remote-loader script frames receive verified original Vue globals before their loader; static HTML does not",async()=>{
 const {buildSrcDoc}=await import("../web/src/frameDoc.ts");
 const html='<body><script>$("body").load("https://example.invalid/ui.html");window.__loaderMarker=1;</script></body>';
 const interactive=buildSrcDoc(html,true,true);const loader=interactive.indexOf('__loaderMarker');
 assert.ok(interactive.indexOf('/tavern-compat/vendor/vue.js')>0&&interactive.indexOf('/tavern-compat/vendor/vue.js')<loader);
 assert.ok(interactive.indexOf('/tavern-compat/vendor/vue-router.js')<loader);
 assert.equal(buildSrcDoc(html,false,true).includes('/tavern-compat/vendor/vue.js'),false);
 assert.equal(buildSrcDoc('<script>window.__ordinary=1</script>',true,true).includes('/tavern-compat/vendor/vue.js'),false);
});

test("dependency checks report only an enabled helper; native read context stays sanitized and worldbooks use their source-aware REST", async () => {
 const {getTavernHelperVersion,readNativeTavernContext,getCharWorldbookNames,getWorldbook}=await import("../web/src/tavernShim.ts");
 const previousXHR=(globalThis as any).XMLHttpRequest,previousFetch=globalThis.fetch;
 let enabled=true;
 const native={chat:[{mes:"synthetic"}],character:{name:"Synthetic",data:{extensions:{world:"Embedded"}}},userName:"Synthetic",readonlyBooks:{Embedded:{entries:[{uid:7,comment:"Synthetic entry",content:"Synthetic",enabled:false}]}},state:{chatMetadata:{variables:{a:1}},extensionSettings:{EjsTemplate:{enabled:true}}},model:{id:"synthetic-no-secret"}};
 (globalThis as any).XMLHttpRequest=class {
  status=200;responseText="";path="";
  open(_m:string,p:string,async:boolean){assert.equal(async,false);this.path=p;}
  send(){
   if(this.path==="/api/tavern/worldbooks")this.responseText=JSON.stringify({primary:"Embedded",additional:[]});
   else if(this.path==="/api/tavern-plugins/status")this.responseText=JSON.stringify({plugins:[{id:"helper",version:"4.11.3",enabled,installed:true}]});
   else {assert.equal(this.path,"/api/tavern-plugins/context");this.responseText=JSON.stringify(native);}
  }
 };
 globalThis.fetch=async(input:any)=>{
  assert.equal(input,"/api/tavern/worldbook?name=Embedded");
  return new Response(JSON.stringify({name:"Embedded",source:"card",path:"synthetic.json",cardIdentity:"synthetic-card-revision",revision:"synthetic-book-revision",
   entries:native.readonlyBooks.Embedded.entries.map(entry=>({...entry,name:entry.comment,entryKey:"0",fingerprint:"synthetic-entry-fingerprint"}))}));
 };
 try {
  assert.equal(getTavernHelperVersion(),"4.11.3");enabled=false;assert.equal(getTavernHelperVersion(),"");
  const c=readNativeTavernContext();assert.deepEqual(c.extensionSettings,native.state.extensionSettings);assert.equal("model" in c,false);
  assert.deepEqual(getCharWorldbookNames(),{primary:"Embedded",additional:[]});
  const entries=await getWorldbook("Embedded");assert.equal(entries[0].name,"Synthetic entry");assert.equal(entries[0].enabled,false);
  assert.equal("name" in native.readonlyBooks.Embedded.entries[0],false);
 } finally {(globalThis as any).XMLHttpRequest=previousXHR;globalThis.fetch=previousFetch;}
});

test("setChatMessage accepts only the exact existing selected greeting or legacy empty text, never story replacement", async () => {
 const {setChatMessage}=await import("../web/src/tavernShim.ts");
 const previousXHR=(globalThis as any).XMLHttpRequest,previousFetch=globalThis.fetch;let ctx=initial(),writes=0;
 (globalThis as any).XMLHttpRequest=class{status=200;responseText="";open(method:string,path:string,async:boolean){assert.equal(path,"/api/tavern/greeting-context");assert.equal(async,false);}send(){this.responseText=JSON.stringify(ctx);}};
 globalThis.fetch=async(path:any,options:any)=>{assert.equal(path,"/api/tavern/greeting-select");const body=JSON.parse(options.body);assert.deepEqual(Object.keys(body).sort(),["expected","index"]);assert.deepEqual(body.expected,{sessionId:ctx.sessionId,card:ctx.card,leafId:ctx.leafId,greetingIndex:ctx.greetingIndex});writes++;ctx={...ctx,greetingIndex:body.index,leafId:"selected-"+writes};return new Response(JSON.stringify({context:ctx}));};
 try{
  await setChatMessage(ctx.greetings[1],0,{swipe_id:1});assert.equal(ctx.greetingIndex,1);assert.equal(writes,1);
  await assert.rejects(setChatMessage("arbitrary replacement",0,{swipe_id:0}),/已有开场白|改写/);
  await assert.rejects(setChatMessage(ctx.greetings[1],0,{swipe_id:0}),/已有开场白|改写/);
  await assert.rejects(setChatMessage(" "+ctx.greetings[0],0,{swipe_id:0}),/已有开场白|改写/);
  await assert.rejects(setChatMessage(ctx.greetings[0],1,{swipe_id:0}),/第0楼/);
  assert.equal(writes,1);
  await setChatMessage(ctx.greetings[0],"0",{swipe_id:0});assert.equal(writes,2);assert.equal(ctx.greetingIndex,0);
  await setChatMessage("",0,{swipe_id:1});assert.equal(writes,3);
 }finally{(globalThis as any).XMLHttpRequest=previousXHR;globalThis.fetch=previousFetch;}
});

test("script iframe exact existing text can enter and return; forged text and stale card cannot edit or select", async () => {
 let ctx=initial(),writes=0;
 const parent={__liyuanTavernGreeting:{read(expected:any){if(expected)assert.deepEqual(JSON.parse(JSON.stringify(expected)),{sessionId:ctx.sessionId,card:ctx.card,leafId:ctx.leafId,greetingIndex:ctx.greetingIndex});return structuredClone(ctx);},async select(index:number,expected:any){assert.equal(expected.card,ctx.card);writes++;ctx={...ctx,greetingIndex:index,leafId:"selected-"+writes};return structuredClone(ctx);}},TavernHelper:{},toastr:{info(){},success(){},warning(){},error(){}}};
 const context:any={console,Map,Set,Promise,setTimeout,clearTimeout};context.window=context;context.parent=parent;vm.createContext(context);vm.runInContext(IFRAME_TAVERN_BRIDGE_SNIPPET.slice(8,-9),context);
 await vm.runInContext(`setChatMessage(getChatMessages('0',{include_swipe:true})[0].swipes[1],0,{swipe_id:1,refresh:'display_and_render_current'})`,context);
 assert.equal(writes,1);assert.equal(ctx.greetingIndex,1);
 await assert.rejects(()=>vm.runInContext(`setChatMessage('not an existing greeting',0,{swipe_id:0})`,context),/已有开场白|改写/);
 await vm.runInContext(`setChatMessage(getChatMessages('0')[0].swipes[0],0,{swipe_id:0})`,context);assert.equal(writes,2);
 ctx={...ctx,card:"different-card.json"};await assert.rejects(()=>vm.runInContext(`setChatMessage('Synthetic selected opening',0,{swipe_id:1})`,context),/Expected values|变化/);assert.equal(writes,2);
});
