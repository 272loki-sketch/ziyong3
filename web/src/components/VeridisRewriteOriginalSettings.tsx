import {useEffect,useRef,useState} from 'react';
import '../npc-parallel.css';
type OriginalHost={ready?:()=>boolean;error?:string;flush?:()=>Promise<void>;failed?:boolean};
/** The original private modules own the controls; this wrapper only owns navigation/readiness. */
export function VeridisRewriteOriginalSettings({contextTick,onBack}:{contextTick:number;onBack:()=>void}){
 const frame=useRef<HTMLIFrameElement>(null),backRef=useRef(onBack);backRef.current=onBack;
 const [attempt,setAttempt]=useState(0),[phase,setPhase]=useState<'loading'|'ready'|'error'>('loading'),[error,setError]=useState('');
 useEffect(()=>{
  let active=true;setPhase('loading');setError('');
  const check=()=>{if(!active)return;try{const host=(frame.current?.contentWindow as (Window&{LiyuanVeridisRewrite?:OriginalHost})|null)?.LiyuanVeridisRewrite;if(host?.ready?.()){setPhase('ready');clearInterval(timer);clearTimeout(deadline);}else if(host?.error){setError(host.error);setPhase('error');clearInterval(timer);clearTimeout(deadline);}}catch{setError('无法读取同源原版工作台');setPhase('error');}};
  const timer=window.setInterval(check,150),deadline=window.setTimeout(()=>{if(active){setError('原版工作台加载超时，未将空页面当作完成');setPhase('error');clearInterval(timer);}},25000);
  const message=(event:MessageEvent)=>{if(event.origin===location.origin&&event.source===frame.current?.contentWindow&&event.data?.type==='liyuan:veridis-rewrite-close')backRef.current();};window.addEventListener('message',message);
  return()=>{active=false;clearInterval(timer);clearTimeout(deadline);window.removeEventListener('message',message);};
 },[contextTick,attempt]);
 const back=async()=>{const host=(frame.current?.contentWindow as (Window&{LiyuanVeridisRewrite?:OriginalHost})|null)?.LiyuanVeridisRewrite;await host?.flush?.();if(host?.failed)setError('设置保存失败；请先核对来源／重新读取，不会报告保存成功。');else onBack();};
 const theme=document.documentElement.dataset.theme==='dark'?'dark':'light';
 return <section className="npc-parallel-manager is-embedded" aria-label="Veridis Rewrite 原版工作台"><header className="npc-parallel-manager-header"><div><strong>Veridis Rewrite 原版工作台</strong></div><div className="npc-parallel-manager-actions"><button type="button" className="npc-parallel-button" onClick={()=>void back()}>返回插件列表</button><button type="button" className="npc-parallel-button" onClick={()=>setAttempt(n=>n+1)}>重新载入工作台</button><span role="status">{phase==='loading'?'正在加载原版工作台…':phase==='ready'?'原版工作台已就绪':'原版工作台未完成'}</span></div></header>{error&&<p role="alert">{error}</p>}<div className="npc-parallel-frame-wrap"><iframe key={`${contextTick}:${attempt}`} ref={frame} title="Veridis Rewrite 原版规则工作台" src={`/veridis-rewrite-host.html?theme=${theme}&attempt=${attempt}`} sandbox="allow-scripts allow-same-origin allow-downloads allow-modals" /></div></section>;
}
