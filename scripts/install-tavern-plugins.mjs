/** Original-byte installer. Default only stages; offline activation must be explicitly requested. */
import {resolve,join} from 'node:path';
import {readFileSync} from 'node:fs';
import {TavernPluginSources} from '../server/tavern-plugin-source.ts';
import {ensureTavernPluginVendors} from '../server/tavern-plugin-vendor.ts';
import {validateTavernPluginCandidate} from '../server/tavern-plugin-runtime.ts';
import {writeJsonAtomicWithBackup} from '../src/atomic-json.ts';
const args=process.argv.slice(2),value=name=>{const i=args.indexOf(name);return i>=0?args[i+1]:undefined;};
const cwd=resolve(value('--cwd')??process.cwd()),fixtures=value('--fixtures'),proxy=value('--proxy')??process.env.LIYUAN_TAVERN_GIT_PROXY;
await ensureTavernPluginVendors(cwd,{fixtureRoot:fixtures,proxy});
if(proxy)writeJsonAtomicWithBackup(join(cwd,'.liyuan-tavern-plugins/network.json'),{gitProxy:proxy});
const activation=args.includes('--activate-offline');
const sources=new TavernPluginSources(cwd,{proxy,activation:{isIdle:()=>activation,validateCandidate:c=>validateTavernPluginCandidate(cwd,c)}});
try{
 for(const id of ['template','helper']){
  const options=fixtures?{fixtureRepo:join(fixtures,id)}:{};
  if(activation){await sources.install(id,options);if(args.includes('--enable'))sources.configure(id,{enabled:true,autoUpdate:true});}
  else await sources.checkUpdate(id,options);
 }
 console.log(JSON.stringify({activatedOffline:activation,status:sources.status(),note:activation?'离线激活完成；仍需应用启动/浏览器验收':'已暂存原字节；请在梨园设置→酒馆角色卡插件点击安装/更新，由运行宿主核对空闲与兼容性'},null,2));
}finally{sources.close();}
