/** Original plugin realm receives display HTML in memory, never as a URL or a story write. */
import { createContext, useContext, useEffect, useRef, useState, cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
export const TavernEntryContext = createContext<{entryId?:string;entryScope?:string} | undefined>(undefined);
const STATUS_PATH="/api/tavern-plugins/status";
const STATUS_TTL_MS=15_000;
const MAX_RETRY_MS=30_000;
type PluginState={enabled:boolean;helperEnabled:boolean;templateEnabled:boolean;revision:string};
type StatusResult={value:PluginState;expiresAt:number};
let cachedStatus:StatusResult|null=null;
let retryAt=0;
let retryDelay=500;
let requestInFlight:Promise<PluginState|null>|null=null;
let requestEpoch=0;
let listenerInstalled=false;
const subscribers=new Set<(value:PluginState|null)=>void>();
function invalidateStatus(){
 requestEpoch++;cachedStatus=null;retryAt=0;retryDelay=500;requestInFlight=null;
 for(const subscriber of subscribers)subscriber(null);
}
function ensureStatusListener(){
 if(listenerInstalled||typeof window==="undefined")return;
 listenerInstalled=true;window.addEventListener("liyuan:tavern-plugins-changed",invalidateStatus);
}
function readStatus():Promise<PluginState|null>{
 ensureStatusListener();const now=Date.now();
 if(cachedStatus&&now<cachedStatus.expiresAt)return Promise.resolve(cachedStatus.value);
 if(requestInFlight)return requestInFlight;
 if(now<retryAt)return Promise.resolve(null);
 const epoch=requestEpoch,controller=new AbortController();
 const timeout=setTimeout(()=>controller.abort(),8_000);
 const request=fetch(STATUS_PATH,{cache:"no-store",signal:controller.signal}).then(async response=>{
  const result=await response.json() as {runtimeEnabled:boolean;plugins?:Array<{id?:string;enabled?:boolean;installed?:boolean;version?:string;commit?:string;sha256?:string}>};
  if(!response.ok||typeof result.runtimeEnabled!=="boolean")throw new Error("酒馆插件状态响应无效");
  const plugins=result.plugins??[];
  const helper=plugins.find(plugin=>plugin.id==="helper"),template=plugins.find(plugin=>plugin.id==="template");
  const helperEnabled=helper?.enabled===true&&helper.installed===true;
  const templateEnabled=template?.enabled===true&&template.installed===true;
  const revision=JSON.stringify(plugins.map(plugin=>[plugin.id,plugin.enabled,plugin.installed,plugin.version,plugin.commit,plugin.sha256]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
  const value={enabled:result.runtimeEnabled&&(helperEnabled||templateEnabled),helperEnabled,templateEnabled,revision};
  if(epoch===requestEpoch){cachedStatus={value,expiresAt:Date.now()+STATUS_TTL_MS};retryAt=0;retryDelay=500;}
  return epoch===requestEpoch?value:null;
 }).catch(()=>{
  if(epoch===requestEpoch){cachedStatus=null;retryAt=Date.now()+retryDelay;retryDelay=Math.min(MAX_RETRY_MS,retryDelay*2);}
  return null;
 }).finally(()=>{clearTimeout(timeout);if(epoch===requestEpoch&&requestInFlight===request)requestInFlight=null;});
 requestInFlight=request;return request;
}
function nextStatusCheckMs(){return cachedStatus?STATUS_TTL_MS:Math.max(100,retryAt-Date.now());}
type HtmlChildProps={html?:string;scripts?:boolean};
export function TavernMessageFrame({html,children}:{html:string;children:ReactNode}){
 const {entryId,entryScope}=useContext(TavernEntryContext)??{};
 const [pluginState,setPluginState]=useState<PluginState|null>(null),[statusRevision,setStatusRevision]=useState(""),[failedToken,setFailedToken]=useState<number|null>(null),[retryNonce,setRetryNonce]=useState(0),[height,setHeight]=useState(180),[evaluated,setEvaluatedHtml]=useState<{token:number;html:string}|null>(null);
 const frame=useRef<HTMLIFrameElement>(null),readyToken=useRef<number|null>(null);
 const tokenRef=useRef({entryScope,entryId,html,statusRevision,retryNonce,token:0});
 const previous=tokenRef.current;
 if(previous.entryScope!==entryScope||previous.entryId!==entryId||previous.html!==html||previous.statusRevision!==statusRevision||previous.retryNonce!==retryNonce)tokenRef.current={entryScope,entryId,html,statusRevision,retryNonce,token:previous.token+1};
 const token=tokenRef.current.token;
 const helperEnabled=pluginState?.helperEnabled===true,templateEnabled=pluginState?.templateEnabled===true;
 const payload=useRef({html,entryId,helperEnabled,templateEnabled,token});payload.current={html,entryId,helperEnabled,templateEnabled,token};
 const deliveredToken=useRef<number|null>(null);
 useEffect(()=>{
  let disposed=false,timer:ReturnType<typeof setTimeout>|undefined;
  const apply=(value:PluginState|null)=>{
   if(disposed)return;setPluginState(value);
   if(value)setStatusRevision(value.revision);
   if(timer)clearTimeout(timer);
   timer=setTimeout(()=>void refresh(),nextStatusCheckMs());
  };
  const refresh=async()=>apply(await readStatus());
  const onInvalidated=(value:PluginState|null)=>{
   if(value===null){setPluginState(null);setStatusRevision("");setFailedToken(null);}
   void refresh();
  };
  subscribers.add(onInvalidated);void refresh();
  return()=>{disposed=true;if(timer)clearTimeout(timer);subscribers.delete(onInvalidated);};
 },[]);
 const src="/tavern-plugin-host.html?view=render&entryId="+encodeURIComponent(entryId??"")+(entryScope?"&scopeKey="+encodeURIComponent(entryScope):"");
 const deliver=()=>{
  const target=frame.current?.contentWindow,p=payload.current;if(!target||readyToken.current!==p.token||deliveredToken.current===p.token)return;
  if(p.helperEnabled){deliveredToken.current=p.token;target.postMessage({type:"liyuan-tavern-render",entryId:p.entryId,html:p.html},location.origin);}
  else if(p.templateEnabled){deliveredToken.current=p.token;target.postMessage({type:"liyuan-tavern-evaluate-template",entryId:p.entryId,requestId:p.token,html:p.html},location.origin);}
 };
 useEffect(()=>{
  const receive=(event:MessageEvent)=>{
   if(event.origin!==location.origin||event.source!==frame.current?.contentWindow)return;
   if(event.data?.type==="liyuan-tavern-ready"){readyToken.current=token;deliver();}
   else if(event.data?.type==="liyuan-tavern-height")setHeight(Math.max(100,Math.min(5000,Number(event.data.height)||180)));
   else if(event.data?.type==="liyuan-tavern-template-result"&&event.data.entryId===entryId&&event.data.requestId===token&&typeof event.data.html==="string")setEvaluatedHtml({token,html:event.data.html});
   else if(event.data?.type==="liyuan-tavern-error")setFailedToken(token);
  };
  window.addEventListener("message",receive);return()=>window.removeEventListener("message",receive);
 },[token,entryId,helperEnabled,templateEnabled]);
 useEffect(()=>{deliver();},[html,entryId,entryScope,statusRevision,helperEnabled,templateEnabled,retryNonce]);
 const safeChild=(rendered=html)=>isValidElement(children)?cloneElement(children as ReactElement<HtmlChildProps>,{html:rendered,scripts:false}):children;
 const retry=()=>{setFailedToken(null);setEvaluatedHtml(null);setRetryNonce(value=>value+1);invalidateStatus();};
 if(!entryId)return <>{children}</>;
 if(!pluginState)return <>{safeChild()}</>;
 if(!pluginState.enabled)return <>{children}</>;
 if(failedToken===token)return <section role="alert"><p>原酒馆插件显示失败，脚本未继续执行。</p><button type="button" onClick={retry}>重试插件显示</button>{safeChild()}</section>;
 if(!helperEnabled&&templateEnabled){
  const rendered=evaluated?.token===token?evaluated.html:html;
  return <>{safeChild(rendered)}<iframe key={token} ref={frame} title="原酒馆模板求值隔离帧" src={src} sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups" aria-hidden="true" tabIndex={-1} style={{position:"absolute",width:1,height:1,opacity:0,pointerEvents:"none",border:0}} onLoad={deliver} onError={()=>setFailedToken(token)} /></>;
 }
 return <iframe key={token} ref={frame} title="原酒馆插件交互显示" src={src} sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-popups" style={{width:"100%",height,border:0,background:"transparent"}} onLoad={deliver} onError={()=>setFailedToken(token)} />;
}
