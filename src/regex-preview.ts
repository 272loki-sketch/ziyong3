import { rulesAtDepth } from "./cardfront.ts";
import { applyCardSkin } from "./cardSkin.ts";
import { prepareDisplayText } from "./postprocess.ts";
import type { RegexInspectorSnapshot } from "./regex-inspector.ts";
export interface RegexPreviewInput { snapshot:RegexInspectorSnapshot; text:string; depth:number; applySkin:boolean; ruleId?:string }
export interface RegexPreviewResult { display:string; steps:Array<{id:string;changed:boolean;beforeChars:number;afterChars:number}> }
/** Same display engine as wire; preview only, not author/output validation. Run in a bounded Worker in Web. */
export function previewOriginalRegex(input:RegexPreviewInput): RegexPreviewResult {
 const candidates=input.snapshot.rules.filter(rule=>rule.displayRule && (!input.ruleId||rule.id===input.ruleId));
 const rows=input.applySkin?candidates.filter(rule=>rulesAtDepth([rule.displayRule!],input.depth).length):[];
 const macros={charName:input.snapshot.charName,userName:input.snapshot.userName};
 let text=input.text;
 const steps:RegexPreviewResult["steps"]=[];
 for (const row of rows) {
  const next=applyCardSkin(text,[row.displayRule!],macros);
  steps.push({id:row.id,changed:next!==text,beforeChars:text.length,afterChars:next.length});
  if (next.length>4_000_000) throw Error("预览展开超过 400 万字，停止加载；原始规则与正文未改变");
  text=next;
 }
 const display=prepareDisplayText(input.text,{...macros,rules:rows.map(row=>row.displayRule!)});
 if (display.length>4_000_000) throw Error("预览结果过大，停止加载；正文未改变");
 return {display,steps};
}
