/** Host-owned transport adapter; never rewrites author cards or upstream plugin bytes. */
export const WORKSPACE_BOOTSTRAP = String.raw`(() => {
 if (window.__liyuanWorkspaceScope) return;
 const workspace=document.querySelector('meta[name="liyuan-workspace"]')?.content;
 const lease=document.querySelector('meta[name="liyuan-workspace-lease"]')?.content;
 if (!workspace || !lease || !/^(?:primary|[0-9a-f-]{36})$/.test(workspace) || !/^[a-f0-9]{32}$/.test(lease)) return;
 const scope={workspace,lease,stale:false}; window.__liyuanWorkspaceScope=scope;
 // about:srcdoc inherits a usable document base, but location.href/origin are
 // opaque about: values. Capture the host script's origin, not that location.
 const hostUrl=new URL(document.currentScript?.src||document.baseURI);
 const hostOrigin=hostUrl.origin;
 // Same-origin image/module navigations cannot add headers. Pin their referrer
 // too; an old page retains its old lease and can never follow a new owner.
 if(window===window.top && ['/', '/index.html'].includes(location.pathname)){
  const current=new URL(location.href);current.searchParams.set('liyuanWorkspace',workspace);current.searchParams.set('liyuanLease',lease);history.replaceState(history.state,'',current.href);
 }
 const parentPath=p=>p==='/api/play-slots'||p.startsWith('/api/play-slots/')||p.startsWith('/api/access/')||p.startsWith('/api/update/');
 const stale=()=>{if(scope.stale)return;scope.stale=true;window.dispatchEvent(new Event('liyuan:workspace-changed'));};
 const url=input=>new URL(typeof input==='string'?input:typeof input?.url==='string'?input.url:String(input),document.baseURI);
 const nativeFetch=window.fetch.bind(window);
 window.fetch=(input,options)=>{
  const target=url(input);
  if(target.origin!==hostOrigin)return nativeFetch(input,options);
  if(scope.stale&&!parentPath(target.pathname))return Promise.reject(Error('主窗口已切换，请刷新；当前草稿保留'));
  const headers=new Headers(options?.headers??(input&&typeof input==='object'&&'headers' in input?input.headers:undefined));
  headers.set('x-liyuan-workspace',workspace);headers.set('x-liyuan-workspace-lease',lease);
  return nativeFetch(input,{...options,headers}).then(response=>{
   if(response.status===409)void response.clone().json().then(body=>{if(body.code==='workspace_changed')stale();}).catch(()=>{});
   return response;
  });
 };
 const open=XMLHttpRequest.prototype.open,send=XMLHttpRequest.prototype.send;
 const targets=new WeakMap();
 XMLHttpRequest.prototype.open=function(method,address,...rest){targets.set(this,url(String(address)));return open.call(this,method,address,...rest);};
 XMLHttpRequest.prototype.send=function(body){
  const target=targets.get(this);
  if(target?.origin===hostOrigin){
   if(scope.stale&&!parentPath(target.pathname))throw Error('主窗口已切换，请刷新');
   this.setRequestHeader('x-liyuan-workspace',workspace);this.setRequestHeader('x-liyuan-workspace-lease',lease);
   this.addEventListener('load',()=>{if(this.status===409){try{const data=this.responseType==='json'?this.response:JSON.parse(this.responseText);if(data?.code==='workspace_changed')stale();}catch{}}});
  }return send.call(this,body);
 };
 const NativeWS=window.WebSocket;
 window.WebSocket=new Proxy(NativeWS,{construct(Target,args){
  const target=new URL(args[0],document.baseURI);
  if(target.host===hostUrl.host&&target.pathname==='/ws'){
   target.searchParams.set('liyuanWorkspace',workspace);target.searchParams.set('liyuanLease',lease);args[0]=target.href;
  }
  const socket=Reflect.construct(Target,args);
  if(target.pathname==='/ws'){
   socket.addEventListener('message',event=>{try{if(JSON.parse(event.data).type==='workspace_changed')stale();}catch{}});
   socket.addEventListener('close',event=>{if(event.code===4410)stale();});
  }return socket;
 }});
})();`;
