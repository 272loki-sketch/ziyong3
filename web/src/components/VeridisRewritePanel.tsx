import{useEffect,useRef,useState}from'react';
type Status={scopeKey:string;sourceEntryId:string;revision:number;upstreamCommit?:string;installed:boolean;enabled:boolean;autoUpdate:boolean;busy:boolean;version?:string;commit?:string;previousVersion?:string;candidateVersion?:string;pendingActivation?:boolean;updateAvailable?:boolean;lastError?:string;model?:{provider:string;id:string};receipt?:{status:string;changed:boolean;calls:number;reason?:string;hits?:number};settings?:Record<string,unknown>};
export function VeridisRewritePanel({contextTick,storyBusy=false,onOpenSettings}:{contextTick:number;storyBusy?:boolean;onOpenSettings?:()=>void}){
 const[status,setStatus]=useState<Status|null>(null),[error,setError]=useState(''),[feedback,setFeedback]=useState(''),[action,setAction]=useState(''),[editor,setEditor]=useState(false),[draft,setDraft]=useState('');const alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
 const request=async(path:string,method='GET',body?:unknown)=>{
  const r=await fetch('/api/veridis-rewrite/'+path,{method,credentials:'same-origin',signal:AbortSignal.timeout(method==='GET'?15000:180000),...(body!==undefined?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});const d=await r.json();if(!r.ok)throw Error(d.error??`HTTP ${r.status}`);return d as Status;
 };
 const reload=async()=>{try{const s=await request('status');if(alive.current){setStatus(s);setError('');}}catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e));}};
 useEffect(()=>{void reload();},[contextTick]);
 const run=async(name:string,method='POST',payload?:unknown)=>{if(action)return;setAction(name);setFeedback('');try{const s=await request(name,method,{...(payload as object??{}),scopeKey:status?.scopeKey,sourceEntryId:status?.sourceEntryId,revision:status?.revision,upstreamCommit:status?.upstreamCommit});if(alive.current){setStatus(s);setError('');setFeedback(s.pendingActivation?'候选已下载，尚未切换；等待兼容验收和宿主空闲。':'操作已完成。');}}catch(e){if(alive.current)setError(e instanceof Error?e.message:String(e));}finally{if(alive.current)setAction('');}};
 const busy=storyBusy||status?.busy||!!action,blocked=busy||!status||!!error;
 return <article className="npc-parallel-panel" aria-label="Veridis Rewrite 来源与更新"><header><h3>Veridis Rewrite · AI 八股净化</h3><span>{status?.installed?`已校验 ${status.version}`:'原版尚未安装'}</span></header>
  <p>完整作者交付后并发净化命中句子，独立显示稿不改原稿与剧情事实。变量、行动选项和原格式受保护；没有规则命中不调用模型。</p>
  <p>独立模型：{status?.model?`${status.model.provider} / ${status.model.id}`:'未配置'} · {status?.enabled?'已启用':'已关闭'}</p>
  {error&&<div role="alert">{error}<button type="button" onClick={()=>void reload()} disabled={!!action}>重新读取</button></div>}
  {feedback&&<p role="status">{feedback}</p>}{action&&<p role="status">正在处理 {action}…</p>}
  {status?.lastError&&<p role="alert">上次更新未完成：{status.lastError}</p>}
  {status?.receipt&&<p>本拍处理：{status.receipt.status==='complete'?(status.receipt.changed?'已生成净化显示稿':'无措辞变化'):status.receipt.status==='skipped'?(status.receipt.reason??'已跳过'):'失败，显示原稿'} · 请求尝试 {status.receipt.calls} 次</p>}
  {status?.candidateVersion&&<p>候选 {status.candidateVersion} · {status.pendingActivation?'待验收／待切换':'尚未激活'}</p>}
  <div className="npc-parallel-actions">
   <button type="button" disabled={busy||!status?.installed} onClick={onOpenSettings}>打开原版工作台／上传规则</button>
   {!status?.installed&&<button type="button" disabled={blocked} onClick={()=>void run('install')}>安装原版</button>}
   <button type="button" aria-pressed={!!status?.enabled} disabled={blocked||!status?.installed||!status?.model} onClick={()=>void run('config','PUT',{enabled:!status?.enabled})}>{status?.enabled?'关闭净化':'启用净化'}</button>
   <button type="button" aria-pressed={!!status?.autoUpdate} disabled={blocked} onClick={()=>void run('config','PUT',{autoUpdate:!status?.autoUpdate})}>自动更新：{status?.autoUpdate?'开启':'关闭'}</button>
   <button type="button" disabled={blocked} onClick={()=>void run('check')}>检查更新</button>
   <button type="button" disabled={blocked||!status?.updateAvailable} onClick={()=>void run('update')}>更新并验收</button>
   <button type="button" disabled={blocked||!status?.previousVersion} onClick={()=>void run('rollback')}>回退上一版</button>
   <button type="button" disabled={blocked} onClick={()=>{setError('');setDraft(JSON.stringify(status?.settings??{},null,2));setEditor(!editor);}}>宿主规则设置</button>
  </div>
  {editor&&<section><p>这是梨园宿主的规则 JSON 管理入口，不是对上游完整工作台的仿制。可调整匹配规则或关闭某条规则；改写使用上游原规则引擎与提示词。不得填入 API Key，模型由独立岗位管理。</p><textarea aria-label="Veridis Rewrite 宿主规则 JSON" value={draft} onChange={e=>setDraft(e.target.value)} rows={12} style={{width:'100%',fontFamily:'monospace'}}/><button type="button" disabled={busy||!status} onClick={()=>{try{const settings=JSON.parse(draft);void run('settings','PUT',{settings,scopeKey:status?.scopeKey,sourceEntryId:status?.sourceEntryId,revision:status?.revision,upstreamCommit:status?.upstreamCommit});}catch{setError('规则 JSON 无效，请检查后重试');}}}>保存规则设置</button></section>}
 </article>;
}
