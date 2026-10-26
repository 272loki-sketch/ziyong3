import assert from 'node:assert/strict';
import {createServer,type Server} from 'node:http';
import test from 'node:test';
import {proxyWorkspaceHttp} from '../server/main-workspace.ts';
import {ACCESS_COOKIE} from '../src/access.ts';
const context={workspace:'primary',lease:'a'.repeat(32)};
async function listen(server:Server){await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));return(server.address() as{port:number}).port;}
async function close(server:Server){server.closeAllConnections();await new Promise<void>(ok=>server.close(()=>ok()));}
test('workspace HTTP proxy streams SSE/binary, transforms only owned HTML, strips child credentials and hop-by-hop headers',{timeout:12_000},async()=>{
 let captured:any;let endStream=()=>{};const body=Buffer.from([0,255,128,13,10,35]);
 const upstream=createServer((req,res)=>{void(async()=>{
  const chunks=[];for await(const part of req)chunks.push(part);captured={headers:req.headers,url:req.url,body:Buffer.concat(chunks)};
  res.setHeader('set-cookie','private-child-secret=must-not-leak');
  res.setHeader('connection','x-private-hop');res.setHeader('x-private-hop','strip-me');
  if(req.url?.startsWith('/sse')){res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: first\n\n');endStream=()=>res.end('data: last\n\n');return;}
  if(req.url?.includes('.html')){res.writeHead(200,{'content-type':'text/html','content-length':Buffer.byteLength('<html><head></head><body>raw</body>')});res.end('<html><head></head><body>raw</body>');return;}
  res.writeHead(200,{'content-type':'application/octet-stream'});res.end(captured.body);
 })().catch(()=>res.destroy());});
 const port=await listen(upstream);
 const gateway=createServer((req,res)=>{void proxyWorkspaceHttp(req,res,{port,token:'synthetic-child-token'},()=>true,context);});const base='http://127.0.0.1:'+await listen(gateway);
 try{
  const response=await fetch(base+'/bytes',{method:'POST',headers:{cookie:'parent-secret=not-forwarded',authorization:'Bearer parent-secret',origin:'https://synthetic.invalid:8788','x-liyuan-workspace':'primary','x-liyuan-workspace-lease':context.lease},body});
  assert.deepEqual(Buffer.from(await response.arrayBuffer()),body);assert.equal(response.headers.has('set-cookie'),false);assert.equal(response.headers.has('x-private-hop'),false);assert.equal(captured.headers.authorization,undefined);assert.equal(captured.headers.cookie,`${ACCESS_COOKIE}=synthetic-child-token`);assert.equal(captured.headers['x-liyuan-workspace'],undefined);assert.equal(captured.headers.origin,'https://synthetic.invalid:8788');
  const html=await(await fetch(base+'/tavern-plugin-host.html')).text();assert.match(html,/workspace-scope.js/);assert.match(html,/raw/);
  const author=await(await fetch(base+'/not-owned.html')).text();assert.equal(author.includes('workspace-scope.js'),false);
  const sse=await fetch(base+'/sse');const reader=sse.body!.getReader();const first=await reader.read();assert.equal(new TextDecoder().decode(first.value),'data: first\n\n');assert.equal(first.done,false);endStream();let rest='';for(;;){const part=await reader.read();if(part.done)break;rest+=new TextDecoder().decode(part.value);}assert.equal(rest,'data: last\n\n');
 }finally{endStream();await close(gateway);await close(upstream);}
});
test('proxy cancellation drains; stale target or disconnected worker cannot fall back to a different story',{timeout:10_000},async()=>{
 let cancelled=false;
 const upstream=createServer((_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write('data: pinned\n\n');res.once('close',()=>{cancelled=true;});});const port=await listen(upstream);
 let current=true,active=0;
 const gateway=createServer((req,res)=>{active++;void proxyWorkspaceHttp(req,res,{port,token:'synthetic'},()=>current,context).finally(()=>active--);});const base='http://127.0.0.1:'+await listen(gateway);
 try{
  const controller=new AbortController();const response=await fetch(base+'/sse',{signal:controller.signal});await response.body!.getReader().read();controller.abort();
  for(let i=0;i<50&&(!cancelled||active);i++)await new Promise(ok=>setTimeout(ok,20));assert.equal(cancelled,true);assert.equal(active,0);
  current=false;const stale=await fetch(base+'/sse');assert.equal(stale.status,502);assert.match(await stale.text(),/存档保留/);
  await close(upstream);const gone=await fetch(base+'/sse');assert.equal(gone.status,502);assert.equal(active,0);
 }finally{await close(gateway);if(upstream.listening)await close(upstream);}
});
