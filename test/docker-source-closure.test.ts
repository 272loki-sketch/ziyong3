import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
const copiedSources = dockerfile.split(/\r?\n/).filter(line => /^COPY\s+/i.test(line))
 .flatMap(line => line.trim().split(/\s+/).slice(1, -1));
const copied = (path: string) => copiedSources.some(source => path === source || path.startsWith(source + "/"));

test("Docker image retains public host modules imported by the backend", () => {
 const runtime = readFileSync(new URL("../server/tavern-plugin-runtime.ts", import.meta.url), "utf8");
 const imports = [...runtime.matchAll(/from\s+["'](\.\.\/web\/public\/[^"']+)["']/g)];
 assert.ok(imports.length > 0, "the direct public-module import must be represented");
 for (const match of imports) {
  const path = posix.normalize(posix.join("server", match[1]));
  assert.ok(copied(path), `missing Docker source dependency ${path}`);
  assert.ok(readFileSync(new URL("../" + path, import.meta.url)).length > 0);
 }
 assert.ok(copied("web/public/database-plugin-host.js"));
 assert.ok(copied("web/dist/index.html"), "prebuilt UI stays available separately");
});

test("Docker image includes builtin protocol skills and source license notices without real configs", () => {
 for (const path of ["skills/主作者正文边界/SKILL.md", "skills/导演主Agent/SKILL.md", "LICENSE", "licenses/README.md", "licenses/Luker-AGPL-3.0.txt"]) {
  assert.ok(copied(path), `missing approved runtime/notice path ${path}`);
  assert.ok(readFileSync(new URL("../" + path, import.meta.url)).length > 0);
 }
 assert.ok(!copiedSources.includes("."), "do not recursively copy the whole dirty worktree");
 for (const privatePath of ["liyuan.agent.json", "liyuan.config.json", ".liyuan-stage-skills", ".liyuan-history", ".liyuan-veridis-rewrite"])
  assert.ok(!copied(privatePath), `private Docker source ${privatePath}`);
 assert.ok(root.length > 0);
});
