import {useEffect,useState} from 'react';
import {api} from '../api.ts';
import {switchMainWorkspace} from './WorkspaceBar.tsx';
import type {PlaySlot} from './PlaySlotsPanel.tsx';
/** This is a directory of canonical workspaces, not fabricated native session paths. */
export function ParallelSaves({prepare,toast,card}:{prepare:()=>boolean;toast:(level:'error',text:string)=>void;card?:string}){
 const [slots,setSlots]=useState<PlaySlot[]>([]),[working,setWorking]=useState(false);
 useEffect(()=>{let live=true;const refresh=()=>{void api<{slots:PlaySlot[]}>('/api/play-slots').then(value=>{if(live)setSlots(value.slots);}).catch(()=>{});};refresh();const timer=setInterval(refresh,5000);return()=>{live=false;clearInterval(timer);};},[]);
 const visible=card?slots.filter(slot=>slot.card===card||slot.card===undefined):slots;
 if(!visible.length)return null;
 return <details className="parallel-saves"><summary>{card?'此卡的多卡存档':'多卡存档'} · 可在主窗口继续（{visible.length}）</summary>
  <p className="field-hint">接管原存档，不是导入副本；分支、记忆、世界状态和插件状态继续使用原位置。未记录原卡路径的旧卡位也列在此处，可按卡位名称选择。</p>
  {visible.map(slot=><button key={slot.id} type="button" className="drawer-btn" disabled={working||slot.owner==='main'||slot.busy||['starting','pausing'].includes(slot.state)} onClick={()=>{
   setWorking(true);void switchMainWorkspace(slot.id,prepare).catch(error=>toast('error',error instanceof Error?error.message:'接管失败，存档保留')).finally(()=>setWorking(false));
  }}>{slot.name} · {slot.owner==='main'?'当前主窗口':'接管并继续'}</button>)}
 </details>;
}
