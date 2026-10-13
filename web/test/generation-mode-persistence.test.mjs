import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,symlink,rm} from 'node:fs/promises';
import {createServer} from 'node:net';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {chromium} from 'playwright';
const root=resolve(new URL('../..',import.meta.url).pathname);
const dist=process.env.LIYUAN_GENERATION_MODE_DIST||join(root,'web/dist');
const cwd=await mkdtemp(join(tmpdir(),'liyuan-mode-persistence-ui-'));
const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));
const base='http://127.0.0.1:'+port,version=JSON.parse(await readFile(join(root,'package.json'),'utf8')).version;
let child,browser;let paidCalls=0;
try{
 for(const name of ['home','agent','web','.liyuan'])await mkdir(join(cwd,name));
 await symlink(dist,join(cwd,'web/dist'),'dir');for(const name of ['src','skills','node_modules'])await symlink(join(root,name),join(cwd,name),'dir');await symlink(join(root,'.liyuan/extensions'),join(cwd,'.liyuan/extensions'),'dir');
 await writeFile(join(cwd,'package.json'),JSON.stringify({name:'synthetic-mode-persistence',version,type:'module'}));
 await writeFile(join(cwd,'card.json'),JSON.stringify({spec:'chara_card_v2',data:{name:'合成模式角色',description:'只用于模式保存界面回归',first_mes:'这是合成测试开场。'}}));
 const initial={card:'card.json',greeting:true,generationMode:'direct',literaryWorldEnabled:false,literaryEcologyEnabled:false,novelDigest:{enabled:false},researchSearchSchedule:{enabled:false},stepModels:{writer:{provider:'fixture',id:'fixture-writer'}},fixtureUnknown:{keep:73}};
 await writeFile(join(cwd,'liyuan.config.json'),JSON.stringify(initial));
 await writeFile(join(cwd,'liyuan.agent.json'),JSON.stringify({version:1,defaultProvider:'fixture',defaultModel:'fixture-writer',providers:{fixture:{baseUrl:'http://127.0.0.1:9/v1',api:'openai-completions',apiKey:'SYNTHETIC_MODE_ONLY',models:[{id:'fixture-writer',contextWindow:64000,maxTokens:4096}]}}}));
 child=spawn('/opt/node22/bin/node',[join(root,'server/main.ts')],{cwd,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),HOME:join(cwd,'home'),LIYUAN_CODING_AGENT_DIR:join(cwd,'agent')},stdio:['ignore','pipe','pipe']});let startup='';child.stdout.on('data',d=>startup+=d);child.stderr.on('data',d=>startup+=d);
 for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error('Synthetic host exited before readiness');try{if((await fetch(base+'/healthz')).ok)break}catch{}await new Promise(r=>setTimeout(r,100));}
 assert.equal((await(await fetch(base+'/healthz')).json()).version,version);
 browser=await chromium.launch({headless:true,...(process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE?{executablePath:process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE}:{}),env:{...process.env,LD_LIBRARY_PATH:process.env.LIYUAN_DATABASE_BROWSER_LIBS||process.env.LD_LIBRARY_PATH||''},args:process.getuid?.()===0?['--no-sandbox']:[]});
 const page=await browser.newPage();await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==base||/chat\/completions|\/generate|\/api\/database-plugin\/completion/.test(url.pathname)){paidCalls++;return route.abort();}return route.continue();});
 await page.goto(base,{waitUntil:'domcontentloaded'});await page.getByRole('radio',{name:'直出',exact:true}).first().waitFor();
 for(const mode of ['director','direct','director']){
  const label=mode==='direct'?'直出':'导演';const saved=page.waitForResponse(r=>r.url()===base+'/api/config'&&r.request().method()==='PUT');await page.getByRole('radio',{name:label,exact:true}).first().click();assert.equal((await saved).status(),200);
  const config=JSON.parse(await readFile(join(cwd,'liyuan.config.json'),'utf8'));assert.equal(config.generationMode,mode);assert.deepEqual(config.fixtureUnknown,{keep:73});assert.deepEqual(config.stepModels,initial.stepModels);
  await page.reload({waitUntil:'domcontentloaded'});await page.getByRole('radio',{name:label,exact:true}).first().waitFor();await page.waitForFunction(({label})=>[...document.querySelectorAll('[role="radio"]')].some(e=>e.textContent?.trim()===label&&e.getAttribute('aria-checked')==='true'),{label});
 }
 const beforeFailure=await readFile(join(cwd,'liyuan.config.json'),'utf8');
 await page.route('**/api/config',async route=>{if(route.request().method()==='PUT')return route.fulfill({status:507,contentType:'application/json',body:JSON.stringify({code:'ENOSPC',error:'服务器可用存储空间不足（ENOSPC），本次操作未完成。请释放磁盘空间后重试。'})});return route.continue();});
 await page.getByRole('radio',{name:'直出',exact:true}).first().click();await page.getByText(/模式已用于后续输入，但保存配置失败：服务器可用存储空间不足/).waitFor();assert.equal(await readFile(join(cwd,'liyuan.config.json'),'utf8'),beforeFailure);
 await page.reload({waitUntil:'domcontentloaded'});await page.waitForFunction(()=>[...document.querySelectorAll('[role="radio"]')].some(e=>e.textContent?.trim()==='导演'&&e.getAttribute('aria-checked')==='true'));
 assert.equal(paidCalls,0);console.log(JSON.stringify({version,directorDirectSwitchSaved:true,reloadReadsPersistedMode:true,unknownConfigAndWriterPreserved:true,storageFailureWarnsWithoutFalsePersistence:true,paidModelCalls:0}));
}finally{await browser?.close();if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}await rm(cwd,{recursive:true,force:true});}
