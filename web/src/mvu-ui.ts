/** UI-only labels; module enablement is not proof that a saved round was processed. */
export interface MvuUiState {
 enabled:boolean; installed:boolean; version:string; commit:string; dependencies:number;
 helper:{enabled:boolean;installed:boolean};
 binding:{scopeKey:string;sourceEntryId:string};
 streaming:boolean; pluginBusy:boolean; canRecover:boolean; recoveryReason?:string;
 variables:{rootCount:number;hasData:boolean};
 receipt?:{status:string;at?:string};
}
export interface MvuRecoveryResult {scopeKey?:string;sourceEntryId:string;status:string;variableRootKeys?:number}
export function mvuRecoveryMessage(result:MvuRecoveryResult):string {
 const messages:Record<string,string>={updated:"变量已更新并保存。",unchanged:"核对完成，原 MVU 未发现新的变量变动。",existing:"已有变量数据已采用，没有重复更新。",reused:"这轮已经处理过，已复用现有结果，没有重复更新。"};
 const message=Object.hasOwn(messages,result.status)?messages[result.status]:undefined;
 if(!message)throw new Error("恢复接口未返回可识别的处理结果，请刷新状态核对，不把未知结果当作成功。");
 return message+(result.variableRootKeys===undefined?"":` 当前变量根分组 ${result.variableRootKeys} 个。`);
}
export function sameMvuBinding(a:MvuUiState["binding"]|undefined,b:MvuUiState["binding"]|undefined):boolean {
 return !!a&&!!b&&a.scopeKey===b.scopeKey&&a.sourceEntryId===b.sourceEntryId;
}

export function mvuReceiptMessage(status:string):string {
 if(status==="normal")return "这轮已执行原 MVU 正常拍后处理。";
 try{return mvuRecoveryMessage({sourceEntryId:"",status});}catch{return "暂未识别的历史状态，请刷新核对。";}
}
