/** Per-plugin Git routing; never rewrites the shared Tavern network settings or uses model credentials. */
import {lstatSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
export type ManagedGitPlugin = 'npc-parallel' | 'veridis-rewrite';

function optionalStat(path:string){try{return lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return undefined;throw Error('插件网络配置无法安全读取');}}
function readProxy(cwd:string,directory:string):string|undefined {
 const parent=join(cwd,directory),path=join(parent,'network.json');
 const parentStat=optionalStat(parent);if(!parentStat)return undefined;
 if(!parentStat.isDirectory()||parentStat.isSymbolicLink())throw Error('插件网络配置目录不是安全的普通目录');
 const stat=optionalStat(path);if(!stat)return undefined;
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw Error('插件网络配置类型无效');
 let data:unknown;try{data=JSON.parse(readFileSync(path,'utf8'));}catch{throw Error('插件网络配置不是有效 JSON');}
 if(!data||typeof data!=='object'||Array.isArray(data))throw Error('插件网络配置必须是 JSON 对象');
 const proxy=(data as Record<string,unknown>).gitProxy;
 if(proxy===undefined)return undefined;
 if(typeof proxy!=='string'||proxy.length>2048)throw Error('插件 Git 代理字段类型无效');
 return proxy;
}
function validateProxy(proxy:string):void {
 if(proxy==='')return; // Explicit direct connection. Do not fall back to a broken shared proxy.
 let url:URL;try{url=new URL(proxy);}catch{throw Error('插件 Git 代理地址无效');}
 if(!/^https?:$/.test(url.protocol)||url.username||url.password)throw Error('插件 Git 代理必须是无凭据的 HTTP(S) 地址');
}
export function pluginGitNetworkOptions(cwd:string,plugin:ManagedGitPlugin,env:NodeJS.ProcessEnv=process.env):{proxy?:string} {
 if(!['npc-parallel','veridis-rewrite'].includes(plugin))throw Error('未知的受管插件网络配置');
 const ownVariable=plugin==='npc-parallel'?'LIYUAN_NPC_PARALLEL_GIT_PROXY':'LIYUAN_VERIDIS_REWRITE_GIT_PROXY';
 const legacyVariable=plugin==='veridis-rewrite'?env.LIYUAN_VERIDIS_GIT_PROXY:undefined;
 const proxy=env[ownVariable]??legacyVariable??readProxy(cwd,`.liyuan-${plugin}`)??env.LIYUAN_TAVERN_GIT_PROXY??readProxy(cwd,'.liyuan-tavern-plugins');
 if(proxy===undefined)return {};
 validateProxy(proxy);
 return {proxy};
}
