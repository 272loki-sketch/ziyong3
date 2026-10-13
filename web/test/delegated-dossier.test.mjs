// Synthetic Bubble + original-like static skin only. No private fixtures or plugin runtimes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {build} from '../node_modules/esbuild/lib/main.js';
import {chromium} from 'playwright';
import {parse} from 'yaml';

const root=resolve(new URL('../..',import.meta.url).pathname);
const prose='Synthetic canonical story. The lantern remained beside the gate.';
const snapshot={hero:{level:'synthetic',progress:0},world:{time:'synthetic midnight',unchanged:'Keep the complete saved hierarchy.'},relations:{friend:{affinity:42}},escaped:'<img src=x> is text, not an image.'};
const protocol='<Analysis>Synthetic analysis</Analysis>\n<JSONPatch>[{"op":"delta","path":"/relations/friend/affinity","value":2}]</JSONPatch>';
const template='\n```html\n<!doctype html><html><head></head><body><div class="cxtd-box"><details><summary class="cxtd-head">Synthetic original dossier</summary><div class="cxtd-body">$1</div></details></div><style>.cxtd-box{max-width:650px;margin:18px auto;border:1px solid gold;border-radius:12px;background:#0c101d;overflow:hidden}.cxtd-head{padding:12px 20px;color:gold;cursor:pointer}.cxtd-body{padding:16px 20px;max-height:400px;overflow-y:auto;font-size:12px;line-height:1.85;white-space:pre-wrap;color:#d9cba4}</style></body></html>\n```\n';
const skin={rules:[{name:'Synthetic original UpdateVariable skin',source:'<UpdateVariable>\\s*([\\s\\S]*?)\\s*</UpdateVariable>',flags:'g',replace:template}],charName:'Synthetic card',userName:'Synthetic user'};
const message={id:'synthetic-message',channel:'narrative',text:prose,generationMode:'direct',entryId:'saved-entry',entryScope:'saved-scope'};
const context=()=>({scopeKey:'saved-scope',sourceEntryId:'other-entry',visibleEntryIds:['saved-entry','other-entry'],mvu:{enabled:true},plugins:[{id:'helper',enabled:true}],chat:[{__liyuanEntryId:'saved-entry',is_user:false,swipe_id:0}],state:{extensionSettings:{mvu_settings:{更新方式:'额外模型解析'}},messages:{'saved-entry':{variables:[{stat_data:structuredClone(snapshot)}]},'other-entry':{variables:[{stat_data:{wrong:'Never use latest state'}}]}}}});

