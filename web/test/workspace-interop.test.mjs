import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
import test from 'node:test';
import {chromium} from 'playwright';
import {workspaceFixture,until} from '../../test/helpers/workspace-fixture.ts';
const root=resolve(import.meta.dirname,'../..');
test('real main UI: drafts, two-way same-save play, old tabs, pinned iframe fetch/XHR and mobile (synthetic)',{timeout:150_000},async()=>{
 const temp=await mkdtemp(join(tmpdir(),'liyuan-workspace-ui-'));
 let fixture,browser;
 const errors=[];
 try{
  const dist=process.env.LIYUAN_TEST_WEB_DIST_DIR??join(temp,'dist');
  if(!process.env.LIYUAN_TEST_WEB_DIST_DIR)execFileSync(process.execPath,[join(root,'web/node_modules/vite/bin/vite.js'),'build','--outDir',dist],{cwd:join(root,'web'),stdio:'pipe'});
  fixture=await workspaceFixture(dist);
  browser=await chromium.launch({headless:true,args:['--no-sandbox']});const context=await browser.newContext({viewport:{width:1280,height:900}});
  const [name,...value]=fixture.cookie.split('=');await context.addCookies([{name,value:value.join('='),url:fixture.base}]);
  const page=await context.newPage(),oldTab=await context.newPage();
  for(const tab of [page,oldTab])tab.on('pageerror',error=>errors.push(error.message));
  const ready=async(tab)=>{await tab.locator('#send_textarea').waitFor();await tab.waitForFunction(()=>document.querySelector('#send_textarea')?.placeholder!=='等待连接…');};
  const openParallel=async()=>{await page.getByRole('button',{name:'多卡并行',exact:true}).click();await page.getByRole('dialog',{name:'多卡并行',exact:true}).waitFor();};
  await page.goto(fixture.base);await ready(page);await oldTab.goto(fixture.base);await ready(oldTab);
  await oldTab.locator('#send_textarea').fill('旧标签页文字草稿，不允许串到另一故事');
  await page.locator('#send_textarea').fill('原主窗口文字草稿，回来仍然保留');
  await openParallel();await page.getByRole('combobox',{name:'并行角色卡'}).selectOption('cards/Independent.json');await page.getByRole('button',{name:'新开独立卡位',exact:true}).click();
  const pane=()=>page.getByRole('region',{name:'合成Independent独立游玩'});
  await pane().getByRole('status').filter({hasText:'可以输入'}).waitFor();
  await pane().getByRole('combobox',{name:'合成Independent生成模式'}).selectOption('direct');
  await pane().getByRole('textbox',{name:'合成Independent输入'}).fill('合成并行第一楼');await pane().getByRole('button',{name:'发送',exact:true}).click();
  await pane().getByText('合成正文第1楼：独立故事沿着原有记忆继续。',{exact:true}).waitFor();
  await pane().getByRole('status').filter({hasText:'可以输入'}).waitFor();
  await pane().getByRole('textbox',{name:'合成Independent输入'}).fill('从多卡带到完整主窗口的文字草稿');
  // Uploading/unsent attachments must never be lost during a handoff reload.
  await page.getByRole('button',{name:'关闭多卡并行',exact:true}).click();
  await page.locator('.composer-box input[type="file"]').setInputFiles({name:'synthetic.txt',mimeType:'text/plain',buffer:Buffer.from('synthetic attachment')});
  await page.getByRole('button',{name:'移除附件',exact:true}).waitFor();
  await openParallel();await page.getByRole('button',{name:'主窗口继续',exact:true}).click();
  await page.getByText('请先发送或移除当前附件，再切换主窗口；文字草稿会保留。',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>window.__liyuanWorkspaceScope.workspace),'primary');
  await page.getByRole('button',{name:'关闭多卡并行',exact:true}).click();await page.getByRole('button',{name:'移除附件',exact:true}).click();
  await openParallel();await page.getByRole('button',{name:'主窗口继续',exact:true}).click();
  await page.getByRole('complementary',{name:'主窗口故事归属'}).getByText(/当前接管多卡存档/).waitFor();await ready(page);
  assert.equal(await page.locator('#send_textarea').inputValue(),'从多卡带到完整主窗口的文字草稿');
  await oldTab.getByText('窗口连接已过期（服务重启或窗口切换）；此页已停止发送，草稿保留。',{exact:true}).waitFor();
  assert.equal(await oldTab.locator('#send_textarea').inputValue(),'旧标签页文字草稿，不允许串到另一故事');
  const calls=fixture.calls;
  await oldTab.locator('#send_but').click();await new Promise(ok=>setTimeout(ok,200));assert.equal(fixture.calls,calls);
  // Explicitly mounted original plugin host HTML gets the same immutable lease.
  const status=await page.evaluate(async()=>await(await fetch('/api/play-slots/main')).json());
  const frame=await page.evaluate(async()=>{
   const scope=window.__liyuanWorkspaceScope;const iframe=document.createElement('iframe');iframe.title='合成作用域传输探针';
   iframe.src='/tavern-plugin-host.html?view=manager&liyuanWorkspace='+scope.workspace+'&liyuanLease='+scope.lease;document.body.append(iframe);
   await new Promise((ok,fail)=>{iframe.onload=ok;iframe.onerror=fail;});return true;
  });assert.equal(frame,true);
  const target=page.frameLocator('iframe[title="合成作用域传输探针"]');
  await target.locator('body').waitFor();
  const frameData=await page.frames().find(frame=>frame.url().includes('view=manager&liyuanWorkspace='))?.evaluate(async()=>{
   const rest=await(await fetch('/api/tavern-plugins/binding')).json();
   const xhr=await new Promise((ok,fail)=>{const req=new XMLHttpRequest();req.open('GET','/api/config');req.onload=()=>ok(JSON.parse(req.responseText));req.onerror=fail;req.send();});
   return{workspace:window.__liyuanWorkspaceScope?.workspace,rest:rest.card??rest,xhr:xhr.config?.card??xhr};
  });assert.deepEqual(frameData,{workspace:status.workspace,rest:'cards/Independent.json',xhr:'cards/Independent.json'});
  // Same-origin author frame bootstrap precedes author JS, without rewriting its original text.
  await page.evaluate(()=>document.querySelector('iframe[title="合成作用域传输探针"]')?.remove());
  await page.locator('#send_textarea').fill('合成完整主窗口第二楼');await page.locator('#send_but').click();
  await until(()=>fixture.writers===2);await page.locator('.flow .msg-char').filter({hasText:'合成正文第2楼：独立故事沿着原有记忆继续。'}).first().waitFor();
  await page.getByRole('button',{name:'会话',exact:true}).click();
  await page.getByText('多卡存档 · 可在主窗口继续（1）',{exact:true}).waitFor();
  await page.getByRole('button',{name:'收起面板',exact:true}).click();
  await page.locator('#send_textarea').fill('主窗口放回后留给并行台的草稿');
  await page.getByRole('button',{name:'放回多卡，返回原主窗口',exact:true}).click();await ready(page);
  await page.waitForFunction(()=>document.querySelector('meta[name="liyuan-workspace"]')?.content==='primary');
  assert.equal(await page.locator('#send_textarea').inputValue(),'原主窗口文字草稿，回来仍然保留');
  await openParallel();await pane().getByRole('status').filter({hasText:'可以输入'}).waitFor();
  assert.equal(await pane().getByRole('textbox',{name:'合成Independent输入'}).inputValue(),'主窗口放回后留给并行台的草稿');
  await pane().getByText('合成正文第2楼：独立故事沿着原有记忆继续。',{exact:true}).waitFor();
  await page.setViewportSize({width:390,height:844});
  assert.ok(await page.locator('.play-slots-panel').evaluate(element=>element.getBoundingClientRect().width)<=390);
  await pane().getByRole('textbox',{name:'合成Independent输入'}).fill('合成返回多卡第三楼');await pane().getByRole('button',{name:'发送',exact:true}).click();
  await pane().getByText('合成正文第3楼：独立故事沿着原有记忆继续。',{exact:true}).waitFor();
  assert.equal(fixture.writers,3);
  assert.deepEqual(errors,[]);
 }finally{await browser?.close();await fixture?.close();await rm(temp,{recursive:true,force:true});}
});
