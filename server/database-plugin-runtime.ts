import { databasePluginModelRevision } from "./database-plugin-models.ts";
import type { DatabasePluginLiteraryDirector } from "../src/stage/database-plugin-prompt.ts";
import type { DatabaseRequestObservation } from "../src/stage/performance.ts";
import type { RequestFailure } from "../src/stage/request-failure.ts";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabasePluginHttp } from "./database-plugin-http.ts";
// The private browser must use the adapter shipped with this server, not an older web build.
const databaseHostScript = readFileSync(new URL("../web/public/database-plugin-host.js", import.meta.url));
export class DatabasePluginRuntime {
 private browser:Browser|null=null;private page:Page|null=null;private scope='';private source='';private modelRevision='';private busy:Promise<unknown>=Promise.resolve();private binding:{scopeKey:string;sourceEntryId:string}|null=null;
  readonly http:DatabasePluginHttp; readonly origin:()=>string;
  requestPhase:"database.before"|"database.after"|undefined;
  requestObservation:DatabaseRequestObservation|undefined;
  requestFailureObserver:((failure:RequestFailure)=>void)|undefined;
 constructor(http:DatabasePluginHttp,origin:()=>string){this.http=http;this.origin=origin;}
 async close(){await this.browser?.close();this.browser=null;this.page=null;this.scope='';this.source='';this.modelRevision='';}
  private async ensure(){const context=this.http.currentContext(),scope=this.http.scopeKey(context),modelRevision=databasePluginModelRevision(this.http.managedPresets());this.binding={scopeKey:scope,sourceEntryId:context.sourceEntryId};if(this.page&&scope===this.scope&&context.sourceEntryId===this.source&&modelRevision===this.modelRevision)return this.page;await this.close();this.http.sources.readCurrentPinnedJS();
   // Private computation pages must not enter GPU frame-sink recovery when private ANGLE libraries are inaccessible.
   this.browser=await chromium.launch({headless:true,...((process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE||existsSync(join(this.http.root,'browser','headless_shell')))?{executablePath:process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE||join(this.http.root,'browser','headless_shell')}:{}),env:{...process.env,LD_LIBRARY_PATH:process.env.LIYUAN_DATABASE_BROWSER_LIBS??process.env.LD_LIBRARY_PATH??(existsSync(join(this.http.root,'browser-libs','lib64'))?join(this.http.root,'browser-libs','lib64'):'')},args:['--disable-gpu',...(process.getuid?.()===0?['--no-sandbox']:[])]});const bc=await this.browser.newContext();await bc.route('**/*',route=>{const req=route.request(),url=new URL(req.url());if(url.origin!==this.origin())return route.abort('blockedbyclient');if(url.pathname==='/database-plugin-host.js')return route.fulfill({status:200,contentType:'application/javascript; charset=utf-8',body:databaseHostScript});return route.continue({headers:{...req.headers(),'x-liyuan-database-host':this.http.internalToken,'x-liyuan-database-scope':this.binding?.scopeKey??'','x-liyuan-database-source':this.binding?.sourceEntryId??''}})});this.page=await bc.newPage();this.page.on('dialog',dialog=>{if(dialog.type()==='confirm'&&/向量方案已优化，需要重建/.test(dialog.message()))void dialog.accept();else void dialog.dismiss();});this.scope=scope;this.source=context.sourceEntryId;this.modelRevision=modelRevision;await this.page.goto(this.origin()+'/database-plugin-host.html');try{await this.page.waitForFunction(()=>!!(window as any).LiyuanDatabasePluginHost?.ready(),{},{timeout:60000});}catch{const message=await this.page.evaluate(()=>document.getElementById('host-status')?.textContent??'').catch(()=> '');throw new Error('数据库插件启动未完成：'+message);}return this.page;}
  async before(userText:string,signal?:AbortSignal,director?:DatabasePluginLiteraryDirector,observation?:DatabaseRequestObservation){const job=this.busy.then(async()=>{if(signal?.aborted)throw new Error('数据库准备已取消');const abort=()=>{void this.close()};signal?.addEventListener('abort',abort,{once:true});try{const page=await this.ensure();this.requestPhase="database.before";this.requestObservation=observation;const result=await page.evaluate(({text,director})=>(window as any).LiyuanDatabasePluginHost.before(text,director),{text:userText,director}) as {sourceEntryId:string;userInput:string;errors:string[];literaryDirectorHandled:boolean;literaryDirection?:string};this.http.assertBinding({scopeKey:this.scope,sourceEntryId:result.sourceEntryId});if(signal?.aborted)throw new Error('数据库准备已取消');return result;}finally{this.requestPhase=undefined;this.requestObservation=undefined;signal?.removeEventListener('abort',abort)}});this.busy=job.catch(()=>{});return job;}
  async after(sourceEntryId?:string,signal?:AbortSignal,observation?:DatabaseRequestObservation){const job=this.busy.then(async()=>{
   if(signal?.aborted)throw new Error('数据库整理已取消');
   const abort=()=>{void this.close()};signal?.addEventListener('abort',abort,{once:true});this.http.boundSourceEntryId=sourceEntryId;
   let failure:RequestFailure|undefined;
   try{
    const page=await this.ensure();this.requestPhase="database.after";this.requestObservation=observation;
    // Keep the last managed failure in this job, even if upstream replaces it with a generic toast.
    this.requestFailureObserver=value=>{failure=value;};
    return await page.evaluate(()=>(window as any).LiyuanDatabasePluginHost.after());
   }catch(error){
    if(failure&&!signal?.aborted)throw Object.assign(new Error(`原数据库拍后整理失败 [${failure.kind}${failure.statusCode?':'+failure.statusCode:''}]：${failure.reason}`),{failure});
    throw error;
   }finally{this.requestPhase=undefined;this.requestObservation=undefined;this.requestFailureObserver=undefined;this.http.boundSourceEntryId=undefined;signal?.removeEventListener('abort',abort);}
  });this.busy=job.catch(()=>{});return job;}
  async rpc(method:string,args:unknown[]=[]){const job=this.busy.then(async()=>{const page=await this.ensure();return page.evaluate(({method,args})=>(window as any).LiyuanDatabasePluginHost.rpc(method,args),{method,args});});this.busy=job.catch(()=>{});return job;}
 status(){return {connected:!!this.page,scope:this.scope};}
}
