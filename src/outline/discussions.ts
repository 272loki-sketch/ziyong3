import type { BranchEntryLike } from "../stage/assemble.ts";
export const DEFAULT_DISCUSSION_ID = "default";
export const DISCUSSION_ENTRY_TYPE = "rp-outline-discussion";
export const DISCUSSION_SELECT_TYPE = "rp-outline-discussion-select";
export interface OutlineDiscussion { id:string; title:string; createdAt:string; updatedAt:string; rounds:number }
export function discussionId(value:unknown):string {return typeof value==="string"&&value?value:DEFAULT_DISCUSSION_ID;}
export function discussionCatalog(branch:BranchEntryLike[]):Omit<OutlineDiscussion,"rounds">[] {
 const rows=new Map<string,Omit<OutlineDiscussion,"rounds">>([[DEFAULT_DISCUSSION_ID,{id:DEFAULT_DISCUSSION_ID,title:"原有对谈",createdAt:"",updatedAt:""}]]);
 for(const entry of branch){if(entry.customType!==DISCUSSION_ENTRY_TYPE||!entry.data||typeof entry.data!=="object")continue;const row=entry.data as Record<string,unknown>;if(row.version!==1||typeof row.id!=="string"||!row.id||typeof row.title!=="string"||!row.title.trim())continue;const previous=rows.get(row.id);rows.set(row.id,{id:row.id,title:row.title.trim().slice(0,80),createdAt:previous?.createdAt||String(row.createdAt||""),updatedAt:String(row.updatedAt||row.createdAt||"")});}
 return [...rows.values()];
}
export function selectedDiscussion(branch:BranchEntryLike[]):string {
 const catalog=new Set(discussionCatalog(branch).map(row=>row.id));
 for(const entry of [...branch].reverse()){if(entry.customType!==DISCUSSION_SELECT_TYPE||!entry.data||typeof entry.data!=="object")continue;const id=(entry.data as {id?:unknown}).id;if(typeof id==="string"&&catalog.has(id))return id;}
 return DEFAULT_DISCUSSION_ID;
}
