/** Main-window ownership is a routing lease, not a story export/import. */
import { request, type IncomingMessage, type ServerResponse } from 'node:http';
import { requestPathname } from './http-security.ts';
import { ACCESS_COOKIE } from '../src/access.ts';
export const WORKSPACE_HEADER = 'x-liyuan-workspace';
export const WORKSPACE_LEASE_HEADER = 'x-liyuan-workspace-lease';
export const PRIMARY_WORKSPACE = 'primary';
export interface WorkspaceContext { workspace: string; lease: string }
const HOP = new Set(['connection','keep-alive','proxy-authenticate','proxy-authorization','te','trailer','transfer-encoding','upgrade']);
export const WORKSPACE_HOSTS = new Set(['/database-plugin-host.html','/tavern-plugin-host.html','/veridis-rewrite-host.html']);
export function mainWorkspaceHtml(html: string, context: WorkspaceContext): string {
 if (!/^(?:primary|[0-9a-f-]{36})$/.test(context.workspace) || !/^[a-f0-9]{32}$/.test(context.lease)) throw Error('主窗口作用域无效');
 const head = `<meta name="liyuan-workspace" content="${context.workspace}"><meta name="liyuan-workspace-lease" content="${context.lease}"><script src="/workspace-scope.js"></script>`;
 return /<head(?:\s[^>]*)?>/i.test(html) ? html.replace(/<head(?:\s[^>]*)?>/i, match => match + head) : head + html;
}
export function requestContext(req: Pick<IncomingMessage,'headers'|'url'>): Partial<WorkspaceContext> {
 const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
 const workspace = req.headers[WORKSPACE_HEADER] ?? query.get('liyuanWorkspace') ?? undefined;
 const lease = req.headers[WORKSPACE_LEASE_HEADER] ?? query.get('liyuanLease') ?? undefined;
 // Ambiguous duplicated query/header values never authorize a request.
 if (query.getAll('liyuanWorkspace').length > 1 || query.getAll('liyuanLease').length > 1 ||
     query.has('liyuanWorkspace') && req.headers[WORKSPACE_HEADER] !== undefined && query.get('liyuanWorkspace') !== workspace ||
     query.has('liyuanLease') && req.headers[WORKSPACE_LEASE_HEADER] !== undefined && query.get('liyuanLease') !== lease) return { workspace: 'invalid', lease: 'invalid' };
 return {workspace: typeof workspace === 'string' ? workspace : undefined, lease: typeof lease === 'string' ? lease : undefined};
}
/** Only immutable, host-owned code/assets and parent administration bypass routing. */
export function parentRequest(path: string): boolean {
 return path === '/api/play-slots' || path.startsWith('/api/play-slots/') || path.startsWith('/api/access/') || path.startsWith('/api/update/') ||
  path === '/healthz' || path === '/' || path === '/index.html' || path.startsWith('/assets/') ||
  ['/sw.js','/tavern-plugin-sw.js','/workspace-scope.js','/site.webmanifest','/favicon.png'].includes(path) || /^\/logo(?:[-.]|$)/.test(path);
}
/** Resource GETs cannot add headers. Fetch wrappers pin API calls; nested script
 * and image URLs may inherit the exact lease from a same-origin pinned referrer. */
export function resourceContext(req: IncomingMessage): Partial<WorkspaceContext> {
 const own = requestContext(req); if (own.workspace !== undefined || own.lease !== undefined) return own;
 if (!['GET','HEAD'].includes(req.method ?? 'GET')) return own;
 const path = requestPathname(req.url??'/');
 if (path.startsWith('/api/') && !['/api/cards/image','/api/personas/avatar','/api/database-plugin/source/index.js'].includes(path) && !path.startsWith('/api/database-plugin/vendor/')) return own;
 try {
  const ref = new URL(req.headers.referer ?? '');
  if (ref.host !== req.headers.host || !['http:','https:'].includes(ref.protocol)) return own;
  return requestContext({headers:{},url:ref.pathname + ref.search});
 } catch { return own; }
}
export function childRequestHeaders(req: IncomingMessage, token: string) {
 const connection = new Set(String(req.headers.connection ?? '').toLowerCase().split(',').map(s => s.trim()));
 const headers = Object.fromEntries(Object.entries(req.headers).filter(([key]) => !HOP.has(key) && !connection.has(key) && !['cookie','authorization',WORKSPACE_HEADER,WORKSPACE_LEASE_HEADER].includes(key)));
 headers.cookie = `${ACCESS_COOKIE}=${token}`;
 return headers;
}
/** Capture target once, stream SSE/uploads/binary unchanged; never expose child credentials. */
export function proxyWorkspaceHttp(req: IncomingMessage, res: ServerResponse, target: {port:number;token:string}, stillCurrent:()=>boolean, context: WorkspaceContext): Promise<void> {
 return new Promise(resolve => {
  let ended = false;
  const finish = () => { if(ended)return;ended=true;req.off('aborted',abort);res.off('close',abort);resolve(); };
  const fail = () => { if(ended)return;if(!res.headersSent){res.writeHead(502,{'content-type':'application/json','cache-control':'private, no-store'});res.end(JSON.stringify({error:'主窗口卡位连接已中断，存档保留，请刷新后恢复'}));}else res.destroy();finish(); };
  const upstream = request({hostname:'127.0.0.1',port:target.port,path:req.url,method:req.method,headers:childRequestHeaders(req,target.token)}, reply => {
   if(!stillCurrent()){reply.destroy();fail();return;}
   const connection = new Set(String(reply.headers.connection ?? '').toLowerCase().split(',').map(s=>s.trim()));
   const headers = Object.fromEntries(Object.entries(reply.headers).filter(([key])=>!HOP.has(key)&&!connection.has(key)&&key!=='set-cookie'));
   const hostHtml = WORKSPACE_HOSTS.has(requestPathname(req.url??'/')) && String(reply.headers['content-type']).startsWith('text/html');
   if(hostHtml){
    const chunks:Buffer[]=[];let size=0;
    reply.on('data', chunk=>{size+=chunk.length;if(size>2*1024*1024){reply.destroy();fail();}else chunks.push(chunk);});
    reply.once('end',()=>{if(ended)return;delete headers['content-length'];res.writeHead(reply.statusCode??502,{...headers,'cache-control':'private, no-store'});res.end(mainWorkspaceHtml(Buffer.concat(chunks).toString('utf8'),context));});
   } else {res.writeHead(reply.statusCode??502,{...headers,'cache-control':'private, no-store'});reply.pipe(res);}
   reply.once('error',fail);reply.once('aborted',fail);res.once('finish',finish);
  });
  const abort = () => {upstream.destroy();finish();};
  upstream.once('error',fail);req.once('aborted',abort);res.once('close',abort);req.pipe(upstream);
 });
}
