/** Host-owned, realm-local routing for verified original resource URLs.
 * Original plugin/script bytes are not rewritten. Import maps route ESM and only
 * script/link resource attributes are adapted before a native iframe executes.
 * Unlike a service-worker fetch, each URL retains this window's exact lease.
 */
export function installNativeResources(config) {
 const {origin,assets,workspace,lease}=config;
 if(globalThis.__liyuanNativeResources)return;
 if(new URL(origin).origin!==origin)throw Error('原插件资源宿主无效');
 if(Boolean(workspace)!==Boolean(lease))throw Error('原插件资源作用域不完整');
 const pinned=!!workspace&&!!lease;
 if(pinned&&(!/^(?:primary|[0-9a-f-]{36})$/.test(workspace)||!/^[a-f0-9]{32}$/.test(lease)))throw Error('原插件资源作用域无效');
 const imports={},scopes={};
 for(const [source,path] of Object.entries(assets)){
  const from=new URL(source),to=new URL(path,origin);
  if(!['http:','https:'].includes(from.protocol)||from.username||from.password||to.origin!==origin||!to.pathname.startsWith('/tavern-compat/')||to.username||to.password)throw Error('原插件资源映射越界');
  if(pinned){to.searchParams.set('liyuanWorkspace',workspace);to.searchParams.set('liyuanLease',lease);}
  imports[from.href]=to.href;
  // Native managed scripts can already import a local pinned alias.
  const local=new URL(path,origin).href;imports[local]=to.href;
 }
 // Relocated CDN modules retain both root-relative and package-relative imports.
 // Share unambiguous root aliases by local directory; only collisions/relative
 // edges need per-file scopes, avoiding a quadratic iframe import map.
 const roots={},directories=new Set();
 for(const [source,path]of Object.entries(assets)){
  const from=new URL(source),to=imports[from.href],key=new URL(from.pathname+from.search,origin).href;
  roots[key]=Object.hasOwn(roots,key)&&roots[key]!==to?null:to;
  const url=new URL(to);directories.add(url.origin+url.pathname.slice(0,url.pathname.lastIndexOf('/')+1));
 }
 const common=Object.fromEntries(Object.entries(roots).filter(([,value])=>value!==null));
 for(const directory of directories)scopes[directory]=common;
 for(const [source]of Object.entries(assets)){
  const from=new URL(source),target=imports[from.href],own={},directory=from.pathname.slice(0,from.pathname.lastIndexOf('/')+1);
  for(const [dependency]of Object.entries(assets)){
   const url=new URL(dependency);if(url.origin!==from.origin)continue;
   const key=new URL(url.pathname+url.search,origin).href;
   if(roots[key]===null)own[key]=imports[url.href];
   if(dependency!==source&&url.pathname.startsWith(directory)){
    const relative=new URL(url.pathname.slice(directory.length)+url.search,target).href;
    if(relative!==key)own[relative]=imports[url.href];
   }
  }
  if(Object.keys(own).length)scopes[target]={...common,...own};
 }
 const resolve=value=>{
  try {const url=new URL(String(value),document.baseURI);return imports[url.href]??String(value);}catch{return String(value);}
 };
 const json=value=>JSON.stringify(value).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
 const prepare=source=>{
  const text=String(source);
  if(text.includes('<meta name="liyuan-native-resources" content="1">'))return text;
  const doc=new DOMParser().parseFromString(text,'text/html');
  if(!doc.querySelector('base[href]')){const base=doc.createElement('base');base.href=origin+'/';doc.head.prepend(base);}
  for(const element of doc.querySelectorAll('script[src],link[href]')){
   const attr=element.tagName==='SCRIPT'?'src':'href',value=element.getAttribute(attr);
   if(value!==null)element.setAttribute(attr,resolve(value));
  }
  const map={imports:{},scopes:{}};
  for(const node of doc.querySelectorAll('script[type="importmap"]')){
   let original;try{original=JSON.parse(node.textContent);}catch{continue;}
   for(const [key,value]of Object.entries(original.imports??{}))map.imports[key]=typeof value==='string'?resolve(value):value;
   for(const [scope,entries]of Object.entries(original.scopes??{}))map.scopes[scope]={...(map.scopes[scope]??{}),...Object.fromEntries(Object.entries(entries).map(([key,value])=>[key,typeof value==='string'?resolve(value):value]))};
   // Integrity metadata remains attached to the identical original resource bytes.
   if(original.integrity)map.integrity={...(map.integrity??{}),...Object.fromEntries(Object.entries(original.integrity).map(([key,value])=>[resolve(key),value]))};
   node.remove();
  }
  Object.assign(map.imports,imports);
  for(const [scope,entries]of Object.entries(scopes))map.scopes[scope]={...(map.scopes[scope]??{}),...entries};
  const marker=doc.createElement('meta');marker.name='liyuan-native-resources';marker.content='1';
  const moduleMap=doc.createElement('script');moduleMap.type='importmap';moduleMap.textContent=json(map);
  const bootstrap=doc.createElement('script');bootstrap.textContent='('+installNativeResources.toString()+')('+json(config)+');';
  const nodes=[marker,moduleMap];
  if(pinned){
   const owner=doc.createElement('meta');owner.name='liyuan-workspace';owner.content=workspace;
   const revision=doc.createElement('meta');revision.name='liyuan-workspace-lease';revision.content=lease;
   const transport=doc.createElement('script');transport.src=origin+'/workspace-scope.js';
   nodes.push(owner,revision,transport);
  }
  doc.head.prepend(...nodes,bootstrap);
  const doctype=text.match(/<!doctype[^>]*>/i)?.[0]??'';
  return doctype+doc.documentElement.outerHTML;
 };
 const descriptor=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'srcdoc');
 if(!descriptor?.set)throw Error('浏览器未提供原插件 iframe 显示接口');
 Object.defineProperty(HTMLIFrameElement.prototype,'srcdoc',{...descriptor,set(value){return descriptor.set.call(this,prepare(value));}});
 const setAttribute=Element.prototype.setAttribute;
 Element.prototype.setAttribute=function(name,value){
  const attr=String(name).toLowerCase();
  if(this instanceof HTMLIFrameElement&&attr==='srcdoc')value=prepare(value);
  else if(this instanceof HTMLScriptElement&&attr==='src'||this instanceof HTMLLinkElement&&attr==='href')value=resolve(value);
  return setAttribute.call(this,name,value);
 };
 for(const [type,property]of [[HTMLScriptElement,'src'],[HTMLLinkElement,'href']]){
  const original=Object.getOwnPropertyDescriptor(type.prototype,property);
  if(original?.set)Object.defineProperty(type.prototype,property,{...original,set(value){return original.set.call(this,resolve(value));}});
 }
 const NativeBlob=globalThis.Blob,htmlBlobs=new WeakMap(),blobUrls=new Map(),derivatives=new Map();
 const createObjectURL=URL.createObjectURL.bind(URL),revokeObjectURL=URL.revokeObjectURL.bind(URL);
 globalThis.Blob=new Proxy(NativeBlob,{construct(Target,args,newTarget){
  const blob=Reflect.construct(Target,args,newTarget);
  if(Array.isArray(args[0])&&/^text\/html(?:;|$)/i.test(String(args[1]?.type??''))){
   const parts=args[0];if(parts.every(part=>typeof part==='string'))htmlBlobs.set(blob,parts.join(''));
  }
  return blob;
 }});
 URL.createObjectURL=blob=>{const url=createObjectURL(blob),html=htmlBlobs.get(blob);if(html!==undefined)blobUrls.set(url,html);return url;};
 URL.revokeObjectURL=url=>{for(const adapted of derivatives.get(String(url))??[])revokeObjectURL(adapted);derivatives.delete(String(url));blobUrls.delete(String(url));return revokeObjectURL(url);};
 const frameUrl=value=>{
  const source=String(value),html=blobUrls.get(source);if(html===undefined)return value;
  const adapted=createObjectURL(new NativeBlob([prepare(html)],{type:'text/html'})),urls=derivatives.get(source)??new Set();urls.add(adapted);derivatives.set(source,urls);return adapted;
 };
 const frameSrc=Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'src');
 if(frameSrc?.set)Object.defineProperty(HTMLIFrameElement.prototype,'src',{...frameSrc,set(value){return frameSrc.set.call(this,frameUrl(value));}});
 const resourceAttribute=Element.prototype.setAttribute;
 Element.prototype.setAttribute=function(name,value){return resourceAttribute.call(this,name,this instanceof HTMLIFrameElement&&String(name).toLowerCase()==='src'?frameUrl(value):value);};
 const fetch=globalThis.fetch.bind(globalThis);
 globalThis.fetch=(input,options)=>{
  const method=String(options?.method??(input instanceof Request?input.method:'GET')).toUpperCase();
  if(!['GET','HEAD'].includes(method))return fetch(input,options);
  const source=input instanceof Request?input.url:String(input),target=resolve(source);
  return target===source?fetch(input,options):fetch(input instanceof Request?new Request(target,input):target,options);
 };
 Object.defineProperty(globalThis,'__liyuanNativeResources',{value:{resolve,prepare},configurable:false});
}