test('delegated dossier: Bubble eligibility, exact saved state, static original shell, refresh and 390px', {timeout:60_000}, async t=>{
 let browser,server,response=context(),fixture={msg:message,skin,readOnly:false};
 const requests=[],blocked=[],errors=[];
 const bundle=await build({stdin:{contents:`import React from 'react';import{createRoot}from'react-dom/client';import{Bubble,ReadOnlyMessagesContext}from'./src/components/Messages.tsx';const f=window.__fixture;createRoot(document.getElementById('root')).render(<ReadOnlyMessagesContext.Provider value={f.readOnly}><Bubble msg={f.msg} skin={f.skin} fallbackName="Synthetic card" onCopy={()=>{window.__copied=f.msg.text}}/></ReadOnlyMessagesContext.Provider>);`,resolveDir:join(root,'web'),loader:'tsx'},bundle:true,write:false,format:'esm',jsx:'automatic',loader:{'.css':'empty'},logLevel:'silent'});
 const css=await readFile(join(root,'web/src/app.css'),'utf8');
 try{
  server=createServer((req,res)=>{
   const path=new URL(req.url,'http://localhost').pathname;requests.push({method:req.method,path});
   if(req.method!=='GET'){res.writeHead(405);return res.end();}
   if(path==='/api/tavern-plugins/context'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});return res.end(JSON.stringify(response));}
   if(path==='/fixture.js'){res.writeHead(200,{'content-type':'text/javascript'});return res.end(bundle.outputFiles[0].text);}
   if(path==='/fixture.css'){res.writeHead(200,{'content-type':'text/css'});return res.end(css);}
   if(path==='/'){res.writeHead(200,{'content-type':'text/html'});return res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><main id="root" style="max-width:900px;margin:auto;padding:16px"></main><script>window.__fixture=${JSON.stringify(fixture).replace(/</g,'\\u003c')}</script><script type="module" src="/fixture.js"></script></body></html>`);}
   res.writeHead(404);res.end();
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const origin=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,...(process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE?{executablePath:process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE}:{}),env:{...process.env,LD_LIBRARY_PATH:process.env.LIYUAN_DATABASE_BROWSER_LIBS||process.env.LD_LIBRARY_PATH||''},args:['--no-sandbox']});
  const open=async()=>{
   const page=await browser.newPage({viewport:{width:1280,height:900},serviceWorkers:'block'});page.setDefaultTimeout(8_000);page.on('pageerror',e=>errors.push(e.message));
   await page.route('**/*',route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==origin||req.method()!=='GET'||!['/','/fixture.js','/fixture.css','/api/tavern-plugins/context'].includes(url.pathname)){blocked.push(req.method()+' '+req.url());return route.abort();}return route.continue();});
   await page.goto(origin,{waitUntil:'networkidle'});return page;
  };
  const reads=()=>requests.filter(r=>r.path==='/api/tavern-plugins/context').length;
  await t.test('naked canonical prose gains one static original shell, exact snapshot and source-bound refresh',async()=>{
   const page=await open();try{
    const frame=page.frameLocator('iframe.msg-html-frame');await frame.locator('[data-liyuan-dossier-view="snapshot"]').waitFor({state:'attached'});
    assert.equal(await page.locator('iframe').count(),1);assert.equal(reads(),2,'eligibility GET then exact snapshot GET');
    assert.deepEqual(parse(await frame.locator('.cxtd-body').textContent()),snapshot);
    assert.equal(await frame.locator('script,img,analysis,jsonpatch').count(),0);
    assert.equal(await page.locator('.msg-html-scripts').count(),0);assert.ok(!(await page.locator('iframe').getAttribute('sandbox')).includes('allow-scripts'));
    assert.equal(await frame.locator('details').getAttribute('open'),null);await frame.locator('summary').click();assert.equal(await frame.locator('details').evaluate(el=>el.open),true);
    assert.ok((await page.locator('.msg').innerText()).includes(prose));
    assert.deepEqual(await page.evaluate(()=>window.__fixture.msg),message,'author source unchanged');
    await page.getByRole('button',{name:'复制',exact:true}).click();assert.equal(await page.evaluate(()=>window.__copied),prose,'copy remains canonical prose, not delegated HTML');
    const before=reads();response.state.messages['saved-entry'].variables[0].stat_data={...snapshot,settled:'Synthetic background settlement'};
    for(const detail of [{entryId:'other-entry',entryScope:'saved-scope'},{entryId:'saved-entry',entryScope:'other-scope'}])await page.evaluate(detail=>window.dispatchEvent(new CustomEvent('liyuan:turn-state-refreshed',{detail})),detail);
    await page.waitForTimeout(100);assert.equal(reads(),before);
    await page.evaluate(()=>window.dispatchEvent(new CustomEvent('liyuan:turn-state-refreshed',{detail:{entryId:'saved-entry',entryScope:'saved-scope'}})));
    await frame.locator('.cxtd-body').filter({hasText:'Synthetic background settlement'}).waitFor({state:'attached'});
    assert.deepEqual(parse(await frame.locator('.cxtd-body').textContent()),response.state.messages['saved-entry'].variables[0].stat_data);assert.equal(reads(),before+1);
    await page.setViewportSize({width:390,height:844});await frame.locator('summary').click();
    assert.ok(await frame.locator('body').evaluate(el=>el.scrollWidth<=innerWidth+1));
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    assert.equal(await frame.locator('.cxtd-body').evaluate(el=>getComputedStyle(el).fontSize),'15.5px');
    assert.deepEqual(await page.evaluate(()=>window.__fixture.msg),message);
   }finally{await page.close();}
  });
  await t.test('authored original HTML is not duplicated by delegation',async()=>{
   response=context();fixture={msg:{...message,text:prose+'\n<UpdateVariable>'+protocol+'</UpdateVariable>'},skin,readOnly:false};const before=reads(),page=await open();try{
    const frame=page.frameLocator('iframe');await frame.locator('[data-liyuan-dossier-view="snapshot"]').waitFor({state:'attached'});assert.equal(await page.locator('iframe').count(),1);assert.equal(reads()-before,1,'original reader only, no delegated eligibility request');assert.deepEqual(parse(await frame.locator('.cxtd-body').textContent()),snapshot);assert.equal(await page.evaluate(()=>window.__fixture.msg.text),fixture.msg.text);
   }finally{await page.close();}
  });
  for(const kind of ['mvu disabled','helper disabled','non-delegated settings','old scope','invisible entry','readonly preview','user','unfinished','old unbound message','old message without mode','skin disabled'])await t.test(kind+' has no delegated shell or snapshot read',async()=>{
   response=context();fixture={msg:{...message},skin,readOnly:false};let eligibility=1;
   if(kind==='mvu disabled')response.mvu.enabled=false;
   if(kind==='helper disabled')response.plugins[0].enabled=false;
   if(kind==='non-delegated settings')response.state.extensionSettings.mvu_settings.更新方式='随正文解析';
   if(kind==='old scope')response.scopeKey='old-scope';
   if(kind==='invisible entry')response.visibleEntryIds=['other-entry'];
   if(kind==='readonly preview'){fixture.readOnly=true;eligibility=0;}
   if(kind==='user'){fixture.msg.channel='user';eligibility=0;}
   if(kind==='unfinished'){fixture.msg.unfinished=true;eligibility=0;}
   if(kind==='old unbound message'){delete fixture.msg.entryId;delete fixture.msg.entryScope;eligibility=0;}
   if(kind==='old message without mode'){delete fixture.msg.generationMode;eligibility=0;}
   if(kind==='skin disabled'){fixture.skin=null;eligibility=0;}
   const before=reads(),page=await open();try{assert.equal(await page.locator('iframe').count(),0);assert.equal(reads()-before,eligibility,'no stored-snapshot request');assert.ok((await page.locator('.msg').innerText()).includes(prose));assert.deepEqual(await page.evaluate(()=>window.__fixture.msg),fixture.msg);}finally{await page.close();}
  });
  assert.deepEqual(errors,[]);assert.deepEqual(blocked,[],'no model, external asset or script-runtime requests');
  assert.ok(requests.every(r=>r.method==='GET'&&['/','/fixture.js','/fixture.css','/api/tavern-plugins/context'].includes(r.path)),'only synthetic resources and read-only context');
 }finally{await browser?.close();if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}
});
