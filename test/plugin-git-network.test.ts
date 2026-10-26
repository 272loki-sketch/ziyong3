import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pluginGitNetworkOptions} from '../server/plugin-git-network.ts';
function fixture(fn:(cwd:string)=>void){const cwd=mkdtempSync(join(tmpdir(),'liyuan-plugin-network-'));try{fn(cwd);}finally{rmSync(cwd,{recursive:true,force:true});}}
function save(cwd:string,dir:string,data:unknown){mkdirSync(join(cwd,dir),{recursive:true,mode:0o700});writeFileSync(join(cwd,dir,'network.json'),JSON.stringify(data),{mode:0o600});}
const shared='http://127.0.0.1:9',local='http://127.0.0.1:10';
for(const plugin of ['veridis-rewrite']as const){
 test(`${plugin}: uses existing shared routing when no dedicated override exists`,()=>fixture(cwd=>{
  assert.deepEqual(pluginGitNetworkOptions(cwd,plugin,{}),{});save(cwd,'.liyuan-tavern-plugins',{gitProxy:shared,unknown:{keep:true}});
  const before=readFileSync(join(cwd,'.liyuan-tavern-plugins/network.json'));
  assert.deepEqual(pluginGitNetworkOptions(cwd,plugin,{}),{proxy:shared});
  assert.deepEqual(pluginGitNetworkOptions(cwd,plugin,{LIYUAN_TAVERN_GIT_PROXY:local}),{proxy:local});
  assert.deepEqual(readFileSync(join(cwd,'.liyuan-tavern-plugins/network.json')),before);
 }));
 test(`${plugin}: private empty override means direct and does not change other plugins`,()=>fixture(cwd=>{
  save(cwd,'.liyuan-tavern-plugins',{gitProxy:shared});save(cwd,`.liyuan-${plugin}`,{gitProxy:'',futureField:{keep:true}});
  assert.deepEqual(pluginGitNetworkOptions(cwd,plugin,{LIYUAN_TAVERN_GIT_PROXY:shared}),{proxy:''});
  const ownVariable='LIYUAN_VERIDIS_REWRITE_GIT_PROXY';
  assert.deepEqual(pluginGitNetworkOptions(cwd,plugin,{[ownVariable]:local}),{proxy:local});
  assert.deepEqual(pluginGitNetworkOptions(cwd,plugin,{[ownVariable]:''}),{proxy:''});
  if(plugin==='veridis-rewrite'){
   assert.deepEqual(pluginGitNetworkOptions(cwd,plugin,{LIYUAN_VERIDIS_GIT_PROXY:local}),{proxy:local});
   assert.deepEqual(pluginGitNetworkOptions(cwd,plugin,{LIYUAN_VERIDIS_GIT_PROXY:''}),{proxy:''});
   assert.deepEqual(pluginGitNetworkOptions(cwd,plugin,{[ownVariable]:'',LIYUAN_VERIDIS_GIT_PROXY:local}),{proxy:''});
  }
 }));
 test(`${plugin}: malformed/symlink/credential routes fail closed without disclosing values`,()=>fixture(cwd=>{
  for(const gitProxy of [42,'http://user:synthetic-private-secret@127.0.0.1:9','file:///tmp/cache','socks5://127.0.0.1:9']){
   save(cwd,`.liyuan-${plugin}`,{gitProxy});assert.throws(()=>pluginGitNetworkOptions(cwd,plugin,{}),error=>error instanceof Error&&!error.message.includes('synthetic-private-secret'));
  }
  const path=join(cwd,`.liyuan-${plugin}`,'network.json');writeFileSync(path,'{');assert.throws(()=>pluginGitNetworkOptions(cwd,plugin,{}),/JSON/);
  writeFileSync(path,' '.repeat(4097));assert.throws(()=>pluginGitNetworkOptions(cwd,plugin,{}),/类型/);
  rmSync(path);writeFileSync(join(cwd,'outside.json'),'{}');symlinkSync(join(cwd,'outside.json'),path);assert.throws(()=>pluginGitNetworkOptions(cwd,plugin,{}),/类型/);
  rmSync(path);symlinkSync(join(cwd,'missing.json'),path);assert.throws(()=>pluginGitNetworkOptions(cwd,plugin,{}),/类型/);
  rmSync(join(cwd,`.liyuan-${plugin}`),{recursive:true,force:true});mkdirSync(join(cwd,'outside'));symlinkSync(join(cwd,'outside'),join(cwd,`.liyuan-${plugin}`));assert.throws(()=>pluginGitNetworkOptions(cwd,plugin,{}),/目录/);
  rmSync(join(cwd,`.liyuan-${plugin}`));symlinkSync(join(cwd,'missing-directory'),join(cwd,`.liyuan-${plugin}`));assert.throws(()=>pluginGitNetworkOptions(cwd,plugin,{}),/目录/);
 }));
}
