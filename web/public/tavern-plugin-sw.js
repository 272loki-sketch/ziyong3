/* A narrowly scoped host adapter. Original helper-generated iframe code remains unchanged. */
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
let mapping;
self.addEventListener('fetch',event=>{
 const url=new URL(event.request.url);if(url.origin===self.location.origin||url.hostname!=='testingcf.jsdelivr.net')return;
 event.respondWith((async()=>{
  mapping??=fetch('/api/tavern-plugins/asset-map',{cache:'no-store'}).then(r=>{if(!r.ok)throw new Error('未登录插件宿主');return r.json();});
  const assets=await mapping,path=assets[url.href];if(!path)return fetch(event.request);
  const response=await fetch(path,{cache:'no-store'});if(!response.ok)throw new Error('固定原依赖不可用');
  return new Response(await response.arrayBuffer(),{status:200,headers:{'content-type':response.headers.get('content-type')??'text/javascript','access-control-allow-origin':'*'}});
 })());
});
