import { scopedUrl, workspaceStale, markWorkspaceStale, requestWorkspaceReload } from "../workspace.ts";
import { createTavernFrontendCommands } from "../plugins/tavern-frontend-commands.ts";
/** Original plugin realm receives display HTML in memory, never as a URL or a story write. */
import { createContext, useContext, useEffect, useRef, useState, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
export const TavernEntryContext = createContext<{entryId?:string;entryScope?:string} | undefined>(undefined);
const STATUS_PATH="/api/tavern-plugins/status";
const STATUS_TTL_MS=15_000;
const MAX_RETRY_MS=30_000;
type PluginState={enabled:boolean;helperEnabled:boolean;templateEnabled:boolean;revision:string};
type StatusResult={value:PluginState;expiresAt:number};
type StatusProblem={kind:"stale"|"unavailable";message:string};
const STALE_MESSAGE="窗口连接已过期，原卡数据没有清空。请保留草稿并刷新页面后重新连接。";
let statusProblem:StatusProblem|null=null;
let cachedStatus:StatusResult|null=null;
let retryAt=0;
let retryDelay=500;
let requestInFlight:Promise<PluginState|null>|null=null;
let requestEpoch=0;
let listenerInstalled=false;
const subscribers=new Set<(value:PluginState|null)=>void>();
function invalidateStatus(){
 requestEpoch++;cachedStatus=null;retryAt=0;retryDelay=500;requestInFlight=null;
 statusProblem=workspaceStale()?{kind:"stale",message:STALE_MESSAGE}:null;
 for(const subscriber of subscribers)subscriber(null);
}
function ensureStatusListener(){
 if(listenerInstalled||typeof window==="undefined")return;
 listenerInstalled=true;window.addEventListener("liyuan:tavern-plugins-changed",invalidateStatus);
 window.addEventListener("liyuan:workspace-changed",()=>{
  requestEpoch++;cachedStatus=null;requestInFlight=null;statusProblem={kind:"stale",message:STALE_MESSAGE};
  for(const subscriber of subscribers)subscriber(null);
 });
}
function readStatus():Promise<PluginState|null>{
 ensureStatusListener();
 if(workspaceStale()||statusProblem?.kind==="stale"){statusProblem={kind:"stale",message:STALE_MESSAGE};return Promise.resolve(null);}
 const now=Date.now();
 if(cachedStatus&&now<cachedStatus.expiresAt)return Promise.resolve(cachedStatus.value);
 if(requestInFlight)return requestInFlight;
 if(now<retryAt)return Promise.resolve(null);
 const epoch=requestEpoch,controller=new AbortController();
 const timeout=setTimeout(()=>controller.abort(),8_000);
 const request=fetch(scopedUrl(STATUS_PATH),{cache:"no-store",signal:controller.signal}).then(async response=>{
  const result=await response.json().catch(()=>({})) as {code?:string;error?:string;runtimeEnabled:boolean;plugins?:Array<{id?:string;enabled?:boolean;installed?:boolean;version?:string;commit?:string;sha256?:string}>};
  if(response.status===409&&result.code==="workspace_changed"){
   if(epoch===requestEpoch){statusProblem={kind:"stale",message:STALE_MESSAGE};markWorkspaceStale();}
   return null;
  }
  if(!response.ok||typeof result.runtimeEnabled!=="boolean")throw new Error(response.status===401?"登录状态已失效，请重新登录后刷新页面。":`无法读取原插件状态（HTTP ${response.status}），交互界面尚未连接。`);
  const plugins=result.plugins??[];
  const helper=plugins.find(plugin=>plugin.id==="helper"),template=plugins.find(plugin=>plugin.id==="template");
  const helperEnabled=helper?.enabled===true&&helper.installed===true;
  const templateEnabled=template?.enabled===true&&template.installed===true;
  const revision=JSON.stringify(plugins.map(plugin=>[plugin.id,plugin.enabled,plugin.installed,plugin.version,plugin.commit,plugin.sha256]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
  const value={enabled:result.runtimeEnabled&&(helperEnabled||templateEnabled),helperEnabled,templateEnabled,revision};
  if(epoch===requestEpoch){statusProblem=null;cachedStatus={value,expiresAt:Date.now()+STATUS_TTL_MS};retryAt=0;retryDelay=500;}
  return epoch===requestEpoch?value:null;
 }).catch(error=>{
  if(epoch===requestEpoch){cachedStatus=null;statusProblem={kind:"unavailable",message:error instanceof Error?error.message:"原插件连接暂时不可用，交互界面尚未加载。"};retryAt=Date.now()+retryDelay;retryDelay=Math.min(MAX_RETRY_MS,retryDelay*2);}
  return null;
 }).finally(()=>{clearTimeout(timeout);if(epoch===requestEpoch&&requestInFlight===request)requestInFlight=null;});
 requestInFlight=request;return request;
}
function nextStatusCheckMs(){return cachedStatus?STATUS_TTL_MS:Math.max(100,retryAt-Date.now());}
type HtmlChildProps={html?:string;scripts?:boolean};
export function TavernMessageFrame({html,children}:{html:string;children:ReactNode}){
 const {entryId,entryScope}=useContext(TavernEntryContext)??{};
 const [pluginState,setPluginState]=useState<PluginState|null>(null),[statusRevision,setStatusRevision]=useState(""),[failedToken,setFailedToken]=useState<number|null>(null),[retryNonce,setRetryNonce]=useState(0),[height,setHeight]=useState(180),[evaluated,setEvaluatedHtml]=useState<{token:number;html:string}|null>(null);
 const [failureMessage,setFailureMessage]=useState("");
 const [refreshFailure,setRefreshFailure]=useState("");
 const [connectionProblem,setConnectionProblem]=useState<StatusProblem|null>(statusProblem);
 const readyWindow=useRef<Window|null>(null),deliveredWindow=useRef<Window|null>(null);
 const frame=useRef<HTMLIFrameElement>(null),readyToken=useRef<number|null>(null);
 const tokenRef=useRef({entryScope,entryId,html,statusRevision,retryNonce,token:0});
 const previous=tokenRef.current;
 if(previous.entryScope!==entryScope||previous.entryId!==entryId||previous.html!==html||previous.statusRevision!==statusRevision||previous.retryNonce!==retryNonce)tokenRef.current={entryScope,entryId,html,statusRevision,retryNonce,token:previous.token+1};
 const token=tokenRef.current.token;
 const helperEnabled=pluginState?.helperEnabled===true,templateEnabled=pluginState?.templateEnabled===true;
 const payload=useRef({html,entryId,entryScope,helperEnabled,templateEnabled,token});payload.current={html,entryId,entryScope,helperEnabled,templateEnabled,token};
 useEffect(()=>{
  const commands=createTavernFrontendCommands({origin:location.origin,target:()=>({window:frame.current?.contentWindow??null,entryId:payload.current.entryId,entryScope:payload.current.entryScope,token:payload.current.token,enabled:payload.current.helperEnabled&&readyWindow.current===frame.current?.contentWindow&&readyToken.current===payload.current.token})});
  window.addEventListener("message",commands.receive);
  return()=>{window.removeEventListener("message",commands.receive);commands.dispose();};
 },[token]);
 const savedRefresh=useRef<{entryId:string;entryScope:string;sequence:number}|null>(null);
 const refreshedWindow=useRef<Window|null>(null),refreshedSequence=useRef(0),refreshedToken=useRef<number|null>(null);
 const deliveredToken=useRef<number|null>(null);
 useEffect(()=>setRefreshFailure(""),[token]);
 useEffect(()=>{
  let disposed=false,timer:ReturnType<typeof setTimeout>|undefined;
  const apply=(value:PluginState|null)=>{
   if(disposed)return;setPluginState(value);setConnectionProblem(statusProblem);
   if(value)setStatusRevision(value.revision);
   if(timer)clearTimeout(timer);
   if(statusProblem?.kind!=="stale")timer=setTimeout(()=>void refresh(),nextStatusCheckMs());
  };
  const refresh=async()=>apply(await readStatus());
  const onInvalidated=(value:PluginState|null)=>{
   if(value===null){setPluginState(null);setStatusRevision("");setFailedToken(null);}
   if(statusProblem?.kind==="stale")apply(null);else void refresh();
  };
  subscribers.add(onInvalidated);void refresh();
  return()=>{disposed=true;if(timer)clearTimeout(timer);subscribers.delete(onInvalidated);};
 },[]);
 const src=scopedUrl("/tavern-plugin-host.html?view=render&entryId="+encodeURIComponent(entryId??"")+(entryScope?"&scopeKey="+encodeURIComponent(entryScope):""));
 const deliver=()=>{
  const target=frame.current?.contentWindow,p=payload.current;if(!target||readyWindow.current!==target||readyToken.current!==p.token||deliveredWindow.current===target&&deliveredToken.current===p.token)return;
  if(p.helperEnabled){deliveredWindow.current=target;deliveredToken.current=p.token;target.postMessage({type:"liyuan-tavern-render",entryId:p.entryId,html:p.html},location.origin);}
  else if(p.templateEnabled){deliveredWindow.current=target;deliveredToken.current=p.token;target.postMessage({type:"liyuan-tavern-evaluate-template",entryId:p.entryId,requestId:p.token,html:p.html},location.origin);}
 };
 const deliverSavedState=()=>{
  const target=frame.current?.contentWindow,p=payload.current,request=savedRefresh.current;
  if(!target||!p.helperEnabled||!request||request.entryId!==p.entryId||request.entryScope!==p.entryScope||readyWindow.current!==target||readyToken.current!==p.token)return;
  if(refreshedWindow.current===target&&refreshedToken.current===p.token&&refreshedSequence.current===request.sequence)return;
  refreshedWindow.current=target;refreshedToken.current=p.token;refreshedSequence.current=request.sequence;
  target.postMessage({type:"liyuan-tavern-refresh-state",...request,requestId:request.sequence},location.origin);
 };
 useEffect(()=>{
  const refresh=(event:Event)=>{
   const source=(event as CustomEvent<{entryId?:string;entryScope?:string}>).detail;
   if(!entryId||!entryScope||source?.entryId!==entryId||source.entryScope!==entryScope)return;
   savedRefresh.current={entryId,entryScope,sequence:(savedRefresh.current?.sequence??0)+1};deliverSavedState();
  };
  window.addEventListener("liyuan:turn-state-refreshed",refresh);
  return()=>window.removeEventListener("liyuan:turn-state-refreshed",refresh);
 },[entryId,entryScope]);
 useEffect(()=>{
  const receive=(event:MessageEvent)=>{
   if(event.origin!==location.origin||event.source!==frame.current?.contentWindow)return;
   if(event.data?.type==="liyuan-tavern-ready"){readyWindow.current=frame.current?.contentWindow??null;readyToken.current=token;deliver();deliverSavedState();}
   else if(event.data?.type==="liyuan-tavern-height")setHeight(Math.max(100,Math.min(5000,Number(event.data.height)||180)));
   else if(event.data?.type==="liyuan-tavern-template-result"&&event.data.entryId===entryId&&event.data.requestId===token&&typeof event.data.html==="string")setEvaluatedHtml({token,html:event.data.html});
   else if(["liyuan-tavern-state-refreshed","liyuan-tavern-state-refresh-error"].includes(event.data?.type)&&event.data.entryId===entryId&&event.data.entryScope===entryScope&&event.data.requestId===savedRefresh.current?.sequence){
    setRefreshFailure(event.data.type==="liyuan-tavern-state-refreshed"?"":typeof event.data.error==="string"?event.data.error.replace(/[\u0000-\u001f]/g," ").slice(0,500):"变量刷新未完成");
   }
   else if(event.data?.type==="liyuan-tavern-error"){
    setFailureMessage(typeof event.data.error==="string"?event.data.error.replace(/[\u0000-\u001f]/g," ").slice(0,500):"");setFailedToken(token);
   }
  };
  window.addEventListener("message",receive);return()=>window.removeEventListener("message",receive);
 },[token,entryId,entryScope,helperEnabled,templateEnabled]);
 useEffect(()=>{deliver();deliverSavedState();},[html,entryId,entryScope,statusRevision,helperEnabled,templateEnabled,retryNonce]);
 const safeChild=(rendered=html)=>isValidElement(children)?cloneElement(children as ReactElement<HtmlChildProps>,{html:rendered,scripts:false}):children;
 const retry=()=>{setRefreshFailure("");setFailureMessage("");setFailedToken(null);setEvaluatedHtml(null);setRetryNonce(value=>value+1);invalidateStatus();};
 if(!entryId)return <>{children}</>;
 if(connectionProblem?.kind==="stale")return <section role="alert" className="tavern-connection-state"><p>{connectionProblem.message}</p><button type="button" onClick={requestWorkspaceReload}>保留草稿并刷新页面</button></section>;
 if(!pluginState)return <section role={connectionProblem?"alert":"status"} className="tavern-connection-state"><p>{connectionProblem?.message??"正在连接原卡交互界面…"}</p>{connectionProblem&&<button type="button" onClick={retry}>重试插件连接</button>}</section>;
 if(!pluginState.enabled)return <>{children}</>;
 if(failedToken===token)return <section role="alert"><p>原酒馆插件显示失败，脚本未继续执行。</p>{failureMessage&&<p>原因：{failureMessage}</p>}<button type="button" onClick={retry}>重试插件显示</button><details><summary>查看未运行脚本的静态内容（仅供诊断）</summary>{safeChild()}</details></section>;
 if(!helperEnabled&&templateEnabled){
  const rendered=evaluated?.token===token?evaluated.html:html;
  return <>{safeChild(rendered)}<iframe key={token} ref={frame} title="原酒馆模板求值隔离帧" src={src} sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups" aria-hidden="true" tabIndex={-1} style={{position:"absolute",width:1,height:1,opacity:0,pointerEvents:"none",border:0}} onLoad={deliver} onError={()=>{setFailureMessage("原插件显示宿主未能加载，请检查连接后重试。");setFailedToken(token);}} /></>;
 }
 return <>{refreshFailure&&<p role="status">原卡变量显示刷新失败：{refreshFailure} <button type="button" onClick={()=>{refreshedSequence.current=0;deliverSavedState();}}>重试变量显示刷新</button></p>}<iframe key={token} ref={frame} title="原酒馆插件交互显示" src={src} sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads" allow="clipboard-write" style={{width:"100%",height,border:0,background:"transparent"}} onLoad={deliver} onError={()=>{setFailureMessage("原插件显示宿主未能加载，请检查连接后重试。");setFailedToken(token);}} /></>;
}
