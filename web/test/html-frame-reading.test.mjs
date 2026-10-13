// Static card display only: synthetic text, no production session or author script execution.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {build} from '../node_modules/esbuild/lib/main.js';
import {chromium} from 'playwright';

const root=resolve(new URL('../..',import.meta.url).pathname);
const paragraph=Array.from({length:30},(_,i)=>`合成段落 ${i+1}：这里是用于检查字体、留白和折叠高度的测试文字，不是真实推演或故事。`).join('\n\n');
const originalStyle=`.cxtd-box{max-width:650px;margin:18px auto;border:1px solid #d6a95288;border-radius:12px;background:#0c101d;overflow:hidden;font-family:serif}.cxtd-head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 16px 12px 20px;color:#f7d98a;cursor:pointer}.cxtd-title{font-size:14px;white-space:nowrap;letter-spacing:3px}.cxtd-ava{width:42px;height:42px;flex-shrink:0}.cxtd-body{padding:16px 20px;max-height:400px;overflow-y:auto;font-size:12px;line-height:1.85;white-space:pre-wrap;word-wrap:break-word;color:#d9cba4;background:#05060c}`;
const synthetic=`<div class="cxtd-box"><details><summary class="cxtd-head"><span class="cxtd-title">合成卷宗 · 阅读完成</span><span class="cxtd-ava"></span></summary><div class="cxtd-body">${paragraph}</div></details></div><style>${originalStyle}</style>`;

