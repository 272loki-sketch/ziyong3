import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { workspaceFixture } from '../../test/helpers/workspace-fixture.ts';
const root=resolve(import.meta.dirname,'../..');
test('library defaults to resolved standalone; mobile scope selector does not carry character auxiliary into another card', {timeout:60_000}, async()=>{
 const dist=process.env.LIYUAN_TEST_WEB_DIST_DIR;
 assert.ok(dist,'run against an isolated candidate build');
 const card={data:{name:'合成绑定卡',description:'offline',first_mes:'合成开场',extensions:{world:'Primary'},character_book:{name:'Primary',entries:[{id:1,comment:'错误内嵌副本',content:'UNUSED_EMBEDDED',enabled:true}]}}};
 const books={Primary:{entries:[{uid:1,comment:'实际主书启用',content:'PRIMARY',enabled:true},{uid:2,comment:'实际主书关闭',content:'DISABLED',enabled:false}]},Aux:{entries:[{uid:1,content:'AUX',enabled:true,constant:true}]},Global:{entries:[{uid:1,content:'GLOBAL',enabled:true,constant:true}]}};
 const fixture=await workspaceFixture(dist,{Primary:card},books);let browser;
 try{
  const binary=join(root,'.liyuan-database-plugin/browser/headless_shell'),libs=join(root,'.liyuan-database-plugin/browser-libs/lib64');
  browser=await chromium.launch({headless:true,...(existsSync(binary)?{executablePath:binary}:{}),env:{...process.env,...(existsSync(libs)?{LD_LIBRARY_PATH:libs}:{})},args:['--no-sandbox']});
  const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block'});
  await context.addCookies([{name:'liyuan_access',value:fixture.cookie.split('=')[1],url:fixture.base}]);const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(fixture.base);await page.getByRole('button',{name:'世界书',exact:true}).first().click();
  await page.locator('.lore-item').filter({hasText:'实际主书关闭'}).waitFor();assert.equal(await page.locator('.lore-item').count(),2);
  assert.match(await page.locator('.book-embedded').innerText(),/当前不参与生成/);assert.equal(await page.locator('.lore-item').filter({hasText:'错误内嵌副本'}).count(),0);
  const scope=page.getByLabel('世界书挂载作用域');assert.equal(await scope.inputValue(),'character_aux');
  const row=name=>page.locator('.book-row').filter({has:page.locator('.book-name').filter({hasText:new RegExp('^'+name+'$')})});
  await row('Aux').locator('.book-check').click();await row('Aux').getByText('本角色附加',{exact:true}).waitFor();
  await page.setViewportSize({width:390,height:1000});await scope.selectOption('global');
  assert.equal(await row('Aux').locator('[role=checkbox]').getAttribute('aria-checked'),'false');
  await row('Global').locator('.book-check').click();await row('Global').getByText('全局',{exact:true}).waitFor();
  const config=JSON.parse(await readFile(join(fixture.cwd,'liyuan.config.json'),'utf8'));
  assert.deepEqual(config.lorebookBindings.character['cards/Primary.json'],['assets/lorebooks/Aux.json']);assert.deepEqual(config.lorebooks,['assets/lorebooks/Global.json']);
  const main=await(await fetch(fixture.base+'/api/play-slots/main',{headers:{cookie:fixture.cookie}})).json();
  const headers={cookie:fixture.cookie,'content-type':'application/json','x-liyuan-workspace':main.workspace,'x-liyuan-workspace-lease':main.lease};
  const response=await fetch(fixture.base+'/api/card/switch',{method:'POST',headers,body:JSON.stringify({card:'cards/Independent.json'})});assert.equal(response.status,200);
  const current=await(await fetch(fixture.base+'/api/tavern/worldbooks',{headers})).json();assert.deepEqual(current.additional,[]);assert.deepEqual(current.global,['Global']);assert.notEqual(current.primary,'Primary');
  assert.equal(fixture.calls,0,'library and binding actions never call a model');assert.deepEqual(errors,[]);
 }finally{await browser?.close();await fixture.close();}
});
