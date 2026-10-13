/** Explicit fixtures only: never falls back to production plugin cache/card/model connections. */
const index=process.argv.indexOf('--fixtures');
if(index<0||!process.argv[index+1])throw new Error('请用 --fixtures 指定隔离的原上游仓库/浏览器依赖目录');
process.env.LIYUAN_TAVERN_PLUGIN_FIXTURES=process.argv[index+1];
const {existsSync}=await import('node:fs');
const {join}=await import('node:path');
const binary=join(process.cwd(),'.liyuan-database-plugin','browser','headless_shell');
const libs=join(process.cwd(),'.liyuan-database-plugin','browser-libs','lib64');
if(!process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE&&existsSync(binary))process.env.LIYUAN_DATABASE_BROWSER_EXECUTABLE=binary;
if(!process.env.LIYUAN_DATABASE_BROWSER_LIBS&&existsSync(libs))process.env.LIYUAN_DATABASE_BROWSER_LIBS=libs;
await import('../test/tavern-plugin-compatibility.test.ts');

await import('../test/tavern-plugin-settings.test.ts');
