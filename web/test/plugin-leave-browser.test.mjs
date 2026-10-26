import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
import {build} from '../node_modules/esbuild/lib/main.js';
import {chromium} from 'playwright';

test('leave failure/timeout: explicit discard, restored controls, no retry or late navigation',{timeout:30000},async()=>{
 const root=resolve(new URL('../..',import.meta.url).pathname),dir=await mkdtemp(join(tmpdir(),'plugin-leave-'));
 let browser,server;
 try{
  await build({stdin:{resolveDir:join(root,'web'),loader:'tsx',contents:`import React,{useRef,useState} from 'react';import{createRoot}from'react-dom/client';import{usePluginLeave,PluginLeaveError}from'./src/plugins/usePluginLeave.tsx';
   function Harness(){const root=useRef(null),[tick,setTick]=useState(0);const{leave,pending,error,discard}=usePluginLeave(root,tick,80);window.advance=()=>setTick(x=>x+1);return <section ref={root} data-context-tick={tick}><button id="close" disabled={pending} onClick={()=>leave(()=>window.navigations++)}>close</button><PluginLeaveError error={error} discard={discard}/><iframe src="/frame"/></section>};window.navigations=0;createRoot(document.getElementById('root')).render(<Harness/>);`},bundle:true,jsx:'automatic',format:'esm',outfile:join(dir,'fixture.js')});
  server=createServer(async(req,res)=>{res.setHeader('content-type',req.url==='/fixture.js'?'text/javascript':'text/html');res.end(req.url==='/fixture.js'?await readFile(join(dir,'fixture.js')):req.url==='/frame'?`<button id="edit">edit</button><script>window.calls=0;window.mode='fail';window.LiyuanVeridisRewrite={flush:()=>{calls++;if(mode==='fail')return Promise.reject(Error('synthetic failure'));return new Promise(r=>window.release=r);}};</script>`:'<div id="root"></div><script type="module" src="/fixture.js"></script>');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  browser=await chromium.launch({headless:true,executablePath:process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE,env:{...process.env,LD_LIBRARY_PATH:process.env.LIYUAN_DATABASE_BROWSER_LIBS??''},args:['--no-sandbox']});
  const page=await browser.newPage();page.setDefaultTimeout(3000);
  const url=`http://127.0.0.1:${server.address().port}`;
  for(const scenario of ['failure','timeout-discard','timeout-late','source']){
   await page.goto(url);const frame=page.frameLocator('iframe');await frame.locator('#edit').waitFor();
   if(scenario!=='failure')await frame.locator('body').evaluate(()=>window.mode='hang');
   await page.locator('#close').click();
   if(scenario==='source'){
     // Release the old save only after the hook has received the new context prop.
     await page.evaluate(()=>window.advance());await page.locator('section[data-context-tick="1"]').waitFor();await frame.locator('body').evaluate(()=>window.release());
    await page.waitForTimeout(100);assert.equal(await page.getByRole('alert').count(),0);
   }else{
    await page.getByRole('alert').waitFor();assert.equal(await page.locator('iframe').evaluate(el=>el.inert),false);assert.equal(await page.locator('#close').isEnabled(),true);
    await frame.locator('#edit').click();await page.locator('#close').click();assert.equal(await frame.locator('body').evaluate(()=>window.calls),1,'no automatic retry');
    if(scenario==='timeout-late'){
     await frame.locator('body').evaluate(()=>window.release());await page.waitForTimeout(50);
    }else{
     page.once('dialog',dialog=>dialog.dismiss());await page.getByRole('button',{name:'放弃未确认的更改并离开'}).click();assert.equal(await page.evaluate(()=>window.navigations),0);
     page.once('dialog',dialog=>dialog.accept());await page.getByRole('button',{name:'放弃未确认的更改并离开'}).click();assert.equal(await page.evaluate(()=>window.navigations),1);
     if(scenario==='timeout-discard'){await frame.locator('body').evaluate(()=>window.release());await page.waitForTimeout(50);assert.equal(await page.evaluate(()=>window.navigations),1);}
     continue;
    }
   }
    assert.equal(await page.evaluate(()=>window.navigations),0,`${scenario}: late completion must not navigate`);
  }
 }finally{await browser?.close();server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
