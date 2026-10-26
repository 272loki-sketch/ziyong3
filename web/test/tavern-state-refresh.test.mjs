import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {build} from '../node_modules/esbuild/lib/main.js';
import {chromium} from '../../node_modules/playwright/index.mjs';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');

test('saved-turn refresh reaches only its existing native realm, including a notification before ready',{timeout:45000},async()=>{
 const dir=await mkdtemp(join(tmpdir(),'liyuan-native-refresh-'));let browser,server,reads=0,value=37;const mutations=[];
 try{
  const source=`import React from 'react';import{createRoot}from'react-dom/client';import{TavernMessageFrame,TavernEntryContext}from'${join(root,'web/src/components/TavernMessageFrame.tsx')}';createRoot(document.getElementById('root')).render(<TavernEntryContext.Provider value={{entryId:'reply',entryScope:'synthetic-scope'}}><TavernMessageFrame html="<p>SYNTHETIC UI</p>"><div>STATIC</div></TavernMessageFrame></TavernEntryContext.Provider>);`;
  await build({stdin:{contents:source,resolveDir:join(root,'web'),sourcefile:'synthetic-refresh.tsx',loader:'tsx'},bundle:true,format:'esm',jsx:'automatic',outfile:join(dir,'app.js'),logLevel:'silent'});
  server=createServer((req,res)=>{void(async()=>{
   const url=new URL(req.url,'http://localhost');if(!['GET','HEAD'].includes(req.method))mutations.push(req.method+' '+url.pathname);
   if(url.pathname==='/app.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(await readFile(join(dir,'app.js')));return;}
   if(url.pathname==='/api/tavern-plugins/status'){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({runtimeEnabled:true,plugins:[{id:'helper',enabled:true,installed:true,version:'synthetic'}]}));return;}
   if(url.pathname==='/snapshot'){reads++;res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({value}));return;}
   if(url.pathname==='/tavern-plugin-host.html'){
    res.writeHead(200,{'content-type':'text/html'});res.end(`<html><body><div id="value">UNINITIALIZED</div><button id="tab">Relationship</button><section id="relation" hidden>CLASSMATE</section><script>
     window.renders=0;window.instance=Math.random();
     const refresh=async()=>{document.getElementById('value').textContent=(await(await fetch('/snapshot')).json()).value;};
     addEventListener('message',event=>{if(event.source!==parent||event.origin!==location.origin)return;if(event.data?.type==='liyuan-tavern-render'){renders++;void refresh();}if(event.data?.type==='liyuan-tavern-refresh-state'){const result={entryId:event.data.entryId,entryScope:event.data.entryScope,requestId:event.data.requestId};if(window.failOnce){window.failOnce=false;parent.postMessage({type:'liyuan-tavern-state-refresh-error',...result,error:'SYNTHETIC SNAPSHOT UNAVAILABLE'},location.origin);}else void refresh().then(()=>parent.postMessage({type:'liyuan-tavern-state-refreshed',...result},location.origin));}});
     document.getElementById('tab').onclick=()=>document.getElementById('relation').hidden=false;
     setTimeout(()=>parent.postMessage({type:'liyuan-tavern-ready'},location.origin),250);
    </script></body></html>`);return;
   }
   res.writeHead(200,{'content-type':'text/html'});res.end('<html><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
  })().catch(e=>{res.writeHead(500);res.end(e.message);});});
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,executablePath:process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE,env:{...process.env,LD_LIBRARY_PATH:process.env.LIYUAN_DATABASE_BROWSER_LIBS??process.env.LD_LIBRARY_PATH},args:['--no-sandbox']});const page=await browser.newPage({serviceWorkers:'block'});page.setDefaultTimeout(4000);
  const notify=detail=>page.evaluate(detail=>window.dispatchEvent(new CustomEvent('liyuan:turn-state-refreshed',{detail})),detail);
  await page.goto(base);const frame=()=>page.frameLocator('iframe[title="原酒馆插件交互显示"]');await frame().locator('#value').filter({hasText:'37'}).waitFor();
  const realm=page.frames().find(f=>f.parentFrame()),instance=await realm.evaluate(()=>window.instance);
  await frame().locator('#tab').click();const initial=reads;
  await notify({entryId:'other',entryScope:'synthetic-scope'});await notify({entryId:'reply',entryScope:'other-scope'});await page.waitForTimeout(100);assert.equal(reads,initial,'foreign sources cannot refresh this frame');
  value=81;await notify({entryId:'reply',entryScope:'synthetic-scope'});await frame().locator('#value').filter({hasText:'81'}).waitFor();
  assert.equal(await realm.evaluate(()=>window.instance),instance);assert.equal(await realm.evaluate(()=>window.renders),1,'refresh is not HTML redelivery/script execution');assert.equal(await frame().locator('#relation').isVisible(),true,'current native UI selection survives');
  value=82;await realm.evaluate(()=>window.failOnce=true);await notify({entryId:'reply',entryScope:'synthetic-scope'});const failure=page.getByRole('status').filter({hasText:'SYNTHETIC SNAPSHOT UNAVAILABLE'});await failure.waitFor();assert.equal(await realm.evaluate(()=>window.instance),instance,'read failure does not unmount the existing UI');await failure.getByRole('button',{name:'重试变量显示刷新'}).click();await frame().locator('#value').filter({hasText:'82'}).waitFor();await failure.waitFor({state:'hidden'});assert.equal(await realm.evaluate(()=>window.renders),1);
  // The completed-state signal can race the initial native ready handshake.
  await page.reload();await page.locator('iframe').waitFor();await notify({entryId:'reply',entryScope:'synthetic-scope'});const before=reads;await frame().locator('#value').filter({hasText:'82'}).waitFor();await page.waitForFunction(()=>document.querySelector('iframe')?.contentWindow?.renders===1);await page.waitForTimeout(100);assert.ok(reads>=before+2,'queued notification is delivered after ready');assert.deepEqual(mutations,[]);
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(ok=>server.close(ok));}await rm(dir,{recursive:true,force:true});}
});
