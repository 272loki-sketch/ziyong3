/** Read-only projection of the original bound regex scripts. No source file is rewritten. */
import { displayRules, promptRules, type DisplayRule } from "./cardfront.ts";

export type RegexRuleScope = "global" | "preset" | "local" | "lorebook";
export type BoundRegexSourceKind = "global" | "preset" | "lorebook" | "card";
export interface BoundRegexSource { id:string; kind:BoundRegexSourceKind; name:string; path:string; scripts:unknown[]; draft?:boolean; error?:string }
export interface RegexSourceView { id:string; kind:BoundRegexSourceKind; scope:RegexRuleScope; name:string; path:string; draft?:boolean; error?:string; ruleCount:number }
export function regexScopeForSource(kind:BoundRegexSourceKind):RegexRuleScope {
 return kind==="card"?"local":kind;
}
export interface RegexRuleView {
 id:string; sourceId:string; scope:RegexRuleScope; index:number; name:string; find:string; replace:string; disabled:boolean;
 placement:number[]; markdownOnly:boolean; promptOnly:boolean; trim:string[]; minDepth?:number|string|null; maxDepth?:number|string|null;
 displayActive:boolean; promptActive:boolean; notes:string[]; displayRule?:DisplayRule;
}
export interface RegexInspectorSnapshot {
 cardPath:string; charName:string; userName:string; skinEnabled:boolean;
 sources:RegexSourceView[]; rules:RegexRuleView[];
}
export function inspectBoundRegex(sources:BoundRegexSource[]): Pick<RegexInspectorSnapshot,"sources"|"rules"> {
 const rules:RegexRuleView[]=[];
 for (const source of sources) source.scripts.forEach((value,index)=>{
  const row=value && typeof value==="object" && !Array.isArray(value) ? value as Record<string,unknown> : {};
  const placement=Array.isArray(row.placement)?row.placement.filter((n):n is number=>typeof n==="number"):[];
  const disabled=row.disabled===true, find=typeof row.findRegex==="string"?row.findRegex:"";
  const notes:string[]=[];
  if (disabled) notes.push("原规则已关闭");
  if (!placement.includes(2)) notes.push("不用于 AI 回复：当前正文显示/历史送模链不应用");
  const unsupported=typeof row.substituteRegex==="number" && row.substituteRegex!==0;
  if (unsupported) notes.push("substituteRegex 暂不支持，执行时跳过");
  let valid=!!find.trim();
  if (!valid) notes.push("匹配表达式为空");
  else { try { const m=/^\/([\s\S]+)\/([a-z]*)$/.exec(find.trim());new RegExp(m?m[1]:find,m?.[2]||"g"); } catch {valid=false;notes.push("匹配表达式或 flags 无效，执行时跳过");} }
  const applicable=valid && !unsupported && !disabled && placement.includes(2);
  const displayRule=applicable?displayRules([row])[0]:undefined;
  const promptActive=applicable && promptRules([row]).length>0;
  if (row.promptOnly===true && row.markdownOnly!==true) notes.push("仅处理送模历史，不改变屏幕显示");
  const depth=(n:unknown):number|string|null|undefined=>n===null||typeof n==="number"||typeof n==="string"?n:undefined;
  rules.push({id:`${source.id}:${index}`,sourceId:source.id,scope:regexScopeForSource(source.kind),index,name:typeof row.scriptName==="string"&&row.scriptName?row.scriptName:`规则 ${index+1}`,
   find,replace:typeof row.replaceString==="string"?row.replaceString:"",disabled,placement,markdownOnly:row.markdownOnly===true,promptOnly:row.promptOnly===true,
   trim:Array.isArray(row.trimStrings)?row.trimStrings.filter((s):s is string=>typeof s==="string"):[],minDepth:depth(row.minDepth),maxDepth:depth(row.maxDepth),
   displayActive:!!displayRule,promptActive,notes,...(displayRule?{displayRule}:{})});
 });
 return {sources:sources.map(({scripts,...source})=>({...source,scope:regexScopeForSource(source.kind),ruleCount:scripts.length})),rules};
}
