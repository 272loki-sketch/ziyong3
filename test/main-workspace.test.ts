import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import WebSocket from 'ws';
import {mainWorkspaceHtml,requestContext,parentRequest} from '../server/main-workspace.ts';
import {workspaceFixture,until} from './helpers/workspace-fixture.ts';
const digest=(path:string)=>createHash('sha256').update(readFileSync(path)).digest('hex');
test('workspace transport context refuses ambiguity and only injects host-owned bootstrap',()=>{
 const lease='1'.repeat(32),context={workspace:'primary',lease};
 assert.match(mainWorkspaceHtml('<html><head><title>fixture</title></head></html>',context),/<head><meta name="liyuan-workspace"/);
 assert.throws(()=>mainWorkspaceHtml('<head>',{workspace:'<script>',lease}));
 assert.deepEqual(requestContext({url:'/?liyuanWorkspace=primary&liyuanLease='+lease,headers:{}}),context);
 assert.equal(requestContext({url:'/?liyuanWorkspace=primary&liyuanWorkspace=other',headers:{}}).workspace,'invalid');
 assert.equal(requestContext({url:'/?liyuanWorkspace=primary',headers:{'x-liyuan-workspace':'other'}}).workspace,'invalid');
 for(const path of ['/api/config','/api/memory','/api/cards/image','/media/test','/tavern-plugin-host.html'])assert.equal(parentRequest(path),false,path);
 for(const path of ['/api/access/status','/api/play-slots/main','/api/update/check','/assets/app.js','/'])assert.equal(parentRequest(path),true,path);
});
test('same canonical story: parallel -> full main REST/WS -> parallel -> restart, no copies or cross-workspace writes (synthetic)',{timeout:100_000},async()=>{
 const fixture=await workspaceFixture();const sockets:WebSocket[]=[];
 try{
  const call=async(path:string,context?:any,method='GET',body?:unknown,extra:Record<string,string>={})=>fetch(fixture.base+path,{method,headers:{cookie:fixture.cookie,...(context?{'x-liyuan-workspace':context.workspace,'x-liyuan-workspace-lease':context.lease}:{}),...extra,...(body!==undefined?{'content-type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const status=async()=>(await call('/api/play-slots/main')).json() as Promise<any>;
  const take=async(id:string|null,scope:any)=>call('/api/play-slots/main',undefined,'POST',{id,expectedWorkspace:scope.workspace,expectedLease:scope.lease});
  const connect=(path:string,scope?:any)=>{
   const query=scope?`?liyuanWorkspace=${scope.workspace}&liyuanLease=${scope.lease}`:'';
   const ws=new WebSocket(fixture.base.replace('http:','ws:')+path+query,{headers:{cookie:fixture.cookie,origin:fixture.base}});sockets.push(ws);
   const frames:any[]=[];ws.on('message',raw=>{frames.push(JSON.parse(raw.toString()));});ws.on('error',()=>{});return{ws,frames};
  };
  const hello=async(client:ReturnType<typeof connect>)=>{await until(()=>client.frames.some(f=>f.type==='hello'));return client.frames.find(f=>f.type==='hello');};
  const send=(client:ReturnType<typeof connect>,sessionId:string,text:string,id=randomUUID())=>{client.ws.send(JSON.stringify({type:'prompt',sessionId,text,messageId:id,generationMode:'direct'}));return id;};
  let scope=await status();assert.equal(scope.workspace,'primary');
  const html=await(await call('/')).text();assert.ok(html.includes(`content="${scope.lease}"`));assert.match(html,/workspace-scope.js/);
  const original=connect('/ws',scope);const primary=await hello(original);
  const rootId=primary.sessionId;
  send(original,rootId,'合成原主窗口故事，交接后必须原样保留');
  await until(()=>original.frames.some(f=>f.type==='hello'&&f.streaming===false&&f.messages?.some((m:any)=>m.text.includes('合成正文第1楼'))));
  // Root story is not a multi-card copy and remains byte-for-byte unchanged.
  await until(()=>existsSync(join(fixture.cwd,'agent/sessions')));
  const primaryConfig=digest(join(fixture.cwd,'liyuan.config.json'));
  const rootFiles=()=>readdirSync(join(fixture.cwd,'agent/sessions'),{recursive:true}).filter(p=>String(p).endsWith('.jsonl')).map(p=>join(fixture.cwd,'agent/sessions',String(p)));
  const rootBefore=new Map(rootFiles().map(path=>[path,digest(path)]));assert.ok(rootBefore.size,'the original root save must actually be on disk');
  const created=await call('/api/play-slots',undefined,'POST',{card:'cards/Independent.json'});assert.equal(created.status,201,fixture.log);
  const slot=(await created.json() as any).slot,work=join(fixture.cwd,'.liyuan/play-slots',slot.id,'work');
  let compact=connect(`/api/play-slots/${slot.id}/ws?slotLease=${slot.lease}`);const first=await hello(compact);assert.notEqual(first.sessionId,rootId);
  fixture.hold();send(compact,first.sessionId,'合成独立第一楼');await until(()=>fixture.writers===2);
  assert.equal((await take(slot.id,scope)).status,409,'busy story must not hand off');fixture.release();
  await until(()=>compact.frames.some(f=>f.type==='hello'&&f.streaming===false&&f.messages?.some((m:any)=>m.text.includes('合成正文第2楼'))));
  // State of different owners is retained in place, not reconstituted from text.
  const sentinels=['.liyuan-memory/interop-fixture.bin','.liyuan-tavern-plugins/interop-fixture.bin','.liyuan-npc-parallel/interop-fixture.bin','.liyuan-database-plugin/interop-fixture.bin','.liyuan-outline/interop-fixture.bin'];
  for(const path of sentinels){mkdirSync(join(work,path,'..'),{recursive:true});writeFileSync(join(work,path),'synthetic-private-state-'+path);}
  const hashes=sentinels.map(path=>digest(join(work,path)));
  const sessionsDir=join(work,'agent/sessions');const savedFiles=()=>readdirSync(sessionsDir,{recursive:true}).filter(p=>String(p).endsWith('.jsonl')).map(String);
  const savedBefore=savedFiles();assert.ok(savedBefore.length);
  let response=await take(slot.id,scope);assert.equal(response.status,200,await response.text());
  const oldPrimary=scope;scope=await status();assert.equal(scope.slot.id,slot.id);assert.notEqual(scope.lease,oldPrimary.lease);
  assert.equal((await call('/api/config',oldPrimary,'PUT',{userName:'SHOULD-NOT-WRITE'})).status,409);
  assert.equal((await call('/api/config')).status,409,'unscoped clients must fail closed');
  assert.equal((await call('/api/config',scope,'PUT',{userName:'EVIL'},{origin:'https://foreign.invalid'})).status,403);
  await until(()=>original.ws.readyState===WebSocket.CLOSED&&compact.ws.readyState===WebSocket.CLOSED);
  const denied=connect(`/api/play-slots/${slot.id}/ws?slotLease=${slot.lease}`);await until(()=>denied.ws.readyState===WebSocket.CLOSED);assert.deepEqual(denied.frames,[]);
  const full=connect('/ws',scope),mainHello=await hello(full);assert.equal(mainHello.sessionId,first.sessionId);assert.ok(mainHello.messages.some((m:any)=>m.text.includes('合成正文第2楼')));
  await until(()=>full.frames.some(f=>f.type==='assistant_hello'));
  full.ws.send(JSON.stringify({type:'sessions'}));await until(()=>full.frames.some(f=>f.type==='sessions'));assert.ok(JSON.stringify(full.frames.find(f=>f.type==='sessions')).includes(first.sessionId));
  const config=await(await call('/api/config',scope)).json() as any;assert.equal(config.config.card,'cards/Independent.json');
  assert.equal((await call('/api/config',scope,'PUT',{userName:'IndependentUser'})).status,200);
  assert.equal(JSON.parse(readFileSync(join(work,'liyuan.config.json'),'utf8')).userName,'IndependentUser');
  assert.equal(digest(join(fixture.cwd,'liyuan.config.json')),primaryConfig);
  for(const path of ['/api/world-state','/api/outline','/api/memory','/api/database-plugin/status','/api/tavern-plugins/status','/api/npc-parallel/status','/api/veridis-rewrite/status']){
   const reply=await call(path,scope);assert.equal(reply.status,200,path+': '+await reply.text());assert.equal(reply.headers.has('set-cookie'),false);
  }
  const host=await call(`/tavern-plugin-host.html?liyuanWorkspace=${scope.workspace}&liyuanLease=${scope.lease}`);assert.equal(host.status,200);assert.ok((await host.text()).includes(`content="${scope.lease}"`));
  const secondId=send(full,first.sessionId,'合成主窗口第二楼');await until(()=>full.frames.some(f=>f.type==='hello'&&f.streaming===false&&f.messages?.some((m:any)=>m.text.includes('合成正文第3楼'))));
  await until(async()=>{const reply=await take(null,scope);return reply.status===200;});
  const oldFull=scope;scope=await status();assert.equal(scope.workspace,'primary');assert.notEqual(scope.lease,oldPrimary.lease);
  assert.equal((await call('/api/config',oldFull,'PUT',{userName:'LATE'})).status,409);
  assert.equal((await call('/api/config',oldPrimary,'PUT',{userName:'ABA'})).status,409);
  const returned=connect('/ws',scope);assert.equal((await hello(returned)).sessionId,rootId);
  const rootAfter=rootFiles();assert.deepEqual(rootAfter,[...rootBefore.keys()]);for(const [path,hash]of rootBefore)assert.equal(digest(path),hash);
  assert.deepEqual(savedFiles(),savedBefore,'takeover must not manufacture a second session');
  const list=await(await call('/api/play-slots')).json() as any;const currentSlot=list.slots.find((s:any)=>s.id===slot.id);assert.notEqual(currentSlot.lease,slot.lease);
  const staleCompact=connect(`/api/play-slots/${slot.id}/ws?slotLease=${slot.lease}`);await until(()=>staleCompact.ws.readyState===WebSocket.CLOSED);assert.deepEqual(staleCompact.frames,[]);
  compact=connect(`/api/play-slots/${slot.id}/ws?slotLease=${currentSlot.lease}`);const back=await hello(compact);assert.equal(back.sessionId,first.sessionId);assert.ok(back.messages.some((m:any)=>m.text.includes('合成正文第3楼')));
  const count=fixture.calls;send(compact,first.sessionId,'合成主窗口第二楼',secondId);await until(()=>compact.frames.some(f=>f.type==='prompt_ack'&&f.messageId===secondId));assert.equal(fixture.calls,count,'ACK retry must not generate a duplicate floor');
  send(compact,first.sessionId,'合成并行第三楼');await until(()=>compact.frames.some(f=>f.type==='hello'&&f.streaming===false&&f.messages?.some((m:any)=>m.text.includes('合成正文第4楼'))));
  await until(async()=> (await take(slot.id,scope)).status===200);const beforeRestart=await status();
  for(const socket of sockets)socket.terminate();await fixture.stop();await fixture.start();
  scope=await status();assert.equal(scope.workspace,slot.id);assert.notEqual(scope.lease,beforeRestart.lease);
  const oldTab=connect('/ws',beforeRestart);await until(()=>oldTab.ws.readyState===WebSocket.CLOSED);assert.deepEqual(oldTab.frames,[]);
  const restored=connect('/ws',scope),restoredSecond=connect('/ws',scope);const [restoredHello,restoredSecondHello]=await Promise.all([hello(restored),hello(restoredSecond)]);assert.equal(restoredSecondHello.sessionId,first.sessionId);assert.equal(restoredHello.sessionId,first.sessionId);assert.ok(restoredHello.messages.some((m:any)=>m.text.includes('合成正文第4楼')));
  assert.deepEqual(sentinels.map(path=>digest(join(work,path))),hashes);assert.equal(fixture.writers,4);
  assert.equal((await take(null,scope)).status,200);const rootRestored=connect('/ws',await status());const finalRoot=await hello(rootRestored);assert.equal(finalRoot.sessionId,rootId);assert.ok(finalRoot.messages.some((m:any)=>m.text.includes('合成正文第1楼')));assert.equal(fixture.writers,4);
 }finally{for(const ws of sockets)ws.terminate();await fixture.close();}
});

test('paused/legacy ownership metadata is read without rewriting; corrupted/missing/symlink selections fail closed',async()=>{
 const {PlaySlots}=await import('../server/play-slots.ts');
 const {mkdtempSync,rmSync,symlinkSync,statSync}=await import('node:fs');
 const {tmpdir}=await import('node:os');
 const cwd=mkdtempSync(join(tmpdir(),'liyuan-workspace-meta-'));
 const id=randomUUID(),root=join(cwd,'.liyuan/play-slots');
 const host={cardFile:()=>{throw Error('not creating');},snapshot:()=>({config:{},agent:{}}),authorized:()=>true};
 try{
  mkdirSync(join(root,id),{recursive:true});writeFileSync(join(root,id,'meta.json'),JSON.stringify({version:1,id,name:'合成旧卡位',createdAt:new Date(0).toISOString()}));
  const file=join(root,'main-window.json');writeFileSync(file,JSON.stringify({version:1,id}),{mode:0o600});const hash=digest(file);
  const slots=new PlaySlots(cwd,host);assert.equal(slots.mainWorkspace,id);assert.equal(slots.list()[0].state,'paused');assert.equal(slots.list()[0].owner,'main');assert.equal(digest(file),hash);if(process.platform!=='win32')assert.equal(statSync(file).mode&0o777,0o600);slots.close();
  for(const record of [{version:1,id:'../../outside'},{version:1,id:randomUUID()},{version:2,id},{version:1,id,lease:'<script>'}]){writeFileSync(file,JSON.stringify(record));assert.throws(()=>new PlaySlots(cwd,host));}
  writeFileSync(file,'{"broken":');assert.throws(()=>new PlaySlots(cwd,host));
  if(process.platform!=='win32'){const target=join(cwd,'pointer.json');writeFileSync(target,JSON.stringify({version:1,id:null}));rmSync(file);symlinkSync(target,file);assert.throws(()=>new PlaySlots(cwd,host));assert.equal(JSON.parse(readFileSync(target,'utf8')).id,null);}
 }finally{rmSync(cwd,{recursive:true,force:true});}
});

test('main takeover refuses an in-flight upload and a running independent assistant; late controls cannot race handoff (synthetic)',{timeout:70_000},async()=>{
 const fixture=await workspaceFixture();const sockets:WebSocket[]=[];
 try{
  const {request}=await import('node:http');
  const get=async()=>await(await fetch(fixture.base+'/api/play-slots/main',{headers:{cookie:fixture.cookie}})).json() as any;
  const take=async(id:string|null,scope:any)=>fetch(fixture.base+'/api/play-slots/main',{method:'POST',headers:{cookie:fixture.cookie,'content-type':'application/json'},body:JSON.stringify({id,expectedWorkspace:scope.workspace,expectedLease:scope.lease})});
  const initial=await get();const response=await fetch(fixture.base+'/api/play-slots',{method:'POST',headers:{cookie:fixture.cookie,'content-type':'application/json'},body:JSON.stringify({card:'cards/Independent.json'})});const slot=(await response.json() as any).slot;
  let uploaded!:()=>void;const uploadDone=new Promise<void>(ok=>{uploaded=ok;});
  const upload=request(fixture.base+'/api/upload?name=synthetic.txt',{method:'POST',headers:{cookie:fixture.cookie,'x-liyuan-workspace':initial.workspace,'x-liyuan-workspace-lease':initial.lease,'content-type':'application/octet-stream','content-length':'12'}},res=>{res.resume();res.once('end',uploaded);});upload.on('error',uploaded);upload.write('synthetic');
  await new Promise(ok=>setTimeout(ok,150));assert.equal((await take(slot.id,initial)).status,409);upload.end('123');await uploadDone;
  assert.equal((await take(slot.id,initial)).status,200);const scope=await get();
  const ws=new WebSocket(fixture.base.replace('http:','ws:')+`/ws?liyuanWorkspace=${scope.workspace}&liyuanLease=${scope.lease}`,{headers:{cookie:fixture.cookie}});sockets.push(ws);const frames:any[]=[];ws.on('message',raw=>frames.push(JSON.parse(raw.toString())));ws.on('error',()=>{});
  await until(()=>frames.some(f=>f.type==='assistant_hello'));const assistant=frames.find(f=>f.type==='assistant_hello');assert.ok(assistant.sessionId);
  fixture.hold();ws.send(JSON.stringify({type:'assistant_prompt',text:'合成助手忙碌请求',sessionId:assistant.sessionId,messageId:randomUUID()}));await until(()=>fixture.writers===1);
  assert.equal((await take(null,scope)).status,409,'assistant must be included, not just story streaming');
  ws.send(JSON.stringify({type:'assistant_abort'}));fixture.release();
  await until(async()=> (await take(null,scope)).status===200);
  const returned=await get();assert.equal(returned.workspace,'primary');assert.notEqual(returned.lease,initial.lease);
 }finally{fixture.release();for(const ws of sockets)ws.terminate();await fixture.close();}
});

test('zero-floor card and original main window keep canonical session IDs through pause, takeover and restart without any model call',{timeout:60_000},async()=>{
 const fixture=await workspaceFixture(),sockets:WebSocket[]=[];
 try{
  const request=async(path:string,body?:unknown)=>{const response=await fetch(fixture.base+path,{method:body===undefined?'GET':'POST',headers:{cookie:fixture.cookie,'content-type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});assert.ok(response.ok,path+': '+await response.clone().text());return await response.json() as any;};
  const view=async(path:string)=>{const ws=new WebSocket(fixture.base.replace('http:','ws:')+path,{headers:{cookie:fixture.cookie}});sockets.push(ws);ws.on('error',()=>{});const frames:any[]=[];ws.on('message',b=>frames.push(JSON.parse(b.toString())));await until(()=>frames.some(f=>f.type==='hello'));return frames.find(f=>f.type==='hello');};
  const initial=await request('/api/play-slots/main'),root=await view(`/ws?liyuanWorkspace=primary&liyuanLease=${initial.lease}`);
  const slot=(await request('/api/play-slots',{card:'cards/Independent.json'})).slot;
  const first=await view(`/api/play-slots/${slot.id}/ws?slotLease=${slot.lease}`);assert.equal(first.messages.filter((m:any)=>m.channel==='user'||m.channel==='narrative').length,0);
  await request(`/api/play-slots/${slot.id}/pause`,{});await request(`/api/play-slots/${slot.id}/start`,{});
  const resumed=await view(`/api/play-slots/${slot.id}/ws?slotLease=${slot.lease}`);assert.equal(resumed.sessionId,first.sessionId,'a deliberately created zero-floor slot is a save, not disposable SDK scratch');
  await request('/api/play-slots/main',{id:slot.id,expectedWorkspace:initial.workspace,expectedLease:initial.lease});
  for(const ws of sockets)ws.terminate();await fixture.stop();await fixture.start();
  const taken=await request('/api/play-slots/main'),current=await view(`/ws?liyuanWorkspace=${taken.workspace}&liyuanLease=${taken.lease}`);assert.equal(current.sessionId,first.sessionId);
  await request('/api/play-slots/main',{id:null,expectedWorkspace:taken.workspace,expectedLease:taken.lease});const back=await request('/api/play-slots/main'),original=await view(`/ws?liyuanWorkspace=primary&liyuanLease=${back.lease}`);assert.equal(original.sessionId,root.sessionId,'taking over an empty main window must persist its original identity too');assert.equal(fixture.calls,0);
 }finally{for(const ws of sockets)ws.terminate();await fixture.close();}
});
