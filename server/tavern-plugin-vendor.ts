/** Fixed, original browser dependencies. They are private installation data, never rebuilt plugin code. */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);
const repos = {
 tavern: ["https://github.com/SillyTavern/SillyTavern.git", "1.13.4", "6dabf12ed785087cfe50b8027c582b16faa2ac4d"],
 lodash: ["https://github.com/lodash/lodash.git", "4.17.21", "f299b52f39486275a9e6483b60a410e06520c538"],
 showdown: ["https://github.com/showdownjs/showdown.git", "2.1.0", "9958ba5cfaf01c93ea9e1a48650fb3074eff98ce"],
 dompurify: ["https://github.com/cure53/DOMPurify.git", "3.2.6", "32f765e632ff34eebf5e08128ae1ff8f0d0bbe7a"],
 moment: ["https://github.com/moment/moment.git", "2.30.1", "485d9a7d709bd5f3869a7ad24630cf0746d072dc"],
} as const;
const files: Record<string, readonly [keyof typeof repos, string, string]> = {
 "regex-engine.js": ["tavern", "public/scripts/extensions/regex/engine.js", "9b9ab47b8a29b5c8e274f25512ffaf6c728aae600ffa4c2b37001bcaf80b64c3"],
 "jquery.js": ["tavern", "public/lib/jquery-3.5.1.min.js", "f7f6a5894f1d19ddad6fa392b2ece2c5e578cbf7da4ea805b6885eb6985b6e3d"],
 "jquery-touch-punch.js": ["tavern", "public/lib/jquery.ui.touch-punch.min.js", "eaf381425cd6ad28c88bc38be506fe5edb50de396eace3bd6887a1065328d7b5"],
 "jquery-ui.js": ["tavern", "public/lib/jquery-ui.min.js", "9528ca634fecad433d044ddd3e6f9ce1f068d5d932dafdbb19d8e6daea1968bd"],
 "toastr.js": ["tavern", "public/lib/toastr.min.js", "ddb96c25de07962ffbc0243e6e68177ce74aee9fd950cb4f5d8d3c8e6c524a09"],
 "jszip.js": ["tavern", "public/lib/jszip.min.js", "acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e"],
 "lodash.js": ["lodash", "lodash.js", "4c04561befdf653aef017a42ac5addf68ea943cdfca6bdee5ce04e04e8139f54"],
 "showdown.js": ["showdown", "dist/showdown.min.js", "88eb6fbbe0c270ddf3384aee0c9620d070e090a26e07c67421ae36c903b5d649"],
 "dompurify.js": ["dompurify", "dist/purify.min.js", "89e1fa7647cb495370d3a997ace4387f5d15d9f4c5af12352c53daa400956287"],
 "moment.js": ["moment", "min/moment.min.js", "845c524969edd5b3af9aa6d8718d29fe92e8dbe25b955214a8e064a05a9a5027"],
};
const extras:Record<string,{url:string;sha256:string}> = {
  "popper.js": {
    "url": "https://unpkg.com/@popperjs/core@2.11.8/dist/umd/popper.min.js",
    "sha256": "c212f4b505a86352aed62b24a8f16f999f821ecbe6456c7f3c8a04bc87968782"
  },
  "vue.js": {
    "url": "https://unpkg.com/vue@3.5.43/dist/vue.runtime.global.prod.js",
    "sha256": "f2f1547993b942e5e24f2d6e63577b21739a37a920e09c656b0e87eb0ad55175"
  },
  "vue-router.js": {
    "url": "https://unpkg.com/vue-router@5.3.1/dist/vue-router.global.prod.js",
    "sha256": "7e8fe59f3bae259c46017c7798f4c8b75fa87cbbe9120fc16243d9b447ca68de"
  }
};
const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
export function tavernVendorAsset(cwd: string, name: string): string | null {
 const entry = files[name]; if (!entry && !extras[name]) return null;
 const path = join(cwd, ".liyuan-tavern-plugins", "vendor", name);
 if (!existsSync(path)) return null;
 if (!lstatSync(path).isFile() || hash(readFileSync(path)) !== (entry?.[2] ?? extras[name]?.sha256)) throw new Error(`酒馆兼容依赖完整性校验失败：${name}`);
 return path;
}
export async function ensureTavernPluginVendors(cwd: string, options: { fixtureRoot?: string; proxy?: string } = {}): Promise<void> {
 const root = join(cwd, ".liyuan-tavern-plugins", "vendor"); mkdirSync(root, { recursive: true, mode: 0o700 }); chmodSync(root, 0o700);
 for(const [name,entry] of Object.entries(extras))if(!tavernVendorAsset(cwd,name)){
  const target=join(root,name);if(options.fixtureRoot){const bytes=readFileSync(join(options.fixtureRoot,name));if(hash(bytes)!==entry.sha256)throw new Error(`${name}原依赖校验失败`);writeFileSync(target,bytes,{mode:0o600});}
  else{const proxy=options.proxy??process.env.LIYUAN_TAVERN_GIT_PROXY??process.env.HTTPS_PROXY??process.env.HTTP_PROXY;await run("curl",[...(proxy?["--proxy",proxy]:[]),"--fail","--silent","--show-error","--location","--max-time","90",entry.url,"--output",target],{timeout:100_000});chmodSync(target,0o600);if(hash(readFileSync(target))!==entry.sha256)throw new Error(`${name}固定原字节校验失败`);}
 }
 const missing = Object.entries(files).filter(([name]) => !tavernVendorAsset(cwd, name)); if (!missing.length) return;
 const temp = await mkdtemp(join(tmpdir(), "liyuan-tavern-vendors-"));
 try {
  for (const id of new Set(missing.map(([, e]) => e[0]))) {
   const [url, ref, commit] = repos[id]; const repo = options.fixtureRoot ? join(options.fixtureRoot, id) : join(temp, id);
   if (!options.fixtureRoot) {
    const proxy = options.proxy ?? process.env.LIYUAN_TAVERN_GIT_PROXY ?? process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY;
    await run("git", ["-c", "credential.helper=", ...(proxy ? ["-c", `http.proxy=${proxy}`] : []), "clone", "--depth=1", "--branch", ref, url, repo], { timeout: 180_000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
   }
   const actual = (await run("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim(); if (actual !== commit) throw new Error(`浏览器依赖 ${id} 固定 Git 对象不一致`);
   for (const [name, [source, relative, expected]] of missing) {
    if (source !== id) continue; const b = readFileSync(join(repo, relative)); if (hash(b) !== expected) throw new Error(`浏览器依赖 ${name} 原字节不一致`);
    writeFileSync(join(root, name), b, { mode: 0o600 }); chmodSync(join(root, name), 0o600);
   }
  }
 } finally { await rm(temp, { recursive: true, force: true }); }
}
