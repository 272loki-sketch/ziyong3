import {existsSync,readFileSync,lstatSync,writeFileSync,mkdirSync} from "node:fs";
import {join} from "node:path";
import {createHash} from "node:crypto";
export const MVU_COMMIT="54be11b09f21b1c4266e2d54b6f1ba9a3598db05";
export const MVU_VERSION="v0.193.0";
export const MVU_URL=`https://cdn.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate@${MVU_COMMIT}/artifact/bundle.js`;
interface Manifest{version:1;commit:string;bundleSha256:string;assets:Record<string,{file:string;sha256:string}>}
const memo=new Map<string,{sha:string;mtime:bigint;ctime:bigint;ino:bigint;dev:bigint;size:bigint;valid:boolean}>();
const root=(cwd:string)=>join(cwd,".liyuan-tavern-plugins","mvu");
function manifest(cwd:string):Manifest|undefined{try{const value=JSON.parse(readFileSync(join(root(cwd),"manifest.json"),"utf8"));return value.version===1&&value.commit===MVU_COMMIT?value:undefined;}catch{return;}}
function validateAsset(cwd:string,path:string,m:Manifest,assets:Map<string,Manifest["assets"][string]>):string|undefined{
 let file:string,sha:string;
 if(path==="bundle.js"){file=join(root(cwd),"bundle.js");sha=m.bundleSha256;}
 else if(/^[a-f0-9]{64}\.js$/.test(path)){const row=assets.get(path);if(!row)return;file=join(root(cwd),"dependencies",path);sha=row.sha256;}
 else return;
 try{
  for(const directory of [join(cwd,".liyuan-tavern-plugins"),root(cwd),...(path==="bundle.js"?[]:[join(root(cwd),"dependencies")])])if(!lstatSync(directory).isDirectory())return;
  const stat=lstatSync(file,{bigint:true});if(!stat.isFile())return;
  const saved=memo.get(file);
  if(saved?.sha===sha&&saved.mtime===stat.mtimeNs&&saved.ctime===stat.ctimeNs&&saved.ino===stat.ino&&saved.dev===stat.dev&&saved.size===stat.size)return saved.valid?file:undefined;
  const valid=createHash("sha256").update(readFileSync(file)).digest("hex")===sha;
  memo.set(file,{sha,mtime:stat.mtimeNs,ctime:stat.ctimeNs,ino:stat.ino,dev:stat.dev,size:stat.size,valid});
  return valid?file:undefined;
 }catch{return;}
}
export function mvuAsset(cwd:string,path:string):string|undefined{const m=manifest(cwd);if(!m)return;return validateAsset(cwd,path,m,new Map(Object.values(m.assets).toReversed().map(row=>[row.file,row])));}
export function mvuAssetMap(cwd:string){const m=manifest(cwd);if(!m)return {};return {"https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js":"/tavern-compat/mvu/bundle.js","https://cdn.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate/artifact/bundle.js":"/tavern-compat/mvu/bundle.js",[MVU_URL]:"/tavern-compat/mvu/bundle.js","https://testingcf.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate@beta/artifact/bundle.js":"/tavern-compat/mvu/bundle.js","https://cdn.jsdelivr.net/gh/MagicalAstrogy/MagVarUpdate@beta/artifact/bundle.js":"/tavern-compat/mvu/bundle.js",...Object.fromEntries(Object.entries(m.assets).map(([url,row])=>[url,"/tavern-compat/mvu/"+row.file]))};}
export function mvuStatus(cwd:string){let enabled=false;try{enabled=JSON.parse(readFileSync(join(root(cwd),"config.json"),"utf8")).enabled===true;}catch{}const m=manifest(cwd),assets=new Map(m?Object.values(m.assets).toReversed().map(row=>[row.file,row] as const):[]),installed=!!m&&!!validateAsset(cwd,"bundle.js",m,assets)&&Object.values(m.assets).every(row=>!!validateAsset(cwd,row.file,m,assets));return {enabled,installed,version:MVU_VERSION,commit:MVU_COMMIT,sha256:m?.bundleSha256,dependencies:m?Object.keys(m.assets).length:0};}
export function setMvuEnabled(cwd:string,enabled:boolean){if(enabled&&!mvuStatus(cwd).installed)throw Error("原MVU或校验依赖尚未安装，不能假装启用");const file=join(root(cwd),"config.json");let previous:Record<string,unknown>={};if(existsSync(file)){previous=JSON.parse(readFileSync(file,"utf8"));if(!previous||typeof previous!=="object"||Array.isArray(previous))throw Error("MVU配置格式无效");}mkdirSync(root(cwd),{recursive:true,mode:0o700});writeFileSync(file,JSON.stringify({...previous,version:1,enabled}),{mode:0o600});return mvuStatus(cwd);}
