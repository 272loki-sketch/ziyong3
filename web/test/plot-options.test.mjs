import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { build } from '../node_modules/esbuild/lib/main.js';
import { chromium } from 'playwright';
const root=resolve(new URL('../..',import.meta.url).pathname);
test('plot options are independent, editable, never auto-send; cancellation, manual search, failures and mobile', {timeout:90000}, async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'liyuan-plot-browser-'));let browser,server,sendCount=0,refreshes=0;const errors=[],external=[];
 const option={id:'synthetic-option',cardId:'synthetic-card',cardHash:'synthetic-hash',title:'一起整理合成旧书',experience:'一起做事，了解彼此',whyNow:'当前提及图书馆',draft:'我问她有没有需要帮忙的地方。',prerequisites:['双方愿意参与'],setup:['先提到清点'],development:['共同清点时处理分歧'],boundaries:['不预定关系'],entryCondition:'约定后进入'};
 let view={contextKey:'a'.repeat(64),controlKey:'control',sourceId:'synthetic-source',enabled:true,semantic:false,interval:5,running:false,libraryCount:80,modelConfigured:true,error:'合成历史筹备失败但状态仍可读取',options:[option],active:null};
 try {
  await build({stdin:{contents:`import React,{useState}from'react';import{createRoot}from'react-dom/client';import{PlotOptionsBar}from'./src/components/PlotOptionsBar.tsx';import{ModelPlugSelector}from'./src/components/ModelPlugSelector.tsx';function App(){const[input,setInput]=useState('');const[draft,setDraft]=useState(null);return <><ModelPlugSelector label="日常筹备岗位测试" inputId="model-plug-dailyPlot" value={null} models={{current:{name:'不可暗示继承的主演'},models:[{provider:'fixture',providerName:'合成渠道',id:'daily',name:'合成筹备模型'}]}} inheritLabel="未配置（不借用其他岗位）" showInheritedModel={false} onChange={()=>{}}/><div id="original-actions"><button type="button" onClick={()=>setInput('原行动原样保留')}>原行动按钮</button></div><PlotOptionsBar scope="synthetic" busy={false} draft={draft} onClear={()=>setDraft(null)} onChoose={(option,contextKey)=>{if(input&&!confirm('替换当前草稿？'))return;setInput(option.draft);setDraft({choice:{contextKey,optionId:option.id},title:option.title})}}/><textarea aria-label="主输入" value={input} onChange={e=>setInput(e.target.value)}/><button type="button" onClick={()=>fetch('/send',{method:'POST',body:JSON.stringify({input,draft})})}>发送</button></>}createRoot(document.getElementById('root')).render(<App/>);`,resolveDir:join(root,'web'),loader:'tsx'},bundle:true,jsx:'automatic',format:'esm',outfile:join(cwd,'fixture.js'),logLevel:'silent'});
  server=createServer(async(req,res)=>{
   const url=new URL(req.url,'http://localhost');res.setHeader('content-type','application/json');
   if(url.pathname==='/api/plot-options')return res.end(JSON.stringify(view));
   if(url.pathname==='/api/plot-options/settings'){let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);view={...view,...body};if(body.semantic)view={...view,retrieval:{method:'keyword-fallback',phase:'fallback',configured:false,indexed:32,total:80,requests:0,inputTokens:null,message:'合成嵌入未配置，回退关键词'},lastRetrieval:{method:'keyword-fallback',phase:'fallback',configured:false,indexed:32,total:80,requests:1,inputTokens:null,message:'合成降级原因'}};return res.end(JSON.stringify(view));}
   if(url.pathname==='/api/plot-options/refresh'){refreshes++;res.statusCode=400;return res.end(JSON.stringify({error:'合成筹备失败，正文不受影响'}));}
   if(url.pathname==='/api/plot-options/library')return res.end(JSON.stringify({total:80,cards:[{id:'manual',title:'手动指定的合成卡',activity:'共同采购',setting:'合成市场'}]}));
   if(url.pathname==='/api/plot-options/cancel'){view={...view,active:null};return res.end(JSON.stringify(view));}
   if(url.pathname==='/send'){sendCount++;let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);assert.equal(body.input,'我自己改成了另一种说法。');assert.equal(body.draft.choice.optionId,option.id);return res.end('{}');}
   if(url.pathname==='/fixture.js'){res.setHeader('content-type','text/javascript');return res.end(await readFile(join(cwd,'fixture.js')));}
   if(url.pathname==='/fixture.css'){res.setHeader('content-type','text/css');return res.end(await readFile(join(cwd,'fixture.css')));}
   if(url.pathname==='/'){res.setHeader('content-type','text/html');return res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div style="max-width:800px;margin:auto" id="root"></div><script type="module" src="/fixture.js"></script></body></html>');}res.statusCode=404;res.end('{}');
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
  browser=await chromium.launch({headless:true,args:['--no-sandbox'],...(process.env.LIYUAN_PLOT_BROWSER_LIBS?{env:{...process.env,LD_LIBRARY_PATH:process.env.LIYUAN_PLOT_BROWSER_LIBS}}:{})});const context=await browser.newContext({viewport:{width:1280,height:900}});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin!==base){external.push(route.request().url());return route.abort();}return route.continue();});
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base);
  assert.equal(await page.getByLabel('日常筹备岗位测试').inputValue(),'');assert.match(await page.getByLabel('日常筹备岗位测试').locator('option').first().textContent(),/不借用/);assert.doesNotMatch(await page.getByLabel('日常筹备岗位测试').locator('option').first().textContent(),/不可暗示继承/);
  await page.locator('.plot-options-bar>details>summary').click();const pick=page.getByRole('button',{name:`选择剧情：${option.title}`});await pick.waitFor();assert.match(await page.locator('.plot-options-bar').textContent(),/合成历史筹备失败但状态仍可读取/);
  await pick.click();assert.equal(sendCount,0);assert.equal(await page.getByRole('textbox',{name:'主输入'}).inputValue(),option.draft);
  await page.getByText('尚未提交',{exact:false}).waitFor();await page.getByRole('textbox',{name:'主输入'}).fill('我自己改成了另一种说法。');
  await page.getByRole('button',{name:'发送',exact:true}).click();await page.waitForTimeout(100);assert.equal(sendCount,1);
  await page.getByRole('button',{name:'取消草稿引导'}).click();assert.equal(await page.getByRole('textbox',{name:'主输入'}).inputValue(),'我自己改成了另一种说法。');
  page.once('dialog',d=>d.dismiss());await pick.click();assert.equal(await page.getByRole('textbox',{name:'主输入'}).inputValue(),'我自己改成了另一种说法。');
  await page.getByRole('button',{name:'原行动按钮'}).click();assert.equal(await page.getByRole('textbox',{name:'主输入'}).inputValue(),'原行动原样保留');
  await page.getByLabel('剧情选材刷新周期').selectOption('10');await page.waitForTimeout(100);assert.equal(view.interval,10);
  await page.getByLabel('混合语义检索').click();await page.waitForFunction(()=>document.querySelector('[aria-label="混合语义检索"]').checked);await page.getByText('合成嵌入未配置，回退关键词',{exact:false}).waitFor();assert.match(await page.locator('.plot-semantic-status').textContent(),/32\/80/);assert.match(await page.locator('.plot-semantic-status').textContent(),/不能按零计/);assert.equal(await page.getByRole('button',{name:'重建日常卡语义索引'}).isDisabled(),true);await page.getByLabel('日常卡嵌入批量').selectOption('1');await page.waitForFunction(()=>document.querySelector('[aria-label="日常卡嵌入批量"]').value==='1');assert.equal(view.embeddingBatchSize,1);
  await page.getByRole('button',{name:'重新筹备',exact:true}).click();await page.getByRole('alert').filter({hasText:'合成筹备失败'}).waitFor();assert.match(await page.getByRole('alert').textContent(),/合成筹备失败/);
  await page.locator('.plot-library>summary').click();await page.getByRole('textbox',{name:'搜索日常剧情卡'}).fill('合成');await page.getByRole('button',{name:'搜索卡库'}).click();await page.getByText('手动指定的合成卡',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'为此卡筹备入口'}).count(),1);
  for(const width of [390,320]){await page.setViewportSize({width,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
  assert.equal(refreshes,1);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 }finally{await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(cwd,{recursive:true,force:true});}
});
