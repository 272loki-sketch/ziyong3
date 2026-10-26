import { scopedUrl } from "../workspace.ts";
import {useEffect,useRef,useState} from 'react';
import '../npc-parallel.css';
import {PluginLeaveError,usePluginLeave} from '../plugins/usePluginLeave.tsx';
type OriginalHost={ready?:()=>boolean;error?:string;flush?:()=>Promise<void>;failed?:boolean};
/** The original private modules own the controls; this wrapper only owns navigation/readiness. */
export function VeridisRewriteOriginalSettings({contextTick,onBack}:{contextTick:number;onBack:()=>void}){
 const frame=useRef<HTMLIFrameElement>(null),backRef=useRef(onBack),root=useRef<HTMLElement>(null);
 const {leave,pending:leaving,error:leaveError,discard}=usePluginLeave(root,contextTick);
 backRef.current=()=>leave(onBack);
 const [attempt,setAttempt]=useState(0),[phase,setPhase]=useState<'loading'|'ready'|'error'>('loading'),[error,setError]=useState('');
 useEffect(()=>{
  let active=true;setPhase('loading');setError('');
  const check=()=>{if(!active)return;try{const host=(frame.current?.contentWindow as (Window&{LiyuanVeridisRewrite?:OriginalHost})|null)?.LiyuanVeridisRewrite;if(host?.ready?.()){setPhase('ready');clearInterval(timer);clearTimeout(deadline);}else if(host?.error){setError(host.error);setPhase('error');clearInterval(timer);clearTimeout(deadline);}}catch{setError('无法读取同源原版工作台');setPhase('error');clearInterval(timer);clearTimeout(deadline);}};
  const timer=window.setInterval(check,150),deadline=window.setTimeout(()=>{if(active){setError('原版工作台加载超时，未将空页面当作完成');setPhase('error');clearInterval(timer);}},25000);
  const message=(event:MessageEvent)=>{if(event.origin===location.origin&&event.source===frame.current?.contentWindow&&event.data?.type==='liyuan:veridis-rewrite-close')backRef.current();};window.addEventListener('message',message);
  let observed:Document|null=null;
  const key=(event:KeyboardEvent)=>{if(event.key==='Escape'&&!observed?.querySelector('dialog[open]')){event.preventDefault();event.stopImmediatePropagation();backRef.current();}};
  const bind=()=>{try{observed?.removeEventListener('keydown',key);observed=frame.current?.contentDocument??null;observed?.addEventListener('keydown',key);}catch{/* Readiness reports inaccessible documents. */}};
  const element=frame.current;element?.addEventListener('load',bind);bind();
  return()=>{active=false;clearInterval(timer);clearTimeout(deadline);window.removeEventListener('message',message);element?.removeEventListener('load',bind);observed?.removeEventListener('keydown',key);};
 },[contextTick,attempt]);
 const back=()=>leave(onBack);
 const reload=()=>leave(()=>setAttempt(n=>n+1));
 const theme=document.documentElement.dataset.theme==='dark'?'dark':'light';
 return <section ref={root} className="npc-parallel-manager is-embedded" aria-label="Veridis Rewrite 原版工作台">
  <header className="npc-parallel-manager-header"><div><strong>Veridis Rewrite 原版工作台</strong></div><div className="npc-parallel-manager-actions">
   <button type="button" className="npc-parallel-button" disabled={leaving} onClick={back}>返回插件详情</button>
   <button type="button" className="npc-parallel-button" disabled={leaving} onClick={reload}>重新载入工作台</button>
   <span role="status">{leaving?'正在等待原设置保存确认…':phase==='loading'?'正在加载原版工作台…':phase==='ready'?'原版工作台已就绪':'原版工作台未完成'}</span>
  </div></header>
  <PluginLeaveError error={leaveError} discard={discard}/>
  {error&&<p className="npc-parallel-feedback is-error" role="alert">{error}</p>}
  <div className={`npc-parallel-frame-wrap${phase!=='ready'?' is-not-ready':''}`}>
   <iframe key={`${contextTick}:${attempt}`} ref={frame} title="Veridis Rewrite 原版规则工作台" src={scopedUrl(`/veridis-rewrite-host.html?theme=${theme}&attempt=${attempt}`)} sandbox="allow-scripts allow-same-origin allow-downloads allow-modals" aria-hidden={phase!=='ready'} inert={phase!=='ready'} />
   {phase!=='ready'&&<div className={`npc-parallel-frame-state${phase==='error'?' is-error':''}`} role={phase==='error'?'alert':'status'}><strong>{phase==='loading'?'正在等待原版工作台报告就绪…':'原版工作台尚未就绪'}</strong>{phase==='error'&&<><span>{error}</span><button type="button" className="npc-parallel-button" onClick={reload}>重新载入并重试</button></>}</div>}
  </div>
 </section>;
}
