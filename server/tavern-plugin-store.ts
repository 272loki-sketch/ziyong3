/** Plugin variables/metadata are derived extension data; story text is deliberately absent. */
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { acquireTavernPluginLock } from "./tavern-plugin-lock.ts";
import { writeJsonAtomicWithBackup } from "../src/atomic-json.ts";
export interface TavernPluginState {
 chatMetadata: Record<string, unknown>;
 extensionSettings: Record<string, unknown>;
 characterExtensions: Record<string, unknown>;
 presetExtensions: Record<string, unknown>;
 messages: Record<string, { variables?: unknown; extra?: Record<string, unknown> }>;
 worldbooks: Record<string, { entries: unknown[] }>;
}
export interface TavernPluginBinding { sessionId: string; card?: string; sourceEntryId: string; visibleEntryIds: string[] }
export const emptyTavernPluginState = (): TavernPluginState => ({ chatMetadata: {}, extensionSettings: {}, characterExtensions: {}, presetExtensions: {}, messages: {}, worldbooks: {} });
export function tavernPluginScope(binding: Pick<TavernPluginBinding, "sessionId" | "card">): string { return createHash("sha256").update(JSON.stringify([binding.sessionId, binding.card ?? ""])).digest("hex"); }
function json(value: unknown, depth = 0): void {
 if (depth > 96) throw new Error("插件数据嵌套过深");
 if (value === null || typeof value === "string" || typeof value === "boolean") return;
 if (typeof value === "number" && Number.isFinite(value)) return;
 if (!value || typeof value !== "object" || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error("插件数据必须为普通 JSON");
 for (const [key, v] of Object.entries(value)) { if (["__proto__", "prototype", "constructor"].includes(key)) throw new Error("禁止原型字段"); json(v, depth + 1); }
}
export function validateTavernPluginState(input: unknown, visible: Set<string>, readonlyBooks: Set<string> = new Set()): TavernPluginState {
 json(input); const state = input as TavernPluginState;
 if (!state || Object.keys(state).some(k => !Object.keys(emptyTavernPluginState()).includes(k))) throw new Error("未知插件状态字段");
 for (const key of Object.keys(emptyTavernPluginState())) { const value = (state as unknown as Record<string, unknown>)[key]; if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`缺少插件状态 ${key}`); }
 for (const [id, fields] of Object.entries(state.messages)) {
  if (!visible.has(id)) throw Object.assign(new Error("消息不属于当前祖先分支"), { statusCode: 409 });
  if (Object.keys(fields).some(k => !["variables", "extra"].includes(k))) throw new Error("插件不得修改正文、原交付或思考");
  if (fields.extra && Object.keys(fields.extra).some(k => /^(mes|text|thinking|rpNarrative|rpAuthorDraft|rpTimeline)$/i.test(k))) throw new Error("插件扩展不能冒充故事正文");
 }
 for (const [name, book] of Object.entries(state.worldbooks)) { if (readonlyBooks.has(name)) throw new Error("原角色卡／挂载世界书只读"); if (!Array.isArray(book.entries)) throw new Error("插件世界书缺少 entries"); }
 if (Buffer.byteLength(JSON.stringify(state)) > 32 * 1024 * 1024) throw new Error("插件状态超过32MiB限制");
 return state;
}
interface Snapshot { revision: number; sourceEntryId: string; snapshot: string }
interface StateNode { type:"tavern-state"; base:string|null; refs:Record<string,string|Record<string,string|null>> }
const digest=(bytes:Buffer)=>createHash("sha256").update(bytes).digest("hex");
const HASH=/^[a-f0-9]{64}$/;const MAX_INDEX=4*1024*1024;const MAX_SCOPE=512*1024*1024;
export class TavernPluginStore {
 readonly root:string;
 constructor(cwd:string){const parent=join(cwd,".liyuan-tavern-plugins");this.directory(parent);this.root=join(parent,"state");this.directory(this.root);}
 private directory(path:string){if(!existsSync(path)){try{mkdirSync(path,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}}const stat=lstatSync(path);if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error("插件私有路径必须为真实目录");chmodSync(path,0o700);}
 private file(path:string,max=32*1024*1024):Buffer{const stat=lstatSync(path);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>max)throw new Error("插件数据文件类型或大小无效");return readFileSync(path);}
 private scope(binding:TavernPluginBinding){this.directory(join(this.root,".."));this.directory(this.root);const root=join(this.root,tavernPluginScope(binding));this.directory(root);const objects=join(root,"objects");this.directory(objects);return {root,objects,index:join(root,"index.json")};}
 private snapshots(index:string):Snapshot[]{if(!existsSync(index))return [];const data=JSON.parse(this.file(index,MAX_INDEX).toString("utf8"));if(data.version!==3||!Array.isArray(data.snapshots))throw new Error("插件状态索引版本无效");return data.snapshots;}
 private object(objects:string,hash:string):unknown{if(!HASH.test(hash))throw new Error("插件对象指纹无效");const bytes=this.file(join(objects,hash+".json"));if(digest(bytes)!==hash)throw new Error("插件对象完整性校验失败");return JSON.parse(bytes.toString("utf8"));}
 private select(binding:TavernPluginBinding,snapshots:Snapshot[],excludeSource=false){const order=new Map([...binding.visibleEntryIds,binding.sourceEntryId].map((id,i)=>[id,i]));return [...snapshots].filter(s=>order.has(s.sourceEntryId)&&(!excludeSource||s.sourceEntryId!==binding.sourceEntryId)).sort((a,b)=>order.get(b.sourceEntryId)!-order.get(a.sourceEntryId)!)[0];}
 private refs(objects:string,hash:string|null){const result:StateNode["refs"]={messages:{},worldbooks:{}},nodes:StateNode[]=[],visited=new Set<string>();while(hash){if(visited.has(hash)||visited.size>10000)throw new Error("插件状态来源链无效或过深");visited.add(hash);const node=this.object(objects,hash) as StateNode;if(node.type!=="tavern-state"||!node.refs)throw new Error("插件状态来源对象无效");nodes.push(node);hash=node.base;}
  for(const node of nodes.reverse())for(const [key,value] of Object.entries(node.refs)){if(key==="messages"||key==="worldbooks"){const fields=result[key] as Record<string,string|null>;for(const [name,ref] of Object.entries(value as Record<string,string|null>)){if(ref===null)delete fields[name];else fields[name]=ref;}}else result[key]=value;}return result;
 }
 read(binding:TavernPluginBinding):{revision:number;state:TavernPluginState}{const {objects,index}=this.scope(binding),snapshots=this.snapshots(index),selected=this.select(binding,snapshots),state=emptyTavernPluginState();if(!selected)return {revision:snapshots.at(-1)?.revision??0,state};const refs=this.refs(objects,selected.snapshot),visible=new Set([...binding.visibleEntryIds,binding.sourceEntryId]);
  for(const key of ["chatMetadata","extensionSettings","characterExtensions","presetExtensions"] as const)if(typeof refs[key]==="string")state[key]=this.object(objects,refs[key] as string) as Record<string,unknown>;
  for(const [id,hash] of Object.entries(refs.messages as Record<string,string>))if(visible.has(id))state.messages[id]=this.object(objects,hash) as TavernPluginState["messages"][string];
  for(const [name,hash] of Object.entries(refs.worldbooks as Record<string,string>))state.worldbooks[name]=this.object(objects,hash) as TavernPluginState["worldbooks"][string];return {revision:snapshots.at(-1)?.revision??0,state};
 }
 /** Persisted per-session/card/source allowance; independent of branch state revisions. */
 claimModelRequest(binding:TavernPluginBinding,limit:number,guard:()=>void):{calls:number}{
  if(!Number.isSafeInteger(limit)||limit<1)throw new Error("插件调用预算无效");
  const {root}=this.scope(binding),path=join(root,"model-request-budget.json"),lock=acquireTavernPluginLock(root);
  try{
   guard();lock.assertOwned();
   let claims:Record<string,number>=Object.create(null);
   if(existsSync(path)){const data=JSON.parse(this.file(path,MAX_INDEX).toString("utf8"));
    if(data.version!==1||!data.claims||Array.isArray(data.claims)||typeof data.claims!=="object")throw new Error("插件调用预算账本无效，未调用模型");
    for(const [key,value] of Object.entries(data.claims)){if(!HASH.test(key)||!Number.isSafeInteger(value)||(value as number)<1||(value as number)>limit)throw new Error("插件调用预算账本无效，未调用模型");claims[key]=value as number;}
   }
   const key=digest(Buffer.from(binding.sourceEntryId)),calls=claims[key]??0;
   if(calls>=limit)throw new Error(`原脚本本来源的合成/辅助模型请求已达${limit}次预算，未继续收费调用`);
   claims[key]=calls+1;const next={version:1,claims};
   if(Buffer.byteLength(JSON.stringify(next))>MAX_INDEX)throw Object.assign(new Error("插件调用预算账本达到存储限制，未丢弃历史额度"),{code:"EDQUOT"});
   if(existsSync(path+".bak"))this.file(path+".bak",MAX_INDEX);
   guard();lock.assertOwned();writeJsonAtomicWithBackup(path,next,{spacing:0});return {calls:calls+1};
  }finally{lock.release();}
 }
 save(binding:TavernPluginBinding,expected:number,state:TavernPluginState,guard:()=>void):{revision:number}{validateTavernPluginState(state,new Set([...binding.visibleEntryIds,binding.sourceEntryId]));const {root,objects,index}=this.scope(binding),lock=acquireTavernPluginLock(root);
  try{const snapshots=this.snapshots(index),revision=snapshots.at(-1)?.revision??0;guard();lock.assertOwned();if(!Number.isSafeInteger(expected)||expected!==revision)throw Object.assign(new Error("插件状态已更新，请刷新后重试"),{statusCode:409});
   let used=readdirSync(objects).reduce((n,name)=>n+lstatSync(join(objects,name)).size,0);const put=(value:unknown)=>{const bytes=Buffer.from(JSON.stringify(value)+"\n"),hash=digest(bytes),path=join(objects,hash+".json");if(existsSync(path)){this.object(objects,hash);return hash;}if((used+=bytes.length)>MAX_SCOPE)throw Object.assign(new Error("插件派生状态达到512MiB作用域预算，请维护后重试"),{code:"EDQUOT"});writeJsonAtomicWithBackup(path,value,{spacing:0});return hash;};
   const previous=JSON.parse(JSON.stringify(snapshots)) as Snapshot[],same=snapshots.find(s=>s.sourceEntryId===binding.sourceEntryId);const base=same?(this.object(objects,same.snapshot) as StateNode).base:this.select(binding,snapshots,true)?.snapshot??null;const baseline=this.refs(objects,base),refs:StateNode["refs"]={messages:{},worldbooks:{}};
   for(const key of ["chatMetadata","extensionSettings","characterExtensions","presetExtensions"] as const){const hash=put(state[key]);if(hash!==baseline[key])refs[key]=hash;}
   for(const key of ["messages","worldbooks"] as const){const old=baseline[key] as Record<string,string|null>,next=refs[key] as Record<string,string|null>;for(const [name,value] of Object.entries(state[key])){const hash=put(value);if(hash!==old[name])next[name]=hash;}for(const name of Object.keys(old))if(!Object.hasOwn(state[key],name))next[name]=null;}
   const snapshot=put({type:"tavern-state",base,refs} satisfies StateNode);const oldIndex=snapshots.findIndex(s=>s.sourceEntryId===binding.sourceEntryId);if(oldIndex>=0)snapshots.splice(oldIndex,1);snapshots.push({revision:revision+1,sourceEntryId:binding.sourceEntryId,snapshot});const next={version:3,snapshots};if(Buffer.byteLength(JSON.stringify(next))>MAX_INDEX)throw Object.assign(new Error("插件分支索引达到存储预算，未截断历史"),{code:"EDQUOT"});if(existsSync(index+".bak"))this.file(index+".bak",MAX_INDEX);guard();lock.assertOwned();writeJsonAtomicWithBackup(index,next,{spacing:0});
   // Immutable base hashes preserve old child branches when an ancestor is edited later.
   const retained=new Set<string>(),pending=[...snapshots,...previous].map(s=>s.snapshot);while(pending.length){const hash=pending.pop()!;if(retained.has(hash))continue;retained.add(hash);const node=this.object(objects,hash) as StateNode;if(node.type==="tavern-state"){if(node.base)pending.push(node.base);for(const value of Object.values(node.refs))if(typeof value==="string")retained.add(value);else for(const ref of Object.values(value))if(ref)retained.add(ref);}}
   for(const name of readdirSync(objects))if(/^[a-f0-9]{64}\.json$/.test(name)&&!retained.has(name.slice(0,-5)))unlinkSync(join(objects,name));return {revision:revision+1};
  }finally{lock.release();}
 }
}