test('静态卷宗：放宽正文、展开收起持续量高、手机重排、晚到内容与普通details回归', {timeout:60_000}, async()=>{
 const work=await mkdtemp(join(tmpdir(),'liyuan-dossier-layout-'));let browser,server;
 const writes=[],errors=[];let fixture=synthetic;
 if(process.env.LIYUAN_DOSSIER_FIXTURE){const raw=await readFile(process.env.LIYUAN_DOSSIER_FIXTURE,'utf8');fixture=raw.replace('$1',paragraph);assert.notEqual(fixture,raw,'original card template must be filled with synthetic text');}
 try{
  const entry=`import React from 'react';import{createRoot}from'react-dom/client';import{HtmlFrame}from'./src/components/HtmlFrame.tsx';import{RichContent}from'${root}/web/src/components/Messages.tsx';function App(){const [html,setHtml]=React.useState(window.__html);window.__changeHtml=setHtml;return <div className="flow">${process.env.LIYUAN_HTML_FRAME_SOURCE_ROOT ? '<HtmlFrame html={html} scripts={false} seamless />' : '<RichContent text={html} />'}</div>}createRoot(document.getElementById('root')).render(<React.StrictMode><App/></React.StrictMode>);`;
  await build({stdin:{contents:entry,resolveDir:process.env.LIYUAN_HTML_FRAME_SOURCE_ROOT||join(root,'web'),loader:'tsx'},bundle:true,jsx:'automatic',format:'esm',outfile:join(work,'fixture.js'),logLevel:'silent'});
  server=createServer((req,res)=>{void(async()=>{
   const url=new URL(req.url,'http://localhost');
   if(!['GET','HEAD'].includes(req.method)){writes.push(req.method+' '+url.pathname);res.writeHead(405);return res.end();}
   if(url.pathname==='/fixture.js'){res.writeHead(200,{'content-type':'text/javascript'});return res.end(await readFile(join(work,'fixture.js')));}
   if(url.pathname==='/'||url.pathname==='/index.html'){res.writeHead(200,{'content-type':'text/html; charset=utf-8'});return res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;background:#f7f4f0}.flow{max-width:900px;margin:auto;padding:16px}.msg-html-seamless{margin:0;width:100%}.msg-html-frame{display:block;width:100%;border:0;background:transparent}.msg-html-ghost{display:none}</style></head><body><div id="root"></div><script>window.__html=${JSON.stringify(fixture).replace(/</g,'\\u003c')}</script><script type="module" src="/fixture.js"></script></body></html>`);}
   res.writeHead(404);res.end();
  })().catch(e=>{if(!res.headersSent)res.writeHead(500);res.end(e.message);});});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const base='http://127.0.0.1:'+server.address().port;
  const binary=process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE||join(root,'.liyuan-database-plugin/browser/headless_shell');
  const libs=process.env.LIYUAN_DATABASE_BROWSER_LIBS||join(root,'.liyuan-database-plugin/browser-libs/lib64');
  browser=await chromium.launch({headless:true,...(existsSync(binary)?{executablePath:binary}:{}),env:{...process.env,LD_LIBRARY_PATH:libs},args:['--no-sandbox']});
  const page=await browser.newPage({viewport:{width:1280,height:900},serviceWorkers:'block'});page.setDefaultTimeout(10_000);page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
  await page.goto(base,{waitUntil:'domcontentloaded'});
  const frame=page.frameLocator('iframe.msg-html-frame');await frame.locator('.cxtd-head').waitFor();
  await page.waitForTimeout(300);const before=await page.locator('iframe').evaluate(el=>el.getBoundingClientRect().height);
  assert.equal(await frame.locator('details').getAttribute('open'),null,'do not force authored collapsed state open');
  if(process.env.LIYUAN_DOSSIER_BASELINE){await frame.locator('summary').click();await page.waitForTimeout(400);console.log('baseline geometry',await page.locator('iframe').evaluate(el=>({frameHeight:el.getBoundingClientRect().height,wrapperWidth:el.contentDocument.querySelector('.cxtd-box').getBoundingClientRect().width,bodyFont:getComputedStyle(el.contentDocument.querySelector('.cxtd-body')).fontSize,bodyScrollHeight:el.contentDocument.querySelector('.cxtd-body').scrollHeight,bodyClientHeight:el.contentDocument.querySelector('.cxtd-body').clientHeight})));return;}
  assert.equal(await frame.locator('.cxtd-body').textContent(),paragraph,'prose must remain byte-for-byte synthetic source');
  assert.equal(await frame.locator('.cxtd-body').evaluate(el=>getComputedStyle(el).fontSize),'16px');
  const width=await frame.locator('.cxtd-box').boundingBox();assert.ok(width.width>=850,'use the message content width rather than a 650px inset');
  await frame.locator('summary').click();
  await page.waitForFunction(()=>{const f=document.querySelector('iframe');const b=f?.contentDocument?.querySelector('.cxtd-box');return b&&f.getBoundingClientRect().height>=b.getBoundingClientRect().bottom-2;});
  const opened=await page.locator('iframe').evaluate(el=>el.getBoundingClientRect().height);assert.ok(opened>before+600,'expanded reading area must not stay at its initial height');
  console.log('dossier geometry',JSON.stringify({collapsedFrameHeight:before,expandedFrameHeight:opened,width:width.width,bodyFontPx:16}));
  assert.equal(await frame.locator('.cxtd-body').evaluate(el=>getComputedStyle(el).maxHeight),'none');
  assert.ok(await frame.locator('.cxtd-body').evaluate(el=>el.scrollHeight<=el.clientHeight+2),'no cramped nested scroll box');
  const stable=await page.locator('iframe').evaluate(el=>el.getBoundingClientRect().height);await page.waitForTimeout(700);assert.ok(Math.abs(await page.locator('iframe').evaluate(el=>el.getBoundingClientRect().height)-stable)<2,'no continual iframe height creep');
  if(process.env.LIYUAN_DOSSIER_SCREENSHOTS){await mkdir(process.env.LIYUAN_DOSSIER_SCREENSHOTS,{recursive:true});await page.screenshot({path:join(process.env.LIYUAN_DOSSIER_SCREENSHOTS,'desktop.png'),fullPage:true});}
  await page.setViewportSize({width:390,height:844});
  await page.waitForFunction(()=>{const f=document.querySelector('iframe');const b=f.contentDocument.querySelector('.cxtd-box');return Math.abs(f.getBoundingClientRect().height-b.getBoundingClientRect().bottom)<8;});
  assert.equal(await frame.locator('.cxtd-body').evaluate(el=>getComputedStyle(el).fontSize),'15.5px');
  assert.ok(await frame.locator('body').evaluate(el=>el.scrollWidth<=innerWidth),'no mobile horizontal overflow');
  const preserved=await frame.locator('details').evaluate(el=>el.open);assert.equal(preserved,true,'resize must not remount/collapse the card');
  const beforeGrowth=await page.locator('iframe').evaluate(el=>el.getBoundingClientRect().height);
  await frame.locator('.cxtd-body').evaluate(el=>{el.textContent+='\n\n'+Array(12).fill('合成晚到内容：检查后续尺寸更新。').join('\n');});
  await page.waitForFunction(h=>document.querySelector('iframe').getBoundingClientRect().height>h+200,beforeGrowth);
  if(process.env.LIYUAN_DOSSIER_SCREENSHOTS)await page.screenshot({path:join(process.env.LIYUAN_DOSSIER_SCREENSHOTS,'mobile.png'),fullPage:true});
  await frame.locator('summary').click();await page.waitForFunction(()=>document.querySelector('iframe').getBoundingClientRect().height<200);
  // Generic static details must grow too, but never inherit this card-specific typography/layout.
  await page.evaluate(()=>window.__changeHtml('<details><summary>普通静态详情</summary><div style="height:520px">合成内容</div></details>'));
  await frame.locator('summary').waitFor();assert.equal(await frame.locator('style[data-liyuan-card-layout]').count(),0);
  await frame.locator('summary').click();await page.waitForFunction(()=>document.querySelector('iframe').getBoundingClientRect().height>=530);
  await frame.locator('summary').click();await page.waitForFunction(()=>document.querySelector('iframe').getBoundingClientRect().height<=125);
  assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);console.log('dossier fixture:',process.env.LIYUAN_DOSSIER_FIXTURE?'unchanged original template + synthetic prose':'synthetic template');
 }finally{await browser?.close();if(server?.listening){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}await rm(work,{recursive:true,force:true});}
});
