/** Isolated real main.ts + candidate frontend. Never reuses production HOME, model or story data. */
import {mkdtemp,mkdir,symlink,writeFile,readFile,rm} from 'node:fs/promises';
import {existsSync,readFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {TavernPluginSources} from '../server/tavern-plugin-source.ts';
import {ensureTavernPluginVendors} from '../server/tavern-plugin-vendor.ts';
import {validateTavernPluginCandidate} from '../server/tavern-plugin-runtime.ts';
const argv=process.argv.slice(2),get=n=>argv[argv.indexOf(n)+1],root=process.cwd(),fixtures=resolve(get('--fixtures')),dist=resolve(get('--dist'));
const binary=join(root,'.liyuan-database-plugin/browser/headless_shell'),libs=join(root,'.liyuan-database-plugin/browser-libs/lib64');if(existsSync(binary))process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE=binary;if(existsSync(libs))process.env.LIYUAN_DATABASE_BROWSER_LIBS=libs;
const cwd=await mkdtemp(join(tmpdir(),'liyuan-tavern-main-canary-'));let browser,child;let log='';
try{
 for(const dir of ['home','agent','web','.liyuan'])await mkdir(join(cwd,dir));for(const name of ['src','skills','node_modules'])await symlink(join(root,name),join(cwd,name),'dir');await symlink(join(root,'.liyuan/extensions'),join(cwd,'.liyuan/extensions'),'dir');await symlink(join(root,'web/public'),join(cwd,'web/public'),'dir');await symlink(dist,join(cwd,'web/dist'),'dir');
 const version=JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;
 await writeFile(join(cwd,'package.json'),JSON.stringify({type:'module',version}));await writeFile(join(cwd,'card.json'),JSON.stringify({spec:'chara_card_v2',data:{name:'合成接入角色',description:'合成上下文',first_mes:'合成开场',alternate_greetings:['合成备选开场'],mes_example:'',extensions:{},character_book:{entries:[]}}}));
 await writeFile(join(cwd,'liyuan.config.json'),JSON.stringify({card:'card.json',greeting:true,generationMode:'direct',literaryWorldEnabled:false,literaryEcologyEnabled:false,novelDigest:{enabled:false},researchSearchSchedule:{enabled:false},fixtureUnknown:{retained:12}}));
 await writeFile(join(cwd,'liyuan.agent.json'),JSON.stringify({version:1,defaultProvider:'fixture',defaultModel:'fixture-model',providers:{fixture:{baseUrl:'http://127.0.0.1:9/v1',api:'openai-completions',apiKey:'SYNTHETIC_TAVERN_ONLY',models:[{id:'fixture-model',contextWindow:32768,maxTokens:4096}]}}}));
 await ensureTavernPluginVendors(cwd,{fixtureRoot:fixtures});const sources=new TavernPluginSources(cwd,{activation:{isIdle:()=>true,validateCandidate:c=>validateTavernPluginCandidate(cwd,c)}});
 for(const id of ['template','helper']){await sources.install(id,{fixtureRepo:join(fixtures,id)});sources.configure(id,{enabled:true});}sources.close();
 const listener=createServer();await new Promise(r=>listener.listen(0,'127.0.0.1',r));const port=listener.address().port;await new Promise(r=>listener.close(r));const base=`http://127.0.0.1:${port}`;
 child=spawn(process.execPath,[join(root,'server/main.ts')],{cwd,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),HOME:join(cwd,'home'),LIYUAN_CODING_AGENT_DIR:join(cwd,'agent')},stdio:['ignore','pipe','pipe']});child.stdout.on('data',d=>log+=d);child.stderr.on('data',d=>log+=d);
 for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error('Synthetic main exited: '+log.slice(-1800));try{if((await fetch(base+'/healthz')).ok)break;}catch{}await new Promise(r=>setTimeout(r,100));}
 assert.equal((await(await fetch(base+'/healthz')).json()).version,version);const status=await(await fetch(base+'/api/tavern-plugins/status')).json();assert.equal(status.plugins.filter(p=>p.enabled&&p.installed).length,2);
 browser=await chromium.launch({headless:true,executablePath:process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE,env:{...process.env,LD_LIBRARY_PATH:process.env.LIYUAN_DATABASE_BROWSER_LIBS??''},args:['--no-sandbox']});const page=await browser.newPage();let paid=0;await page.addInitScript(()=>{localStorage.setItem('liyuan.lastVisit',String(Date.now()));localStorage.removeItem('liyuan.atHome');});await page.route('**/*',route=>{const url=new URL(route.request().url());if(/\/generate|chat\/completions/.test(url.pathname)){paid++;return route.abort();}return route.continue();});
 await page.goto(base,{waitUntil:'domcontentloaded'});await page.getByRole('radio',{name:'直出',exact:true}).first().waitFor();
 const entry=page.getByRole('button',{name:'酒馆插件：酒馆助手与提示词模板',exact:true});await entry.waitFor();await entry.click();
 const manager=page.getByRole('dialog',{name:'酒馆插件管理'});await manager.waitFor();
 await manager.getByRole('button',{name:'打开提示词模板原设置',exact:true}).click();
 const templateFrame=page.frameLocator('iframe[title="提示词模板原上游设置"]');await templateFrame.locator('#prompt_template_settings').waitFor({timeout:45_000});
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('iframe')).some(f=>f.title==='提示词模板原上游设置'&&f.contentWindow?.LiyuanTavernPlugins?.ready()),{},{timeout:45_000});
 assert.equal(await templateFrame.locator('body').evaluate(()=>window.EjsTemplate.evalTemplate('真实宿主 <%= 7 * 6 %>',{})),'真实宿主 42');
 await page.getByRole('button',{name:'返回酒馆插件',exact:true}).click();await page.getByRole('button',{name:'打开酒馆助手原设置',exact:true}).click();
 const helperFrame=page.frameLocator('iframe[title="酒馆助手原上游设置"]');await helperFrame.locator('#tavern_helper').waitFor({timeout:45_000});
 await page.waitForFunction(()=>Array.from(document.querySelectorAll('iframe')).some(f=>f.title==='酒馆助手原上游设置'&&f.contentWindow?.LiyuanTavernPlugins?.ready()),{},{timeout:45_000});
 assert.equal(await helperFrame.locator('#tavern_helper').count(),1);
 await page.getByRole('button',{name:'关闭酒馆插件管理',exact:true}).click();await page.setViewportSize({width:390,height:844});await entry.click();
 const mobile=page.getByRole('dialog',{name:'酒馆插件管理'});await mobile.waitFor();await mobile.getByRole('button',{name:'打开提示词模板原设置',exact:true}).waitFor();
 const bounds=await mobile.boundingBox();assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=390,'mobile plugin dialog must stay within viewport');assert.ok(await mobile.evaluate(element=>element.scrollWidth<=element.clientWidth),'mobile plugin dialog must not overflow');await page.getByRole('button',{name:'关闭酒馆插件管理',exact:true}).click();
 // Full real SessionManager greeting selection; no generation endpoint involved.
 const greetingBefore=await(await fetch(base+'/api/tavern/greeting-context')).json();assert.equal(greetingBefore.messageCount,1);
 const expected={sessionId:greetingBefore.sessionId,card:greetingBefore.card,leafId:greetingBefore.leafId,greetingIndex:greetingBefore.greetingIndex};const cardBefore=readFileSync(join(cwd,'card.json'));
 const selected=await fetch(base+'/api/tavern/greeting-select',{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({index:1,expected})});assert.equal(selected.status,200);const selectedData=await selected.json();assert.equal(selectedData.context.greetingIndex,1);assert.equal(selectedData.context.messageCount,1);
 const stale=await fetch(base+'/api/tavern/greeting-select',{method:'POST',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({index:0,expected})});assert.equal(stale.status,409);assert.deepEqual(readFileSync(join(cwd,'card.json')),cardBefore);
 // Template-only regression uses the real original EJS plugin in this isolated service.
 const configured=await fetch(base+'/api/tavern-plugins/config',{method:'PUT',headers:{'content-type':'application/json',origin:base},body:JSON.stringify({id:'helper',enabled:false})});assert.equal(configured.status,200);
 await page.goto(base+'/tavern-plugin-host.html?view=manager&plugin=template',{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>!!window.LiyuanTavernPlugins?.ready(),{},{timeout:45_000});
 assert.equal(await page.evaluate(()=>typeof window.TavernHelper),'undefined');
 const evaluated=await page.evaluate(async()=>{const h=window.LiyuanTavernPlugins.host,c=await h.request('/context');if(!c.chat.length)c.chat=[{__liyuanEntryId:'fixture-template-display',mes:'Synthetic readonly display',is_user:false,is_system:false,extra:{}}];await h.bind(c);return window.EjsTemplate.evalTemplate('<div id="template-only-widget">Template value <%= 6 * 7 %></div>',await window.EjsTemplate.prepareContext({},0));});
 assert.equal(evaluated,'<div id="template-only-widget">Template value 42</div>');
 const config=JSON.parse(await readFile(join(cwd,'liyuan.config.json'),'utf8'));assert.deepEqual(config.fixtureUnknown,{retained:12});assert.equal(config.generationMode,'direct');assert.equal(paid,0);
 console.log(JSON.stringify({version,mainStartup:true,bothPluginsInstalled:true,realOriginalManagerReady:true,independentFrontendEntry:true,mobileEntry:true,realTemplateOnlyEjs:true,canonicalOpeningSelection:true,staleOpeningRejected:true,realEjsExecuted:true,configPreserved:true,paidModelCalls:0}));
}catch(error){console.error(log.slice(-2000));throw error;}finally{await browser?.close();if(child&&child.exitCode===null){child.kill('SIGTERM');await new Promise(r=>child.once('exit',r));}await rm(cwd,{recursive:true,force:true});}
