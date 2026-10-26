/** Browser editor state belongs to the same canonical workspace in either view. */
export interface MainWorkspace { workspace: string; lease: string; slot: { id: string; name: string } | null; switching?: boolean }
export function workspaceContext(): {workspace:string;lease:string} | null {
 if(typeof document==='undefined')return null;
 const workspace=document.querySelector<HTMLMetaElement>('meta[name="liyuan-workspace"]')?.content;
 const lease=document.querySelector<HTMLMetaElement>('meta[name="liyuan-workspace-lease"]')?.content;
 return workspace&&lease&&/^(?:primary|[0-9a-f-]{36})$/.test(workspace)&&/^[a-f0-9]{32}$/.test(lease)?{workspace,lease}:null;
}
export function scopedUrl(path:string):string {
 const scope=workspaceContext();if(!scope||typeof location==='undefined')return path;
 const url=new URL(path,location.href);if(url.origin!==location.origin||!["http:","https:"].includes(url.protocol))return path;
 url.searchParams.set('liyuanWorkspace',scope.workspace);url.searchParams.set('liyuanLease',scope.lease);
 return url.pathname+url.search+url.hash;
}
export function workspaceStorageKey(key:string):string {
 const workspace=workspaceContext()?.workspace;
 return workspace&&workspace!=='primary'?`liyuan.play-slot.${workspace}.${key}`:key.startsWith("liyuan.")?key:`liyuan.primary.${key}`;
}
export function storedDraft():string {try{return sessionStorage.getItem(workspaceStorageKey('draft'))??'';}catch{return '';}}
export function saveDraft(value:string):boolean {try{sessionStorage.setItem(workspaceStorageKey('draft'),value);return true;}catch{return false;}}
export function workspaceStale():boolean {return typeof window!=='undefined'&&(window as Window&{__liyuanWorkspaceScope?:{stale:boolean}}).__liyuanWorkspaceScope?.stale===true;}
/** Stop stale tabs before outbox replay. No automatic refresh discards a user's editor. */
export function markWorkspaceStale():void {
 const host=window as Window&{__liyuanWorkspaceScope?:{stale:boolean}};
 if(host.__liyuanWorkspaceScope)host.__liyuanWorkspaceScope.stale=true;
 window.dispatchEvent(new Event('liyuan:workspace-changed'));
}
export function workspaceFrameBootstrap():string {
 const scope=workspaceContext();
 return scope?`<meta name="liyuan-workspace" content="${scope.workspace}"><meta name="liyuan-workspace-lease" content="${scope.lease}"><script src="/workspace-scope.js"></script>`:'';
}

/** Ask the mounted app to persist its full editor state before a deliberate reload. */
export const WORKSPACE_RELOAD_EVENT="liyuan:request-workspace-reload";
export function requestWorkspaceReload():void { window.dispatchEvent(new Event(WORKSPACE_RELOAD_EVENT)); }
