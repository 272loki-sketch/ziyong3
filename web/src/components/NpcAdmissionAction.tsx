/** Explicit source-bound recovery; never generates author text or new sidewrites. */
import {useState} from 'react';
import {apiPost} from '../api.ts';
export function NpcAdmissionAction({sessionId,sourceEntryId,candidateHashes}:{sessionId:string;sourceEntryId:string;candidateHashes:string[]}){
 const [adopting,setAdopting]=useState(false),[error,setError]=useState('');
 const recover=async()=>{
  if(adopting)return;setAdopting(true);setError('');
  try{const result=await apiPost<{error?:string}>('/api/turn/retry-npc-admission',{expectedSessionId:sessionId,expectedSourceEntryId:sourceEntryId,candidateHashes});if(result.error)setError(result.error);}
  catch(failure){setError(failure instanceof Error?failure.message:String(failure));}
  finally{setAdopting(false);}
 };
 return <><button type="button" className="drawer-btn" disabled={adopting} onClick={recover}>{adopting?'正在补办采纳…':'复用已有侧写，仅补采纳'}</button>{error&&<p role="alert">{error}</p>}</>;
}
