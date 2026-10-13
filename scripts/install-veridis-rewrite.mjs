#!/usr/bin/env node
/** Stage original Veridis Rewrite assets only; activation requires the live host's synthetic validator. */
import { resolve } from 'node:path';
import { VeridisRewriteSources } from '../server/veridis-rewrite-source.ts';

const args = process.argv.slice(2);
function value(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const result = args[index + 1];
  if (!result || result.startsWith('--')) throw new Error(`${name} 需要一个值`);
  return result;
}
const allowed = new Set(['--cwd', '--proxy', '--commit', '--fixture-repo']);
for (const arg of args) {
  if (arg.startsWith('--') && !allowed.has(arg)) throw new Error(`不支持的参数：${arg}`);
}
const cwd = resolve(value('--cwd') ?? process.cwd());
const proxy = value('--proxy');
const commit = value('--commit');
const fixtureRepo = value('--fixture-repo');
const sources = new VeridisRewriteSources(cwd, { isIdle: () => false });
try {
  const result = await sources.checkUpdate({
    ...(proxy ? { proxy } : {}),
    ...(commit ? { commit } : {}),
    ...(fixtureRepo ? { fixtureRepo: resolve(fixtureRepo) } : {}),
  });
  console.log(JSON.stringify({
    staged: true,
    activated: false,
    enabled: sources.status().enabled,
    ...result,
    note: '只暂存并校验上游原始字节；尚未运行梨园合成宿主验收，不代表运行兼容。正式启用须由主程序验收后显式 configure({ enabled: true })。',
  }, null, 2));
} finally {
  sources.close();
}
