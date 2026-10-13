import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { mvuRecoveryMessage, mvuReceiptMessage, sameMvuBinding, type MvuUiState, type MvuRecoveryResult } from "../mvu-ui.ts";
import { IconCheck, IconChevronDown, IconRefresh, IconSettings } from "./icons.tsx";
import "./MvuPanel.css";

type Toast=(level:"info"|"warning"|"error",text:string)=>void;
type Action="toggle"|"recover"|"settings";
interface Feedback {kind:"info"|"success"|"error";text:string;source?:string}
export interface MvuSettingsTarget {version:string;commit:string}

/** Native-drawer-inspired management shell. It never parses/rebuilds story or variable data. */
export function MvuPanel({toast,contextTick=0,storyBusy=false,onOpenSettings}:{
 toast:Toast;contextTick?:number;storyBusy?:boolean;onOpenSettings?:(target:MvuSettingsTarget,signal:AbortSignal)=>Promise<void>;
}) {
 const [view,setView]=useState<MvuUiState|null>(null),[loading,setLoading]=useState(true);
 const [loadError,setLoadError]=useState(""),[action,setAction]=useState<Action|null>(null);
 const [feedback,setFeedback]=useState<Feedback|null>(null),[seconds,setSeconds]=useState(0);
 const mounted=useRef(true),loadTicket=useRef(0),activeView=useRef<MvuUiState|null>(null);
 const actionTicket=useRef(0),operation=useRef<{ticket:number;controller:AbortController;binding:MvuUiState["binding"]}|null>(null);
 const readController=useRef<AbortController|null>(null);
 const refresh=useCallback(async()=>{
  const ticket=++loadTicket.current;readController.current?.abort();
  const controller=new AbortController(),timeout=AbortSignal.timeout(15000);readController.current=controller;
  setLoading(true);setLoadError("");
  try{
   const next=await api<MvuUiState>("/api/tavern-plugins/mvu/view",{signal:AbortSignal.any([controller.signal,timeout])});
   if(!mounted.current||ticket!==loadTicket.current)return;
   const previous=activeView.current;
   if(previous&&!sameMvuBinding(previous.binding,next.binding)){
    operation.current?.controller.abort();operation.current=null;actionTicket.current++;
    setAction(null);setFeedback({kind:"info",text:"会话或回合已切换，已载入当前状态；旧操作结果不会覆盖这里。"});
   }
   activeView.current=next;setView(next);
  }catch(error){
   if(mounted.current&&ticket===loadTicket.current&&!controller.signal.aborted)setLoadError(timeout.aborted?"状态读取超时，请重新读取后再操作。":error instanceof Error?error.message:"MVU状态读取失败，请重试。");
  }finally{if(mounted.current&&ticket===loadTicket.current)setLoading(false);}
 },[]);
 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;loadTicket.current++;actionTicket.current++;readController.current?.abort();operation.current?.controller.abort();};},[]);
 useEffect(()=>{void refresh();},[contextTick,refresh]);
 useEffect(()=>{const changed=()=>void refresh();window.addEventListener("liyuan:tavern-plugins-changed",changed);return()=>window.removeEventListener("liyuan:tavern-plugins-changed",changed);},[refresh]);
 useEffect(()=>{
  if(!action){setSeconds(0);return;}
  const start=performance.now(),timer=window.setInterval(()=>setSeconds(Math.floor((performance.now()-start)/1000)),1000);
  return()=>window.clearInterval(timer);
 },[action]);
 const run=async(kind:Action)=>{
  const current=activeView.current;
  if(operation.current||!current||loading||loadError||storyBusy||current.streaming||current.pluginBusy)return;
  if(kind==="recover"&&!current.canRecover)return;
  if(kind==="settings"&&(!onOpenSettings||!current.enabled||!current.installed||!current.helper.enabled||!current.helper.installed))return;
  const controller=new AbortController(),ticket=++actionTicket.current;
  operation.current={ticket,controller,binding:current.binding};setAction(kind);setSeconds(0);
   setFeedback({kind:"info",text:kind==="toggle"?(current.enabled?"正在关闭 MVU…":"正在启用 MVU…"):kind==="settings"?"正在打开原版 MVU 设置…":"正在重试原 MVU 变量更新；额外解析模式可能调用独立模型，请勿重复点击…"});
  const timeout=AbortSignal.timeout(kind==="recover"?90000:20000);
  try{
   if(kind==="settings"){
    await onOpenSettings!({version:current.version,commit:current.commit},AbortSignal.any([controller.signal,timeout]));
   }else if(kind==="toggle"){
    const next=await api<{enabled:boolean;installed:boolean;version:string;commit:string;dependencies:number}>("/api/tavern-plugins/mvu",{method:"PUT",body:JSON.stringify({enabled:!current.enabled}),signal:AbortSignal.any([controller.signal,timeout])});
    if(!mounted.current||ticket!==actionTicket.current||!sameMvuBinding(current.binding,activeView.current?.binding))return;
    if(next.enabled!==!current.enabled)throw new Error("启停接口未返回预期状态，请刷新核对，不把未知结果当作成功。");
    activeView.current={...current,...next};setView(activeView.current);
    setFeedback({kind:"success",text:next.enabled?"MVU 已启用。原设置页重新打开后加载；已有变量不会被清空。":"MVU 已关闭。已有变量和正文仍保留。"});
    window.dispatchEvent(new CustomEvent("liyuan:tavern-plugins-changed"));
   }else{
    const result=await api<MvuRecoveryResult>("/api/mvu/recover",{method:"POST",body:JSON.stringify({scopeKey:current.binding.scopeKey,sourceEntryId:current.binding.sourceEntryId}),signal:AbortSignal.any([controller.signal,timeout])});
    if(!mounted.current||ticket!==actionTicket.current||!sameMvuBinding(current.binding,activeView.current?.binding))return;
     if(result.sourceEntryId!==current.binding.sourceEntryId||result.scopeKey!==current.binding.scopeKey)throw new Error("恢复结果与当前回合不一致，未显示为成功；请刷新核对。");
    setFeedback({kind:"success",text:mvuRecoveryMessage(result),source:result.sourceEntryId});
   }
  }catch(error){
   if(mounted.current&&ticket===actionTicket.current&&!controller.signal.aborted){
    const text=timeout.aborted?"等待接口结果超时，请先刷新状态核对。请求可能已经执行，不会把超时当成成功。":error instanceof Error?error.message:"操作失败，请刷新后重试。";
    setFeedback({kind:"error",text});toast("error",text);
   }
  }finally{
   if(mounted.current&&ticket===actionTicket.current){operation.current=null;setAction(null);void refresh();}
  }
 };
 const busy=!!action,waiting=storyBusy||!!view?.streaming||!!view?.pluginBusy;
 const disabled=busy||loading||waiting||!!loadError;
 const helperReady=!!view?.helper.enabled&&!!view.helper.installed;
 const stateText=loading&&!view?"读取中":!view?"状态不可用":!view.installed?"未安装":view.enabled?"已启用":"已关闭";
 const reason=waiting?"本拍或插件任务正在进行，请完成后再修改设置或恢复变量。":view?.recoveryReason;
 const canOpen=!!view?.enabled&&view.installed&&helperReady&&!disabled;
 return <section className="mvu-panel" aria-label="MVU变量系统" aria-busy={busy||loading}>
  <header className="mvu-panel-header">
   <div className="mvu-panel-mark" aria-hidden="true">MVU</div>
   <div className="mvu-panel-heading"><h3>MVU 变量框架</h3><p>角色卡变量 · 原版框架运行</p></div>
   <span className={`mvu-state-badge ${view?.enabled&&view.installed?"is-on":""}`}><span aria-hidden="true"/>{stateText}</span>
   <button type="button" className="mvu-icon-button" aria-label="刷新MVU状态" title="刷新 MVU 状态" disabled={loading} onClick={()=>void refresh()}><IconRefresh size={17}/></button>
  </header>
  {loadError&&<div className="mvu-feedback is-error" role="alert"><div><strong>状态读取失败</strong><p>{loadError}</p><button type="button" className="mvu-button" onClick={()=>void refresh()}>重新读取状态</button></div></div>}
  <div className="mvu-panel-content">
   <div className="mvu-control-row"><div><strong>启用 MVU</strong><p>随作者交付更新变量；关闭不会删除现有数据。</p></div>
    <button type="button" className={`mvu-switch ${view?.enabled?"is-on":""}`} role="switch" aria-label="启用MVU" aria-checked={!!view?.enabled} disabled={disabled||!view||(!view.installed&&!view.enabled)} onClick={()=>void run("toggle")}><span/></button>
   </div>
   {view?.enabled&&!helperReady&&<p className="mvu-blocked-note">MVU 依赖已启用的原酒馆助手，请先在上方酒馆助手卡片启用并安装原助手。</p>}
   {reason&&<p className="mvu-blocked-note" role="note">{reason}</p>}
   <div className="mvu-toolbar">
    <button type="button" className="mvu-button primary" disabled={!canOpen||!onOpenSettings} onClick={()=>void run("settings")}><IconSettings size={16}/> 打开原版 MVU 设置</button>
     <button type="button" className="mvu-button" disabled={disabled||!view?.canRecover} onClick={()=>void run("recover")}><IconRefresh size={16}/>{action==="recover"?"正在重试变量…":"重试本回合变量"}</button>
   </div>
    <p className="mvu-operation-note">只重试当前完整交付的原 MVU；额外解析可调用独立模型并消耗本来源额度。不重写正文，不重复其它插件、生态或数据库结算。</p>
   {feedback&&<div className={`mvu-feedback is-${feedback.kind}`} role={feedback.kind==="error"?"alert":"status"} aria-live="polite">
    {busy?<span className="mvu-spinner" aria-hidden="true"/>:feedback.kind==="success"?<IconCheck size={18}/>:<span className="mvu-feedback-dot" aria-hidden="true"/>}
    <div><p>{feedback.text}</p>{busy&&<small>已等待 {seconds} 秒{action==="recover"?" · 首次打开原框架可能需要几秒钟":""}</small>}{feedback.source&&<small>回合 {feedback.source}</small>}</div>
   </div>}
   <details className="mvu-fold"><summary><IconChevronDown size={14}/><span>当前变量状态</span><small>{view?.variables.hasData?`${view.variables.rootCount} 个根分组`:"尚无已存变量"}</small></summary><div className="mvu-fold-body">
    <dl><div><dt>当前回合</dt><dd>{view?.binding.sourceEntryId??"尚未读取"}</dd></div><div><dt>变量分组</dt><dd>{view?.variables.rootCount??0}</dd></div><div><dt>处理收据</dt><dd>{view?.receipt?mvuReceiptMessage(view.receipt.status):"没有本回合的 MVU 处理收据"}</dd></div></dl>
   </div></details>
   <details className="mvu-fold"><summary><IconChevronDown size={14}/><span>版本与接入说明</span><small>{view?.version??"—"}</small></summary><div className="mvu-fold-body"><dl><div><dt>原版框架</dt><dd>MagVarUpdate {view?.version??"—"}</dd></div><div><dt>依赖校验</dt><dd>{view?.installed?`已校验 · ${view.dependencies} 项依赖`:"尚未通过安装校验"}</dd></div><div><dt>固定版本</dt><dd><code>{view?.commit?.slice(0,12)??"—"}</code></dd></div></dl><p>更多更新方式、通知和原框架配置，在“原版 MVU 设置”中管理。未适配的能力不会假报可用。</p></div></details>
  </div>
 </section>;
}
