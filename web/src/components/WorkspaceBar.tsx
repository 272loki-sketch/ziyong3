import {useEffect,useState} from 'react';
import {api} from '../api.ts';
import {workspaceContext,workspaceStale,markWorkspaceStale,type MainWorkspace} from '../workspace.ts';
export async function switchMainWorkspace(id:string|null,prepare:()=>boolean):Promise<void>{
 if(!prepare())return;
 const current=workspaceContext();if(!current)throw Error('请刷新到支持同档接管的新界面后重试');
 await api('/api/play-slots/main',{method:'POST',body:JSON.stringify({id,expectedWorkspace:current.workspace,expectedLease:current.lease})});
 // This deliberate reload mounts the full UI once, against the same running engine/save.
 location.assign('/');
}
export function WorkspaceBar({prepare,onParallel}:{prepare:()=>boolean;onParallel:()=>void}){
 const [status,setStatus]=useState<MainWorkspace|null>(null),[stale,setStale]=useState(workspaceStale),[error,setError]=useState(''),[working,setWorking]=useState(false);
 useEffect(()=>{
  let active=true;
  const refresh=()=>{void api<MainWorkspace>('/api/play-slots/main').then(value=>{if(!active)return;setStatus(value);const own=workspaceContext();if(own&&(own.workspace!==value.workspace||own.lease!==value.lease))markWorkspaceStale();}).catch(()=>{});};
  refresh();const timer=setInterval(refresh,5000),changed=()=>setStale(true);window.addEventListener('liyuan:workspace-changed',changed);
  return()=>{active=false;clearInterval(timer);window.removeEventListener('liyuan:workspace-changed',changed);};
 },[]);
 const back=async()=>{setWorking(true);try{await switchMainWorkspace(null,prepare);}catch(e){setError(e instanceof Error?e.message:'切换失败');}finally{setWorking(false);}};
 if(!stale&&!status?.slot)return null;
 return <aside className="workspace-bar" aria-label="主窗口故事归属"><span role="status">{stale?'窗口连接已过期（服务重启或窗口切换）；此页已停止发送，草稿保留。':`当前接管多卡存档：${status?.slot?.name} · 同一份故事与记忆`}</span>{stale?<button type="button" className="drawer-btn" onClick={()=>{if(prepare())location.assign('/');}}>保留草稿并刷新</button>:<><button type="button" className="drawer-btn" disabled={working} onClick={()=>void back()}>放回多卡，返回原主窗口</button><button type="button" className="drawer-btn" onClick={onParallel}>管理多卡</button></>}{error&&<p role="alert">{error}</p>}</aside>;
}
