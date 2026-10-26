import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request, type Server } from 'node:http';
import WebSocket from 'ws';
import { PlaySlots } from '../server/play-slots.ts';
import { isSameOriginRequest } from '../server/http-security.ts';

async function listen(server: Server): Promise<number> {
 await new Promise<void>(ok => server.listen(0,'127.0.0.1',ok));
 return (server.address() as {port:number}).port;
}
function post(port:number,origin:string,headers:Record<string,string>={}) {
 return new Promise<{http:number;body:any}>((ok,fail)=>{
  const body=JSON.stringify({card:'cards/synthetic.json'});
  const req=request({host:'127.0.0.1',port,path:'/api/play-slots',method:'POST',headers:{cookie:'fixture-parent=allowed',origin,'sec-fetch-site':'same-origin','content-type':'application/json','content-length':Buffer.byteLength(body),...headers}},res=>{
   let text='';res.on('data',b=>text+=b);res.on('end',()=>ok({http:res.statusCode!,body:JSON.parse(text)}));
  });req.on('error',fail);req.setTimeout(35000,()=>req.destroy(Error('synthetic proxy request timeout')));req.end(body);
 });
}

test('non-default TLS-terminated authority: preserved Host creates a real isolated slot and opens WS; stripped port and foreign origins fail', {timeout:60000},async()=>{
 const cwd=mkdtempSync(join(tmpdir(),'liyuan-proxy-slot-'));let gateway:Server|undefined,proxy:Server|undefined,supervisor:PlaySlots|undefined;
 let preserve=false;const clients:WebSocket[]=[],upgrades=new Set<import('node:stream').Duplex>();
 try{
  mkdirSync(join(cwd,'cards'));writeFileSync(join(cwd,'cards/synthetic.json'),JSON.stringify({data:{name:'合成反向代理卡',first_mes:'仅验证独立卡位启动，不发送剧情。'}}));
  const config={card:'cards/synthetic.json',userName:'合成用户',generationMode:'direct',greeting:false,literaryWorldEnabled:false,literaryEcologyEnabled:false,novelDigest:{enabled:false},researchSearchSchedule:{enabled:false}};
  const agent={version:1,defaultProvider:'fixture',defaultModel:'writer',providers:{fixture:{baseUrl:'http://127.0.0.1:9/v1',api:'openai-completions',apiKey:'synthetic-not-real',models:[{id:'writer'}]}}};
  supervisor=new PlaySlots(cwd,{cardFile:card=>{assert.equal(card,'cards/synthetic.json');return{file:join(cwd,card),name:'合成反向代理卡'};},snapshot:()=>({config,agent}),authorized:req=>req.headers.cookie==='fixture-parent=allowed'});
  gateway=createServer((req,res)=>{if(!isSameOriginRequest(req)){res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({error:'不允许跨站访问管理接口'}));return;}void supervisor!.handle(req,res).then(handled=>{if(!handled){res.writeHead(404);res.end();}});});
  gateway.on('upgrade',(req,socket,head)=>{if(!supervisor!.handleUpgrade(req,socket,head))socket.destroy();});
  const port=await listen(gateway);
  const forwardedHost=(host:string)=>preserve?host:new URL('https://'+host).hostname;
  proxy=createServer((req,res)=>{const upstream=request({host:'127.0.0.1',port,path:req.url,method:req.method,headers:{...req.headers,host:forwardedHost(req.headers.host!)}},reply=>{res.writeHead(reply.statusCode!,reply.headers);reply.pipe(res);});upstream.on('error',()=>{res.writeHead(502);res.end();});req.pipe(upstream);});
  proxy.on('upgrade',(req,socket,head)=>{
   const upstream=request({host:'127.0.0.1',port,path:req.url,headers:{...req.headers,host:forwardedHost(req.headers.host!)}});
   upstream.on('upgrade',(reply,target,rest)=>{
    const raw=Object.entries(reply.headers).map(([k,v])=>`${k}: ${Array.isArray(v)?v.join(', '):v}`).join('\r\n');socket.write(`HTTP/1.1 ${reply.statusCode} ${reply.statusMessage}\r\n${raw}\r\n\r\n`);
    if(rest.length)socket.write(rest);if(head.length)target.write(head);upgrades.add(target);upgrades.add(socket);socket.pipe(target).pipe(socket);
    target.on('close',()=>{upgrades.delete(target);socket.destroy();});socket.on('close',()=>{upgrades.delete(socket);target.destroy();});
   });upstream.on('response',reply=>{reply.resume();socket.end(`HTTP/1.1 ${reply.statusCode} Forbidden\r\nConnection: close\r\n\r\n`);});upstream.on('error',()=>socket.destroy());upstream.end();
  });
  const externalPort=await listen(proxy),origin=`https://127.0.0.1:${externalPort}`;
  const denied=await post(externalPort,origin);assert.equal(denied.http,403);assert.match(denied.body.error,/跨站/);assert.equal(supervisor.list().length,0);
  const template=readFileSync(new URL('../deploy/nginx-8788.conf',import.meta.url),'utf8');assert.match(template,/proxy_set_header\s+Host\s+\$http_host\s*;/);preserve=true;
  const created=await post(externalPort,origin);assert.equal(created.http,201,JSON.stringify(created.body));assert.equal(created.body.slot.state,'running');assert.equal(supervisor.list().length,1);
  const id=created.body.slot.id;
  const socket=(originHeader:string,expectHello:boolean)=>new Promise<void>((ok,fail)=>{
   const ws=new WebSocket(`ws://127.0.0.1:${externalPort}/api/play-slots/${id}/ws`,{headers:{cookie:'fixture-parent=allowed',origin:originHeader}});clients.push(ws);let done=false;
   const timer=setTimeout(()=>{ws.terminate();fail(Error('synthetic proxy WS timeout'));},5000);const finish=()=>{if(done)return;done=true;clearTimeout(timer);ws.terminate();ok();};
   ws.on('message',raw=>{const frame=JSON.parse(String(raw));if(frame.type==='hello'){assert.ok(expectHello);assert.ok(frame.sessionId);finish();}});
   ws.on('unexpected-response',(_req,res)=>{res.resume();assert.equal(expectHello,false);assert.equal(res.statusCode,403);finish();});ws.on('error',error=>{if(!done){clearTimeout(timer);fail(error);}});
  });
  await socket(origin,true);await socket('https://foreign.invalid',false);
  for(const [badOrigin,headers]of [['https://foreign.invalid',{}],[origin,{'sec-fetch-site':'cross-site'}],[origin.replace(/:\d+$/,':1'),{}]]as Array<[string,Record<string,string>]>)assert.equal((await post(externalPort,badOrigin,headers)).http,403);
  assert.equal((await post(externalPort,origin,{cookie:'fixture-parent=denied'})).http,403);assert.equal(supervisor.list().length,1);
  for(const ws of clients)ws.terminate();for(const socket of upgrades)socket.destroy();await supervisor.pause(id);assert.equal(supervisor.list()[0].state,'paused');
 }finally{
  for(const ws of clients)ws.terminate();for(const socket of upgrades)socket.destroy();supervisor?.close();
  if(proxy)await new Promise<void>(ok=>proxy!.close(()=>ok()));if(gateway)await new Promise<void>(ok=>gateway!.close(()=>ok()));rmSync(cwd,{recursive:true,force:true});
 }
});
