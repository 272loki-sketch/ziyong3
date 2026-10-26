import { syntheticPlotGrounding } from "../../test/fixtures/plot-grounding.ts";
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,rm,writeFile,symlink} from 'node:fs/promises';
import {createServer} from 'node:http';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {chromium} from 'playwright';
const root=resolve(new URL('../..',import.meta.url).pathname);
const dist=process.env.LIYUAN_PLOT_APP_DIST||join(root,'web/dist');
async function listen(s){await new Promise(r=>s.listen(0,'127.0.0.1',r));return s.address().port;}
async function until(f,label){for(let i=0;i<250;i++){if(await f())return;await new Promise(r=>setTimeout(r,40));}throw Error('timeout: '+label);}
test('full App plot choice: isolated real HTTP/WS, editable input, accepted bound intent, original options and plot-bar mobile bounds', {timeout:60000}, async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'liyuan-plot-app-'));let child,browser,hostPort;const requests=[],frames=[],errors=[],mutations=[];
 const model=createServer((req,res)=>{void(async()=>{let raw='';for await(const b of req)raw+=b;const p=JSON.parse(raw);requests.push(p);let content='{}';
  if(p.model==='daily'){const rawInput=p.messages.find(m=>m.role==='user').content;const data=JSON.parse(typeof rawInput==='string'?rawInput:rawInput.map(part=>part.text??'').join(''));content=JSON.stringify({options:[{...syntheticPlotGrounding(data),cardId:data.candidates[0].id,title:'合成一起整理旧书',experience:'共同做事了解彼此',whyNow:'当前场景可接入',draft:'我问她最近有什么需要帮忙的事。',prerequisites:['双方愿意'],setup:['先谈起工作'],development:['讨论分工'],boundaries:['不预定关系'],entryCondition:'明确参与后进入'}]});}
  if(p.model==='director')content=JSON.stringify({scenePressure:'当前合成场景',characterInitiatives:[],candidateBeats:[]});
  if(p.model==='writer')content='合成正文：她把旧刊放在桌上，解释清点的分工。\n<options>\n继续听她解释\n先看看书架\n</options>';
  if(p.model==='scribe')content=JSON.stringify({patch:{location:'合成图书馆'}});
  res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'synthetic-'+requests.length,object:'chat.completion',created:1,model:p.model,choices:[{index:0,message:{role:'assistant',content},finish_reason:'stop'}],usage:{prompt_tokens:12,completion_tokens:8,total_tokens:20}}));})().catch(e=>{res.statusCode=500;res.end(JSON.stringify({error:String(e)}));});});
 try{
  const modelPort=await listen(model);await mkdir(join(cwd,'.liyuan'));await mkdir(join(cwd,'web'));await symlink(dist,join(cwd,'web/dist'),'dir');
  for(const name of ['src','skills','node_modules'])await symlink(join(root,name),join(cwd,name),'dir');await symlink(join(root,'.liyuan/extensions'),join(cwd,'.liyuan/extensions'),'dir');
  await writeFile(join(cwd,'package.json'),JSON.stringify({name:'synthetic-plot-app',version:'1.8.16',type:'module'}));
  await writeFile(join(cwd,'card.json'),JSON.stringify({data:{name:'合成剧情选项卡',description:'合成图书馆场景',first_mes:'合成开场'}}));
  await writeFile(join(cwd,'liyuan.config.json'),JSON.stringify({card:'card.json',userName:'合成玩家',greeting:false,generationMode:'direct',literaryWorldEnabled:false,literaryEcologyEnabled:false,novelDigest:{enabled:false},researchSearchSchedule:{enabled:false},stepModels:Object.fromEntries([['dailyPlot','daily'],['literaryDirector','director'],['scribe','scribe']].map(([k,id])=>[k,{provider:'fixture',id}]))}));
  await writeFile(join(cwd,'liyuan.agent.json'),JSON.stringify({version:1,defaultProvider:'fixture',defaultModel:'writer',providers:{fixture:{baseUrl:`http://127.0.0.1:${modelPort}/v1`,api:'openai-completions',apiKey:'synthetic-only',compat:{streaming:false,supportsTools:false},models:['writer','daily','director','scribe'].map(id=>({id,contextWindow:128000,maxTokens:12000}))}}}));
  const corpus=join(cwd,'.liyuan/outline/research/corpus');await mkdir(join(corpus,'digests'),{recursive:true});await writeFile(join(corpus,'documents.json'),JSON.stringify([{id:'doc-synthetic',status:'ready'}]));
  await writeFile(join(corpus,'digests/doc-synthetic.json'),JSON.stringify({dailyPatterns:[{title:'合成旧书清点',surfaceActivity:'整理旧书',setting:'图书馆',locator:'synthetic-chunk',initiative:'自愿帮忙',sweetBeat:'了解习惯',friction:'分工意见',misunderstanding:'',microChange:'熟悉',escalationLimit:'不强制关系',naturalStop:'收工',failureWarning:'先有动机'}]}));
  const portProbe=createServer();hostPort=await listen(portProbe);await new Promise(r=>portProbe.close(r));const base=`http://127.0.0.1:${hostPort}`;let logs='';
  child=spawn(process.execPath,[join(root,'server/main.ts'),'--new'],{cwd,env:{...process.env,HOME:join(cwd,'home'),LIYUAN_CODING_AGENT_DIR:join(cwd,'agent'),HOST:'127.0.0.1',PORT:String(hostPort),LIYUAN_PLAY_SLOT_CHILD:'1'},stdio:['ignore','pipe','pipe']});for(const s of [child.stdout,child.stderr])s.on('data',b=>{logs+=b;});
  let scopeHeaders;
  await until(async()=>{if(child.exitCode!==null)throw Error(logs.slice(-2000));try{
   const html=await(await fetch(base+'/')).text(),workspace=html.match(/name="liyuan-workspace" content="([^"]*)"/)?.[1],lease=html.match(/name="liyuan-workspace-lease" content="([^"]*)"/)?.[1];
   scopeHeaders=workspace&&lease?{'x-liyuan-workspace':workspace,'x-liyuan-workspace-lease':lease}:{};return(await fetch(base+'/healthz',{headers:scopeHeaders})).ok;
  }catch{return false;}},'host startup');
  await fetch(base+'/api/models',{headers:scopeHeaders});assert.ok((await fetch(base+'/api/models/select',{method:'POST',headers:{'content-type':'application/json',...scopeHeaders},body:JSON.stringify({provider:'fixture',id:'writer'})})).ok);
  browser=await chromium.launch({headless:true,...(process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE?{executablePath:process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE}:{}),env:{...process.env,LD_LIBRARY_PATH:process.env.LIYUAN_DATABASE_BROWSER_LIBS??process.env.LD_LIBRARY_PATH},args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:1280,height:960}});page.on('pageerror',e=>errors.push(e.message));page.on('response',async response=>{if(response.url().includes('/api/plot-options/settings'))mutations.push({status:response.status(),body:await response.json()});});page.on('websocket',ws=>ws.on('framesent',event=>{try{frames.push(JSON.parse(String(event.payload)));}catch{}}));
  await page.goto(base);const enter=page.getByRole('button',{name:/^(继续当前对话|开始对话)$/});if(await enter.count())await enter.click();
  const bar=page.getByRole('region',{name:'剧情选项'});await bar.locator(':scope > details > summary').click();await bar.getByRole('button',{name:'刷新状态',exact:true}).click();await page.waitForTimeout(300);await bar.getByLabel('开启后台选材').click();
  const pick=bar.getByRole('button',{name:'选择剧情：合成一起整理旧书'});await pick.waitFor({timeout:12000}).catch(async error=>{console.log(JSON.stringify({diagnostic:'synthetic plot state',view:await(await fetch(base+'/api/plot-options')).json(),bar:(await bar.textContent()).slice(0,1800),models:requests.map(p=>p.model),mutations,host:logs.slice(-1200)}));throw error;});await pick.click();
  assert.equal(frames.filter(f=>f.type==='prompt').length,0);const input=page.locator('#send_textarea');assert.equal(await input.inputValue(),'我问她最近有什么需要帮忙的事。');
  await input.fill('我换个说法，问她整理旧书有没有具体分工。');await page.getByRole('button',{name:'发送',exact:true}).click();
  await until(()=>frames.some(f=>f.type==='prompt'&&f.plotChoice),'plot intent sent');const sent=frames.find(f=>f.type==='prompt'&&f.plotChoice);assert.equal(sent.text,'我换个说法，问她整理旧书有没有具体分工。');
  await page.getByText('合成正文：她把旧刊放在桌上，解释清点的分工。',{exact:false}).first().waitFor();await page.waitForFunction(()=>document.querySelector('#send_textarea').value==='');
  const view=await(await fetch(base+'/api/plot-options')).json();assert.equal(view.active.option.id,sent.plotChoice.optionId);assert.ok(requests.filter(p=>p.model==='writer').some(p=>JSON.stringify(p.messages).includes('user-selected-plot-direction-not-fact')));
  assert.ok(requests.filter(p=>p.model==='writer').length>=1);assert.equal(await bar.getByRole('button',{name:'取消草稿引导'}).count(),0);
  await until(()=>frames.some(f=>f.type==='prompt'),'initial prompt');
  await page.getByRole('button',{name:'结束当前引导',exact:true}).waitFor();await until(async()=>await page.getByRole('button',{name:'结束当前引导',exact:true}).isEnabled(),'first-floor settlement complete');
  await until(async()=>!(await (await fetch(base+'/api/plot-options')).json()).running,'planning idle');
  const current=await(await fetch(base+'/api/plot-options')).json();await fetch(base+'/api/plot-options/cancel',{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({contextKey:current.contextKey,controlKey:current.controlKey})});
  await bar.getByRole('button',{name:'刷新状态',exact:true}).click();await pick.click();
  await page.evaluate(()=>{document.querySelector('#send_textarea').value='/new';});await page.locator('#send_but').click();await page.waitForTimeout(200);
  assert.equal(frames.filter(f=>f.type==='prompt').length,1,'DOM-backed commands must not bypass the selected-direction guard');
  await page.getByRole('main').locator('input[type=file]').setInputFiles({name:'synthetic-note.txt',mimeType:'text/plain',buffer:Buffer.from('Synthetic attachment; no production story data.')});await page.getByRole('button',{name:'移除附件',exact:true}).waitFor();
  await page.evaluate(()=>{document.querySelector('#send_textarea').value='我通过卡脚本直接改写DOM输入，然后问她旧书怎么分类。';});
  await page.locator('#send_but').click();await until(()=>frames.filter(f=>f.type==='prompt').length>=2,'DOM-injected prompt');
  const domSent=frames.filter(f=>f.type==='prompt').at(-1);assert.ok(domSent.text.startsWith('我通过卡脚本直接改写DOM输入，然后问她旧书怎么分类。\n（附件：'));assert.match(domSent.text,/synthetic-note/);
  assert.equal(domSent.plotChoice?.optionId,sent.plotChoice.optionId,'DOM-backed composer submission must retain the selected direction');
  await page.waitForFunction(()=>document.querySelector('#send_textarea').value==='');assert.equal(await page.getByRole('button',{name:'移除附件',exact:true}).count(),0,'ACK removes only the submitted attachments');
  await until(async()=>await page.getByRole('button',{name:'结束当前引导',exact:true}).isEnabled(),'DOM floor settled');
  await pick.click();await page.evaluate(()=>{document.querySelector('#send_textarea').value='我用原卡桥接提交同样的剧情方向。';return window.triggerSlash('/trigger');});
  await until(()=>frames.filter(f=>f.type==='prompt').length>=3,'bridge prompt');const bridged=frames.filter(f=>f.type==='prompt').at(-1);
  assert.equal(bridged.plotChoice?.optionId,sent.plotChoice.optionId,'card bridge uses the same direction-aware composer');
  assert.equal(bridged.text,'我用原卡桥接提交同样的剧情方向。');await page.waitForFunction(()=>document.querySelector('#send_textarea').value==='');
  await until(async()=>await page.getByRole('button',{name:'结束当前引导',exact:true}).isEnabled(),'bridge floor settled');
  await pick.click();await input.focus();await page.evaluate(()=>{const el=document.querySelector('#send_textarea');el.value='我保留方向，用键盘发送直接改过的文本。';el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));});
  await until(()=>frames.filter(f=>f.type==='prompt').length>=4,'DOM keyboard prompt');const keyed=frames.filter(f=>f.type==='prompt').at(-1);
  assert.equal(keyed.plotChoice?.optionId,sent.plotChoice.optionId);assert.equal(keyed.text,'我保留方向，用键盘发送直接改过的文本。');await page.waitForFunction(()=>document.querySelector('#send_textarea').value==='');
  await until(async()=>await page.getByRole('button',{name:'结束当前引导',exact:true}).isEnabled(),'keyboard floor settled');await pick.click();await input.fill('我保留这个尚未受理的旧来源草稿。');
  const digestFile=join(cwd,'.liyuan/outline/research/corpus/digests/doc-synthetic.json'),digest=JSON.parse(await readFile(digestFile,'utf8'));digest.dailyPatterns[0].surfaceActivity+='（合成来源更新）';await writeFile(digestFile,JSON.stringify(digest));
  const writerAttempts=requests.filter(p=>p.model==='writer').length;await page.locator('#send_but').click();
  await page.waitForFunction(()=>document.body.innerText.includes('剧情选项已过期'));
  assert.equal(await input.inputValue(),'我保留这个尚未受理的旧来源草稿。');assert.equal(await bar.getByRole('button',{name:'取消草稿引导'}).count(),1);assert.equal(requests.filter(p=>p.model==='writer').length,writerAttempts,'expired source rejects before model calls');
  for(const width of [390,320]){await page.setViewportSize({width,height:844});const metrics=await page.evaluate(()=>({page:document.documentElement.scrollWidth,viewport:innerWidth,bar:(()=>{const r=document.querySelector('.plot-options-bar').getBoundingClientRect();return {left:r.left,right:r.right,width:r.width,scroll:document.querySelector('.plot-options-bar').scrollWidth};})()}));console.log(JSON.stringify({mobile:width,metrics}));assert.equal(metrics.bar.scroll<=metrics.bar.width+1,true);assert.ok(metrics.bar.left>=0&&metrics.bar.right<=width+1);}
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('exit',r)),new Promise(r=>setTimeout(r,2000))]);if(child.exitCode===null)child.kill('SIGKILL');}model.closeAllConnections();await new Promise(r=>model.close(r));await rm(cwd,{recursive:true,force:true});}
});
