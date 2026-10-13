import assert from"node:assert/strict";import test from"node:test";import{mkdtempSync,mkdirSync,writeFileSync,rmSync}from"node:fs";import{join}from"node:path";import{tmpdir}from"node:os";import{createHash}from"node:crypto";import{mvuAsset,mvuAssetMap,mvuStatus,setMvuEnabled,MVU_COMMIT,MVU_URL}from"../server/mvu-assets.ts";
import fs,{statSync,utimesSync,renameSync,symlinkSync,readFileSync} from "node:fs";
import {syncBuiltinESMExports} from "node:module";

function fixture(dependencies=1){
 const cwd=mkdtempSync(join(tmpdir(),"liyuan-mvu-assets-")),folder=join(cwd,".liyuan-tavern-plugins/mvu"),bytes="synthetic fixture",sha=createHash("sha256").update(bytes).digest("hex");
 mkdirSync(join(folder,"dependencies"),{recursive:true});writeFileSync(join(folder,"bundle.js"),bytes);
 const assets=Object.fromEntries(Array.from({length:dependencies},(_,i)=>{const file=i.toString(16).padStart(64,"0")+".js";writeFileSync(join(folder,"dependencies",file),bytes);return [`https://example.invalid/${i}`,{file,sha256:sha}];}));
 const manifest={version:1,commit:MVU_COMMIT,bundleSha256:sha,assets};
 writeFileSync(join(folder,"manifest.json"),JSON.stringify(manifest));
 return {cwd,folder,bytes,manifest};
}

test("status reads one manifest for 75 dependencies and memoizes every asset",t=>{
 const {cwd,folder,manifest}=fixture(75),original=fs.readFileSync;let manifests=0,assets=0;
 const mocked=t.mock.method(fs,"readFileSync",(...args:Parameters<typeof fs.readFileSync>)=>{const path=String(args[0]);if(path===join(folder,"manifest.json"))manifests++;if(path.endsWith(".js"))assets++;return Reflect.apply(original,fs,args);});syncBuiltinESMExports();
 try{
  assert.equal(mvuStatus(cwd).installed,true);assert.equal(manifests,1);assert.equal(assets,76);
  assert.equal(mvuStatus(cwd).installed,true);assert.equal(manifests,2);assert.equal(assets,76);
  const config={version:1,enabled:true,untouched:{value:42}};writeFileSync(join(folder,"config.json"),JSON.stringify(config));const before=readFileSync(join(folder,"config.json"),"utf8");
  const last=Object.values(manifest.assets).at(-1)!;writeFileSync(join(folder,"dependencies",last.file),"tampered fixture");
  const status=mvuStatus(cwd);assert.equal(status.installed,false);assert.equal(status.enabled,true);assert.equal(status.dependencies,75);assert.equal(readFileSync(join(folder,"config.json"),"utf8"),before);
 }finally{mocked.mock.restore();syncBuiltinESMExports();rmSync(cwd,{recursive:true,force:true});}
});

test("memo invalidates both valid and invalid results when expected hashes change",()=>{
 const {cwd,folder,manifest}=fixture();
 try{
  const file=Object.values(manifest.assets)[0].file;
  for(const target of ["bundle.js",file]){
   assert.ok(mvuAsset(cwd,target));const good=manifest.bundleSha256;
   if(target==="bundle.js")manifest.bundleSha256="0".repeat(64);else Object.values(manifest.assets)[0].sha256="0".repeat(64);
   writeFileSync(join(folder,"manifest.json"),JSON.stringify(manifest));assert.equal(mvuAsset(cwd,target),undefined);assert.equal(mvuStatus(cwd).installed,false);
   if(target==="bundle.js")manifest.bundleSha256=good;else Object.values(manifest.assets)[0].sha256=good;
   writeFileSync(join(folder,"manifest.json"),JSON.stringify(manifest));assert.ok(mvuAsset(cwd,target));assert.equal(mvuStatus(cwd).installed,true);
  }
 }finally{rmSync(cwd,{recursive:true,force:true});}
});

test("same-size tampering and replacements with restored mtime invalidate memo",async()=>{
 const {cwd,folder,bytes}=fixture();
 try{
  const file=join(folder,"bundle.js"),stamp=new Date("2020-01-01T00:00:00Z");utimesSync(file,stamp,stamp);assert.equal(mvuStatus(cwd).installed,true);const before=statSync(file);
  await new Promise(resolve=>setTimeout(resolve,20));writeFileSync(file,"x".repeat(bytes.length));utimesSync(file,before.atime,before.mtime);assert.equal(mvuStatus(cwd).installed,false);
  await new Promise(resolve=>setTimeout(resolve,20));writeFileSync(file,bytes);utimesSync(file,stamp,stamp);assert.equal(mvuStatus(cwd).installed,true);
  const replacement=join(folder,"replacement.js");writeFileSync(replacement,"y".repeat(bytes.length));utimesSync(replacement,stamp,stamp);renameSync(replacement,file);assert.equal(mvuStatus(cwd).installed,false);
 }finally{rmSync(cwd,{recursive:true,force:true});}
});

test("cached assets still reject symlink files and dependency directories",()=>{
 const {cwd,folder,manifest}=fixture();
 try{
  assert.equal(mvuStatus(cwd).installed,true);const bundle=join(folder,"bundle.js"),saved=join(folder,"saved.js");renameSync(bundle,saved);symlinkSync(saved,bundle);assert.equal(mvuAsset(cwd,"bundle.js"),undefined);assert.equal(mvuStatus(cwd).installed,false);
  rmSync(bundle);renameSync(saved,bundle);assert.equal(mvuStatus(cwd).installed,true);
  const dependencies=join(folder,"dependencies"),moved=join(folder,"saved-dependencies");renameSync(dependencies,moved);symlinkSync(moved,dependencies);assert.equal(mvuAsset(cwd,Object.values(manifest.assets)[0].file),undefined);assert.equal(mvuStatus(cwd).installed,false);
 }finally{rmSync(cwd,{recursive:true,force:true});}
});
test("原MVU资产与依赖必须校验，未安装不伪启用，不接受任意路径或未知依赖",()=>{const cwd=mkdtempSync(join(tmpdir(),"liyuan-mvu-assets-"));try{assert.equal(mvuStatus(cwd).installed,false);assert.throws(()=>setMvuEnabled(cwd,true),/尚未安装/);const folder=join(cwd,".liyuan-tavern-plugins/mvu");mkdirSync(join(folder,"dependencies"),{recursive:true});const bytes="synthetic original fixture",sha=createHash("sha256").update(bytes).digest("hex"),file="a".repeat(64)+".js",url="https://testingcf.jsdelivr.net/npm/synthetic@1.0.0/+esm";writeFileSync(join(folder,"bundle.js"),bytes);writeFileSync(join(folder,"dependencies",file),bytes);writeFileSync(join(folder,"manifest.json"),JSON.stringify({version:1,commit:MVU_COMMIT,bundleSha256:sha,assets:{[url]:{file,sha256:sha}}}));assert.equal(mvuStatus(cwd).installed,true);assert.equal(setMvuEnabled(cwd,true).enabled,true);assert.equal(mvuAssetMap(cwd)[MVU_URL],"/tavern-compat/mvu/bundle.js");assert.equal(mvuAsset(cwd,"../../secret"),undefined);assert.equal(mvuAsset(cwd,"b".repeat(64)+".js"),undefined);writeFileSync(join(folder,"bundle.js"),"tampered");assert.equal(mvuStatus(cwd).installed,false);}finally{rmSync(cwd,{recursive:true,force:true});}});
