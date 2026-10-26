/** Synthetic original-resource transport, real browser import resolution; no CDN aliases in Playwright. */
import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:http';
import {readFileSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {chromium} from 'playwright';
import {WORKSPACE_BOOTSTRAP} from '../../server/workspace-bootstrap.ts';
const root=resolve(new URL('../..',import.meta.url).pathname),moduleSource=readFileSync(join(root,'web/public/tavern-compat/native-resources.js'),'utf8');

test('fixed native resources work without a worker/CDN, preserve scripts, and isolate srcdoc/blob/nested frames by lease',{timeout:60000},async()=>{
 const requests=[],external=[],errors=[];let server,browser;
 const sources={
  '/tavern-compat/vendor/entry.js':'import {number} from "/npm/shared@1/+esm";export const ability=number+10;',
  '/tavern-compat/vendor/shared.js':'export const number=27;',
  '/tavern-compat/vendor/classic.js':'window.syntheticClassic=(window.syntheticClassic||0)+1;',
 };
 const leases={primary:'a'.repeat(32),'11111111-1111-4111-8111-111111111111':'b'.repeat(32)};
 try{
  server=createServer((req,res)=>{const url=new URL(req.url,'http://127.0.0.1');
   if(url.pathname==='/broken-legacy-worker.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(`self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{if(new URL(e.request.url).origin!==location.origin)e.respondWith(Promise.reject(Error('SYNTHETIC_OLD_WORKER_MISSING_LEASE')));});`);return;}
   if(url.pathname==='/native-resources.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(moduleSource);return;}
   if(url.pathname==='/workspace-scope.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(WORKSPACE_BOOTSTRAP);return;}
   if(sources[url.pathname]||url.pathname==='/api/context'){
    const workspace=req.headers['x-liyuan-workspace']??url.searchParams.get('liyuanWorkspace'),lease=req.headers['x-liyuan-workspace-lease']??url.searchParams.get('liyuanLease');requests.push({path:url.pathname,workspace,lease});
    if(leases[workspace]!==lease){res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({code:'workspace_changed',error:'SYNTHETIC_STALE_LEASE'}));return;}
    res.writeHead(200,{'content-type':url.pathname==='/api/context'?'application/json':'text/javascript'});res.end(sources[url.pathname]??JSON.stringify({workspace}));return;
   }
   res.writeHead(200,{'content-type':'text/html'});res.end('<html><head></head><body><div id="mount"></div></body></html>');
  });await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const base=`http://127.0.0.1:${server.address().port}`;
  const exe=process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE,libs=process.env.LIYUAN_DATABASE_BROWSER_LIBS??process.env.LD_LIBRARY_PATH;
  browser=await chromium.launch({headless:true,...(exe?{executablePath:exe}:{}),env:{...process.env,...(libs?{LD_LIBRARY_PATH:libs}:{})},args:['--no-sandbox']});
  const context=await browser.newContext({serviceWorkers:'allow'});await context.route('**/*',route=>{if(new URL(route.request().url()).origin===base)return route.continue();external.push(route.request().url());return route.abort();});
  const assets={'https://cdn.synthetic.invalid/npm/widget@1/+esm':'/tavern-compat/vendor/entry.js','https://cdn.synthetic.invalid/npm/shared@1/+esm':'/tavern-compat/vendor/shared.js','https://cdn.synthetic.invalid/vue.min.js':'/tavern-compat/vendor/classic.js'};
  const authored='import {ability} from "https://cdn.synthetic.invalid/npm/widget@1/+esm";import {number} from "synthetic-alias";document.getElementById("score").textContent=String(ability);document.getElementById("relationship").textContent="SYNTHETIC_RELATION="+number;document.getElementById("tab").onclick=()=>{document.getElementById("relationship").hidden=false;};';
  const html='<!doctype html><html><head><script type="importmap">'+JSON.stringify({imports:{'synthetic-alias':'https://cdn.synthetic.invalid/npm/shared@1/+esm'}})+'</script><script src="https://cdn.synthetic.invalid/vue.min.js"></script></head><body><button id="tab">Relationship</button><div id="score">pending</div><div id="relationship" hidden></div><script id="authored" type="module">'+authored+'</script></body></html>';
  const pages=[];
  for(const workspace of Object.keys(leases)){
   const page=await context.newPage();pages.push(page);page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await page.evaluate(async()=>{await navigator.serviceWorker.register('/broken-legacy-worker.js',{scope:'/'});});await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
   await page.evaluate(async config=>{const{installNativeResources}=await import('/native-resources.js');installNativeResources(config);},{origin:base,assets,workspace,lease:leases[workspace]});
   for(const mode of ['property','attribute','blob']){
    await page.evaluate(async({html,mode})=>{document.getElementById('mount').replaceChildren();const iframe=document.createElement('iframe');iframe.id='native';if(mode==='blob'){const blob=new Blob([html],{type:'text/html'});if(await blob.text()!==html)throw Error('HTML exports/Blob bytes were rewritten');iframe.src=URL.createObjectURL(blob);}else if(mode==='attribute')iframe.setAttribute('srcdoc',html);else iframe.srcdoc=html;document.getElementById('mount').append(iframe);},{html,mode});
    const frame=page.frameLocator('#native');await frame.locator('#score').filter({hasText:'37'}).waitFor();assert.equal(await frame.locator('#authored').textContent(),authored,'upstream/card script bytes are unchanged');
    for(const width of [1440,390,320]){await page.setViewportSize({width,height:900});await frame.locator('#tab').click();assert.equal(await frame.locator('#relationship').innerText(),'SYNTHETIC_RELATION=27');}
    const active=page.frames().find(f=>f!==page.mainFrame());assert.equal(await active.evaluate(()=>syntheticClassic),1);
    assert.deepEqual(await active.evaluate(async()=>await(await fetch('/api/context')).json()),{workspace});
    await active.evaluate(()=>{const script=document.createElement('script');script.src='https://cdn.synthetic.invalid/vue.min.js';document.head.append(script);});await active.waitForFunction(()=>syntheticClassic===2);
    await active.evaluate(html=>{const nested=document.createElement('iframe');nested.id='nested';nested.srcdoc=html;document.body.append(nested);},html);await frame.frameLocator('#nested').locator('#score').filter({hasText:'37'}).waitFor();
   }
  }
  assert.deepEqual(external,[]);assert.deepEqual(errors,[]);assert.ok(requests.every(r=>r.lease===leases[r.workspace]));
  const original=leases.primary;leases.primary='c'.repeat(32);
  const stale=await pages[0].frames().find(f=>f!==pages[0].mainFrame()).evaluate(async()=>{const r=await fetch('/api/context');return{status:r.status,body:await r.json()};});assert.equal(stale.status,409);assert.equal(stale.body.code,'workspace_changed');assert.ok(requests.at(-1).lease===original,'old iframe never adopts another window lease');
  // These adapters must not widen the resource origin or admit malformed leases.
  const invalid=await context.newPage();await invalid.goto(base);await assert.rejects(()=>invalid.evaluate(async base=>{const{installNativeResources}=await import('/native-resources.js');installNativeResources({origin:base,assets:{'https://cdn.synthetic.invalid/test.js':'https://other.invalid/steal.js'}});},base),/映射越界/);
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(ok=>server.close(ok));}}
});

test('upgrading the legacy worker removes its unscoped shared asset-map fetch',{timeout:45000},async()=>{
 let server,browser,current=false,mapReads=0;const requests=[];
 const retired=readFileSync(join(root,'web/public/tavern-plugin-sw.js'),'utf8');
 try{
  server=createServer((req,res)=>{
   const url=new URL(req.url,'http://localhost');requests.push(url.pathname);
   if(url.pathname==='/tavern-plugin-sw.js'){res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});res.end(current?retired:`self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(self.clients.claim()));self.addEventListener('fetch',e=>{if(new URL(e.request.url).hostname!=='testingcf.jsdelivr.net')return;e.respondWith(fetch('/api/tavern-plugins/asset-map').then(r=>{if(!r.ok)throw Error('SYNTHETIC_MISSING_WORKSPACE');return fetch(e.request);}));});`);return;}
   if(url.pathname==='/api/tavern-plugins/asset-map'){mapReads++;res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({code:'workspace_changed'}));return;}
   res.writeHead(200,{'content-type':'text/html'});res.end('<html><body>SYNTHETIC HOST</body></html>');
  });await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,executablePath:process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE,env:{...process.env,LD_LIBRARY_PATH:process.env.LIYUAN_DATABASE_BROWSER_LIBS??process.env.LD_LIBRARY_PATH},args:['--no-sandbox']});
  const bc=await browser.newContext({serviceWorkers:'allow'});await bc.route('https://testingcf.jsdelivr.net/synthetic-cosmetic.css*',route=>route.fulfill({body:'SYNTHETIC COSMETIC',contentType:'text/css',headers:{'access-control-allow-origin':'*'}}));
  const page=await bc.newPage();await page.goto(base+'/tavern-plugin-host.html');await page.evaluate(()=>navigator.serviceWorker.register('/tavern-plugin-sw.js',{scope:'/tavern-plugin-host.html'}));await page.waitForFunction(()=>!!navigator.serviceWorker.controller);
  assert.equal(await page.evaluate(()=>fetch('https://testingcf.jsdelivr.net/synthetic-cosmetic.css?legacy').then(()=>true,()=>false)),false);assert.equal(mapReads,1,'negative control reproduces the missing-lease request');
  current=true;await page.evaluate(async()=>{const changed=new Promise(resolve=>navigator.serviceWorker.addEventListener('controllerchange',resolve,{once:true}));await(await navigator.serviceWorker.getRegistration('/tavern-plugin-host.html')).update();await changed;});
  assert.equal(await page.evaluate(()=>fetch('https://testingcf.jsdelivr.net/synthetic-cosmetic.css?current').then(r=>r.text())),'SYNTHETIC COSMETIC');assert.equal(mapReads,1,'updated worker never requests a workspace API');
  assert.ok(requests.every(path=>path==='/api/tavern-plugins/asset-map'||path==='/tavern-plugin-host.html'||path==='/tavern-plugin-sw.js'||path==='/favicon.ico'));
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(ok=>server.close(ok));}}
});
