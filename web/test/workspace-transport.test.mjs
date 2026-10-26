import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from '../node_modules/esbuild/lib/main.js';
import {chromium} from 'playwright';
import {mainWorkspaceHtml} from '../../server/main-workspace.ts';
import {WORKSPACE_BOOTSTRAP} from '../../server/workspace-bootstrap.ts';
const root=resolve(import.meta.dirname,'../..');
test('author same-origin srcdoc pins transport before its scripts; opaque frames remain opaque; no author bytes rewritten',{timeout:30_000},async()=>{
 const work=await mkdtemp(join(tmpdir(),'liyuan-workspace-frame-'));
 const context={workspace:'a1b2c3d4-1234-4567-890a-123456789abc',lease:'a'.repeat(32)};
 const author=`<!doctype html><html><head></head><body><button id="probe">合成原卡按钮</button><pre id="result"></pre><script>document.getElementById('probe').onclick=async()=>{document.getElementById('result').textContent=JSON.stringify(await(await fetch('/api/probe')).json())};</script></body></html>`;
 let server,browser;
 const calls=[],errors=[];
 try{
  await build({stdin:{contents:`import React from'react';import{createRoot}from'react-dom/client';import{HtmlFrame}from'./src/components/HtmlFrame.tsx';createRoot(document.getElementById('root')).render(<><HtmlFrame title="合成同源原卡" html={${JSON.stringify(author)}} scripts seamless/><HtmlFrame title="合成隔离工具" html="<p>opaque sandbox</p>" scripts/></>);`,resolveDir:join(root,'web'),loader:'tsx'},bundle:true,jsx:'automatic',format:'esm',outfile:join(work,'fixture.js'),logLevel:'silent'});
  server=createServer((req,res)=>{void(async()=>{
   const path=new URL(req.url,'http://localhost').pathname;
   if(path==='/workspace-scope.js'){res.writeHead(200,{'content-type':'text/javascript'});return res.end(WORKSPACE_BOOTSTRAP);}
   if(path==='/fixture.js'){res.writeHead(200,{'content-type':'text/javascript'});return res.end(await readFile(join(work,'fixture.js')));}
   if(path==='/api/probe'){calls.push(req.headers);res.writeHead(200,{'content-type':'application/json'});return res.end(JSON.stringify({workspace:req.headers['x-liyuan-workspace'],lease:req.headers['x-liyuan-workspace-lease']}));}
   if(path==='/'){res.writeHead(200,{'content-type':'text/html'});return res.end(mainWorkspaceHtml('<html><head></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',context));}
   res.writeHead(404);res.end();
  })().catch(()=>res.destroy());});
  await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});const page=await browser.newPage();page.setDefaultTimeout(8000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);
  const owned=page.frameLocator('iframe[title="合成同源原卡"]');await owned.getByRole('button',{name:'合成原卡按钮'}).click();await owned.locator('#result').filter({hasText:context.workspace}).waitFor();assert.equal(calls.length,1);assert.equal(calls[0]['x-liyuan-workspace'],context.workspace);assert.equal(calls[0]['x-liyuan-workspace-lease'],context.lease);
  const parentScope=await page.frames().find(frame=>frame.url()==='about:srcdoc').evaluate(async()=>{const request=new Request(parent.location.origin+'/api/probe',{headers:{'x-synthetic-user-header':'preserved'}});return await(await parent.fetch(request)).json();});assert.deepEqual(parentScope,context);assert.equal(calls[1]['x-synthetic-user-header'],'preserved');
  const source=await page.locator('iframe[title="合成同源原卡"]').getAttribute('srcdoc');assert.ok(source.includes(author.slice(author.indexOf('<button'),author.indexOf('</body>'))));assert.ok(source.indexOf('/workspace-scope.js')<source.indexOf("document.getElementById('probe').onclick"));
  const opaque=page.locator('iframe[title="合成隔离工具"]');assert.equal((await opaque.getAttribute('sandbox')).includes('allow-same-origin'),false);assert.equal((await opaque.getAttribute('srcdoc')).includes('workspace-scope.js'),false);
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();if(server){server.closeAllConnections();await new Promise(ok=>server.close(ok));}await rm(work,{recursive:true,force:true});}
});
