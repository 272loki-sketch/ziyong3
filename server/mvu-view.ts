/** Read-only management projection: never starts the MVU runtime or returns variable/story values. */
import type { TavernPluginContext } from "./tavern-plugin-http.ts";
import type { TavernPluginState } from "./tavern-plugin-store.ts";
import type { mvuStatus } from "./mvu-assets.ts";
interface HelperStatus {enabled:boolean;installed:boolean}
const record=(value:unknown):Record<string,unknown>|undefined=>value!==null&&typeof value==="object"&&!Array.isArray(value)?value as Record<string,unknown>:undefined;
export function mvuManagementView(asset:ReturnType<typeof mvuStatus>,context:TavernPluginContext & {scopeKey:string},state:TavernPluginState,helper:HelperStatus,streaming:boolean,pluginBusy:boolean){
 const source=context.sourceEntryId,message=context.chat.find(row=>row.__liyuanEntryId===source);
 const fields=record(state.messages[source]),variables=fields?.variables,slot=Array.isArray(variables)?variables[Number(message?.swipe_id)||0]:variables;
 const data=record(record(slot)?.stat_data),rootCount=data?Object.keys(data).length:0;
 const receipts=record(state.chatMetadata.__liyuanMvuProcessed),receipt=record(receipts?.[source]);
 let recoveryReason:string|undefined;
 if(!asset.installed)recoveryReason="原 MVU 或依赖校验尚未通过，请先检查安装。";
 else if(!asset.enabled)recoveryReason="MVU 当前已关闭，启用后才能核对本回合变量。";
 else if(!helper.installed||!helper.enabled)recoveryReason="请先安装并启用原酒馆助手，MVU 才能运行。";
 else if(streaming)recoveryReason="本拍正在生成或结算，请完成后再恢复变量。";
 else if(pluginBusy)recoveryReason="原插件任务正在进行，请等待完成再恢复变量。";
 else if(!message||message.is_user||message.__liyuanUnfinished||typeof message.__liyuanAuthorDelivery!=="string"||!message.__liyuanAuthorDelivery.trim())recoveryReason="当前没有完整、可追溯的作者交付；半稿或用户输入不能恢复变量。";
 return {...asset,helper,binding:{scopeKey:context.scopeKey,sourceEntryId:source},streaming,pluginBusy,
  canRecover:!recoveryReason,...(recoveryReason?{recoveryReason}:{}),variables:{rootCount,hasData:rootCount>0},
  ...(typeof receipt?.status==="string"?{receipt:{status:receipt.status,...(typeof receipt.at==="string"?{at:receipt.at}:{})}}:{})};
}
