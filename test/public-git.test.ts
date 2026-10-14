import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, renameSync, chmodSync, statSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { preparePublicGit, validateRemote } from '../scripts/prepare-public-git.mjs';
import { auditRepository } from '../scripts/check-repository-privacy.mjs';

const token = ['ghp_', 'A'.repeat(36)].join('');
const cli = resolve('scripts/prepare-public-git.mjs');

function fixture(t: any) {
  const parent = realpathSync(process.platform === 'linux' && existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir());
  const dir = mkdtempSync(join(parent, 'public-git-test-'));
  const source = join(dir, 'source');
  mkdirSync(source);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const gitAt = (cwd: string, ...args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: {
      ...process.env, GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid',
      GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const git = (...args: string[]) => gitAt(source, ...args);
  git('init', '-q');
  const put = (path: string, bytes: string | Buffer = 'public\n') => {
    mkdirSync(dirname(join(source, path)), { recursive: true });
    writeFileSync(join(source, path), bytes);
  };
  let serial = 0;
  const prepare = (options: any = {}) => preparePublicGit({ source, output: join(dir, `candidate-${serial++}`), ...options });
  return { dir, source, git, gitAt, put, prepare };
}

test('exports disk snapshot, skips private and unapproved entries without reads, preserves source', t => {
  const { source, put, git, gitAt, prepare } = fixture(t);
  put('.gitignore', '.local/\nsrc/ignored.ts\n');
  put('src/a.ts', token);
  put('liyuan.agent.json', token);
  put('.local/private.json', token);
  git('add', '-f', '--', '.gitignore', 'src/a.ts', 'liyuan.agent.json', '.local/private.json');
  git('commit', '-qm', 'Synthetic secret history');
  const head = git('rev-parse', 'HEAD');
  const privateOid = git('rev-parse', ':liyuan.agent.json');
  put('src/a.ts', 'safe disk version\n');
  put('src/new.ts');
  put('src/ignored.ts', token);
  put('assets/cards/personal.json', token);
  put('scripts/probe-new.mjs', token);
  put('unapproved.txt', token);
  // Neither this tracked forbidden blob nor its nonregular worktree path may be read.
  rmSync(join(source, '.git/objects', privateOid.slice(0, 2), privateOid.slice(2)));
  rmSync(join(source, 'liyuan.agent.json'));
  mkdirSync(join(source, 'liyuan.agent.json'));
  const index = readFileSync(join(source, '.git/index'));
  const config = readFileSync(join(source, '.git/config'));
  const privateBytes = readFileSync(join(source, '.local/private.json'));
  const result = prepare();
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.skipped['private-path'], 2);
  assert.equal(result.skipped['unapproved-asset'], 1);
  assert.equal(result.skipped['local-diagnostic'], 1);
  assert.equal(result.skipped['local-record'], 1);
  assert.equal(readFileSync(join(result.output, 'src/a.ts'), 'utf8'), 'safe disk version\n');
  assert.equal(gitAt(result.output, 'show', ':src/a.ts'), 'safe disk version');
  assert.equal(gitAt(result.output, 'ls-files'), '.gitignore\nsrc/a.ts\nsrc/new.ts');
  assert.deepEqual(readFileSync(join(source, '.git/index')), index);
  assert.deepEqual(readFileSync(join(source, '.git/config')), config);
  assert.deepEqual(readFileSync(join(source, '.local/private.json')), privateBytes);
  assert.equal(git('rev-parse', 'HEAD'), head);
  assert.equal(spawnSync('git', ['cat-file', '-e', head], { cwd: result.output }).status === 0, false);
  assert.equal(spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd: result.output }).status === 0, false);
  assert.equal(gitAt(result.output, 'remote'), '');
  const manifest = readFileSync(join(result.output, '.git/liyuan-public-manifest.json'), 'utf8');
  assert.equal(manifest.includes(source), false);
  assert.equal(manifest.includes('.local'), false);
  assert.equal(manifest.includes(token), false);
});

test('excluded upstream binary and host diagnostic are omitted before reads without changing source', t => {
  const { source, put, git, gitAt, prepare } = fixture(t);
  const paths = ['packages/coding-agent/examples/extensions/doom-overlay/doom/build/doom.wasm',
    'scripts/test-flash-sdk-transport.mjs'];
  put('.gitignore', paths.map(path => `/${path}\n`).join(''));
  for (const path of paths) put(path, Buffer.from([0, 255]));
  git('add', '-f', '--', '.gitignore', ...paths);
  git('commit', '-qm', 'Synthetic excluded paths');
  const oid = git('rev-parse', `:${paths[0]}`);
  rmSync(join(source, '.git/objects', oid.slice(0, 2), oid.slice(2)));
  for (const path of paths) {
    rmSync(join(source, path));
    mkdirSync(join(source, path));
  }
  put('src/a.ts');
  const index = readFileSync(join(source, '.git/index'));
  const head = git('rev-parse', 'HEAD');
  for (const allowBinaryChanges of [false, true]) {
    const result = prepare({ allowBinaryChanges });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.skipped['excluded-third-party-asset'], 1);
    assert.equal(result.skipped['local-diagnostic'], 1);
    assert.equal(gitAt(result.output, 'ls-files'), '.gitignore\nsrc/a.ts');
    const manifest = readFileSync(join(result.output, '.git/liyuan-public-manifest.json'), 'utf8');
    for (const path of paths) {
      assert.equal(existsSync(join(result.output, path)), false);
      assert.equal(manifest.includes(path), false);
      assert.equal(statSync(join(source, path)).isDirectory(), true);
    }
  }
  assert.deepEqual(readFileSync(join(source, '.git/index')), index);
  assert.equal(git('rev-parse', 'HEAD'), head);
});

test('tracked ignored public paths export, absent tracked files are deletions, repeated output never overwrites', t => {
  const { put, git, source, prepare } = fixture(t);
  put('.gitignore', 'src/ignored.ts\n'); put('src/ignored.ts'); put('src/deleted.ts');
  git('add', '-f', '--', '.gitignore', 'src/ignored.ts', 'src/deleted.ts');
  rmSync(join(source, 'src/deleted.ts'));
  const first = prepare();
  assert.equal(first.ok, true);
  assert.equal(first.deleted, 1);
  assert.equal(existsSync(join(first.output, 'src/ignored.ts')), true);
  assert.equal(existsSync(join(first.output, 'src/deleted.ts')), false);
  const second = prepare({ output: first.output });
  assert.equal(second.ok, false);
  assert.equal(second.findings[0].category, 'output-exists');
});

test('local records are omitted before any source read while approved public guides export', t => {
  const { source, dir, put, git, gitAt, prepare } = fixture(t);
  const records = ['PUBLICATION.md', 'docs/VALIDATION-SYNTHETIC.md', 'docs/SYNTHETIC-REPORT.md',
    'docs/SYNTHETIC-AUDIT.md', 'docs/RELEASE-NOTES.md', 'docs/unapproved-guide.md',
    'docs/AGENTIC-RESEARCH.docx', 'docs/images/home.png'];
  put('.gitignore', 'docs/VALIDATION-*\n');
  for (const path of records) put(path, token);
  git('add', '-f', '--', '.gitignore', ...records);
  const oid = git('rev-parse', `:${records[0]}`);
  rmSync(join(source, '.git/objects', oid.slice(0, 2), oid.slice(2)));
  for (const path of records) {
    rmSync(join(source, path));
    mkdirSync(join(source, path));
  }
  const guides = ['docs/PROJECT-STRUCTURE.md', 'docs/PRIVACY-AND-PUBLISHING.md',
    'docs/DOCUMENTATION-INDEX.md', 'docs/ARCHITECTURE-OVERVIEW.md',
    'docs/GENERATION-MODES.md', 'docs/PLAN-ROUND-FLOW.md'];
  for (const path of guides) put(path);
  const lines: string[] = [];
  const result = prepare({ report: (line: string) => lines.push(line) });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.skipped['local-record'], records.length);
  assert.deepEqual(lines, []);
  assert.equal(gitAt(result.output, 'ls-files'), ['.gitignore', ...guides].sort().join('\n'));
  for (const path of records) assert.equal(existsSync(join(result.output, path)), false);
  const manifest = readFileSync(join(result.output, '.git/liyuan-public-manifest.json'), 'utf8');
  for (const path of records) assert.equal(manifest.includes(path), false);
  const run = spawnSync(process.execPath, [cli, '--output', join(dir, 'cli-candidate')], { cwd: source, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  for (const path of records) assert.equal((run.stdout + run.stderr).includes(path), false);
  assert.equal((run.stdout + run.stderr).includes(token), false);
});

test('credentials fail before output writes and diagnostics never contain bytes', t => {
  const { put, prepare, dir, source } = fixture(t);
  put('src/a.ts'); put('src/secret.ts', token);
  const lines: string[] = [];
  const output = join(dir, 'never-created');
  const result = prepare({ output, report: (line: string) => lines.push(line) });
  assert.equal(result.ok, false);
  assert.equal(existsSync(output), false);
  assert.deepEqual(lines, ['credential-token "src/secret.ts"']);
  assert.equal(JSON.stringify(result).includes(token), false);
  const run = spawnSync(process.execPath, [cli, '--json', '--output', output], { cwd: source, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.equal(run.stderr, '');
  assert.equal(JSON.parse(run.stdout).ok, false);
  assert.equal(run.stdout.includes(token), false);
});

test('leaf and parent links fail, including a tracked public link', t => {
  if (process.platform === 'win32') return t.skip('POSIX symlink fixture');
  const { source, put, git, prepare } = fixture(t);
  put('src/nested/a.ts'); git('add', '--', 'src/nested/a.ts');
  renameSync(join(source, 'src/nested'), join(source, 'outside'));
  symlinkSync(join(source, 'outside'), join(source, 'src/nested'));
  assert.equal(prepare().findings[0].category, 'unsafe-parent');
  rmSync(join(source, 'src/nested'));
  renameSync(join(source, 'outside'), join(source, 'src/nested'));
  symlinkSync(join(source, 'src/nested/a.ts'), join(source, 'src/link.ts'));
  assert.equal(prepare().findings[0].category, 'nonregular-file');
  git('add', '--', 'src/link.ts');
  assert.equal(prepare().findings[0].category, 'nonregular-file');
});

test('output rejects ancestors, descendants, existing leaves, traversal and symlink parents', t => {
  const { dir, source, put, prepare } = fixture(t);
  put('src/a.ts');
  for (const output of [source, dir, join(source, 'new'), `${dir}/a/../new`]) {
    assert.equal(prepare({ output }).ok, false);
  }
  if (process.platform !== 'win32') {
    symlinkSync(source, join(dir, 'alias'));
    assert.equal(prepare({ output: join(dir, 'alias', 'new') }).ok, false);
    symlinkSync(join(dir, 'missing'), join(dir, 'leaf'));
    assert.equal(prepare({ output: join(dir, 'leaf') }).findings[0].category, 'output-exists');
  }
});

test('tracked executable mode comes from index, untracked mode from disk; files are restricted', t => {
  if (process.platform === 'win32') return t.skip('POSIX executable permissions');
  const { put, git, source, gitAt, prepare } = fixture(t);
  put('src/tracked.sh'); git('add', '--', 'src/tracked.sh'); git('update-index', '--chmod=+x', 'src/tracked.sh');
  chmodSync(join(source, 'src/tracked.sh'), 0o600);
  put('src/new.sh'); chmodSync(join(source, 'src/new.sh'), 0o700);
  const result = prepare();
  assert.equal(result.ok, true);
  assert.match(gitAt(result.output, 'ls-files', '--stage'), /^100755 .*src\/new.sh\n100755 .*src\/tracked.sh$/);
  assert.equal(statSync(result.output).mode & 0o777, 0o700);
  assert.equal(statSync(join(result.output, 'src/tracked.sh')).mode & 0o777, 0o700);
  assert.equal(statSync(join(result.output, '.git/liyuan-public-manifest.json')).mode & 0o777, 0o600);
});

test('unchanged baseline binary passes; changed/new baseline requires explicit review; arbitrary binary fails', t => {
  const { put, git, prepare } = fixture(t);
  put('web/public/logo.png', Buffer.from([0, 255])); git('add', '--', 'web/public/logo.png'); git('commit', '-qm', 'Synthetic binary baseline');
  assert.equal(prepare().ok, true);
  put('web/public/logo.png', Buffer.from([0, 254]));
  assert.equal(prepare().findings[0].category, 'binary-change-review-required');
  assert.equal(prepare({ allowBinaryChanges: true }).ok, true);
  put('web/public/favicon.png', Buffer.from([0, 255]));
  assert.equal(prepare().findings.some((f: any) => f.category === 'binary-change-review-required'), true);
  assert.equal(prepare({ allowBinaryChanges: true }).ok, true);
  put('src/arbitrary.bin', Buffer.from([0, 255]));
  assert.equal(prepare({ allowBinaryChanges: true }).findings[0].category, 'binary-review-required');
});

test('unmerged index and public submodule entries fail before candidate creation', t => {
  const { put, git, source, prepare } = fixture(t);
  put('src/a.ts'); git('add', '--', 'src/a.ts'); git('commit', '-qm', 'Synthetic');
  const head = git('rev-parse', 'HEAD');
  git('update-index', '--add', '--cacheinfo', `160000,${head},src/submodule`);
  assert.equal(prepare().findings[0].category, 'nonregular-file');
  git('update-index', '--force-remove', 'src/submodule');
  const oid = git('rev-parse', ':src/a.ts'); git('update-index', '--force-remove', 'src/a.ts');
  assert.equal(spawnSync('git', ['update-index', '--index-info'], { cwd: source, input: `100644 ${oid} 1\tsrc/a.ts\n100644 ${oid} 2\tsrc/a.ts\n` }).status, 0);
  assert.equal(prepare().findings.every((f: any) => f.category === 'unmerged-index'), true);
});

test('remote validation is narrow, branch validation precedes fetch, errors are redacted', t => {
  for (const remote of ['https://github.com/owner/repo.git', 'git@gitlab.com:owner/repo.git', 'https://codeberg.org/owner/repo']) assert.equal(validateRemote(remote), true, remote);
  for (const remote of ['/tmp/repo', 'file:///tmp/repo', 'https://localhost/a/b', 'https://127.0.0.1/a/b', 'ssh://git@github.com/a/b', 'git@unknown.example:a/b', 'https://github.com/a/../b', 'https://github.com/a/b?token=value', 'https://' + 'user:pass@github.com/a/b', 'https://github.com:443/a/b', '-option', 'https://github.com/a/%62']) assert.equal(validateRemote(remote), false, remote);
  const { put, prepare } = fixture(t);
  put('src/a.ts');
  assert.equal(prepare({ branch: '-bad' }).findings[0].category, 'invalid-branch');
  assert.equal(prepare({ branch: 'a..b' }).findings[0].category, 'invalid-branch');
  const lines: string[] = [];
  const result = prepare({ remote: 'https://' + 'user:private-password@github.com/a/b', report: (line: string) => lines.push(line) });
  assert.equal(result.ok, false);
  assert.deepEqual(lines, ['invalid-remote ""']);
  assert.equal(JSON.stringify(result).includes('private-password'), false);
});

test('portable path aliases and oversize files fail closed', t => {
  const { put, prepare } = fixture(t);
  put('src/large.ts', Buffer.alloc(16 * 1024 * 1024 + 1, 65));
  assert.equal(prepare().findings[0].category, 'size-limit');
  if (process.platform !== 'win32') {
    put('src/a:stream.ts'); put('src/CON.ts'); put('src/odd\nname.ts');
    assert.equal(prepare().findings.every((f: any) => f.category === 'invalid-path'), true);
  }
});

test('default output is unique and external; source config hooks and filters are not inherited', t => {
  const { source, put, git, gitAt } = fixture(t);
  put('src/a.ts'); put('.gitattributes', '*.ts text eol=lf\n');
  git('config', 'filter.unsafe.clean', 'false');
  git('config', 'core.hooksPath', '/nonexistent/synthetic-hooks');
  const a = preparePublicGit({ source }), b = preparePublicGit({ source });
  for (const result of [a, b]) {
    if (result.output) t.after(() => rmSync(result.output, { recursive: true, force: true }));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.output.startsWith(source + '/'), false);
    assert.equal(gitAt(result.output, 'show', ':src/a.ts'), 'public');
    assert.equal(readFileSync(join(result.output, '.git/config'), 'utf8').includes('unsafe'), false);
    assert.equal(result.hooksEnabled, true);
    assert.equal(existsSync(join(result.output, '.git/hooks/pre-commit')), true);
  }
  assert.notEqual(a.output, b.output);
});

test('remote mode audits before materializing, stages exact removals against public base, and rejects forbidden base', t => {
  if (process.platform === 'win32') return t.skip('POSIX executable transport shim');
  const { dir, source, put, prepare, gitAt } = fixture(t);
  const remote = join(dir, 'remote'), bin = join(dir, 'bin');
  mkdirSync(remote); mkdirSync(bin);
  gitAt(remote, 'init', '-q', '--initial-branch=main');
  mkdirSync(join(remote, 'src'));
  writeFileSync(join(remote, 'src/old.ts'), 'old public\n');
  writeFileSync(join(remote, 'src/keep.ts'), 'base public\n');
  const recordPaths = ['docs/VALIDATION-SYNTHETIC.md', 'docs/SYNTHETIC-REPORT.md',
    'docs/SYNTHETIC-AUDIT.md', 'docs/RELEASE-NOTES.md', 'docs/AGENTIC-RESEARCH.docx', 'docs/images/home.png'];
  for (const path of recordPaths) {
    mkdirSync(dirname(join(remote, path)), { recursive: true });
    writeFileSync(join(remote, path), ['-----BEGIN ', 'PRIVATE KEY-----\n', token, '\n'].join(''));
  }
  gitAt(remote, 'add', '--', 'src/old.ts', 'src/keep.ts', ...recordPaths);
  gitAt(remote, 'commit', '-qm', 'Synthetic public base');
  const base = gitAt(remote, 'rev-parse', 'HEAD');
  const recordOids = recordPaths.map(path => gitAt(remote, 'rev-parse', `HEAD:${path}`));
  put('src/keep.ts', 'new public\n'); put('src/new.ts');
  const actualGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  // Only the isolated test executable redirects transport. CLI validation still
  // sees a public URL; production has no local-remote escape hatch.
  writeFileSync(join(bin, 'git'), `#!${process.execPath}\n` +
    `const {spawnSync}=require('node:child_process');\n` +
    `const args=process.argv.slice(2); const fetch=args.includes('fetch');\n` +
    `if(fetch) args[args.indexOf('https://github.com/synthetic/public.git')]=${JSON.stringify(remote)};\n` +
    `let input; if(args.includes('cat-file')) { input=require('node:fs').readFileSync(0); const forbidden=${JSON.stringify(recordOids)}; if(forbidden.some(oid=>args.includes(oid)||input.toString().split(/\\s+/).includes(oid))) process.exit(91); }\n` +
    `const r=spawnSync(${JSON.stringify(actualGit)},args,{input,env:{...process.env,...(fetch?{GIT_ALLOW_PROTOCOL:'file'}:{})},stdio:[input===undefined?'inherit':'pipe','inherit','inherit']});process.exit(r.status??1);\n`, { mode: 0o700 });
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  try {
    const lines: string[] = [];
    const result = prepare({ remote: 'https://github.com/synthetic/public.git', report: (line: string) => lines.push(line) });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.baseOid, base);
    assert.equal(result.baseRemovals, 1 + recordPaths.length);
    assert.deepEqual(lines, []);
    assert.equal(gitAt(result.output, 'rev-parse', 'HEAD'), base);
    assert.equal(gitAt(result.output, 'diff', '--cached', '--name-status'),
      [...recordPaths.toSorted().map(path => `D\t${path}`), 'M\tsrc/keep.ts', 'A\tsrc/new.ts', 'D\tsrc/old.ts'].join('\n'));
    for (const path of recordPaths) assert.equal(existsSync(join(result.output, path)), false);
    assert.equal(existsSync(join(result.output, 'docs')), false);
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.equal(existsSync(join(result.output, 'src/old.ts')), false);
    assert.equal(gitAt(result.output, 'remote'), '');
    assert.equal(readFileSync(join(result.output, '.git/liyuan-public-manifest.json'), 'utf8').includes('github.com'), false);
    writeFileSync(join(remote, 'liyuan.agent.json'), token);
    gitAt(remote, 'add', '--', 'liyuan.agent.json'); gitAt(remote, 'commit', '-qm', 'Synthetic forbidden base');
    const rejected = prepare({ remote: 'https://github.com/synthetic/public.git' });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.findings.some((f: any) => f.category === 'private-path'), true);
    assert.equal(existsSync(join(rejected.output, 'src')), false);
    assert.equal(existsSync(join(rejected.output, 'liyuan.agent.json')), false);
    assert.equal(JSON.stringify(rejected).includes(token), false);
    rmSync(join(remote, 'liyuan.agent.json'));
    gitAt(remote, 'add', '--', 'liyuan.agent.json');
    writeFileSync(join(remote, 'src/keep.ts'), token);
    gitAt(remote, 'add', '--', 'src/keep.ts'); gitAt(remote, 'commit', '-qm', 'Synthetic unsafe allowed blob');
    const unsafe = prepare({ remote: 'https://github.com/synthetic/public.git' });
    assert.equal(unsafe.ok, false);
    assert.equal(unsafe.findings.some((f: any) => f.category === 'credential-token'), true);
    assert.equal(existsSync(join(unsafe.output, 'src')), false);
  } finally { process.env.PATH = previous; }
  assert.equal(existsSync(join(source, '.git/refs/heads/main')), false);
});

test('candidate hooks are private, portable, independent of editable scripts and reject staged secrets', t => {
  const { source, put, prepare, gitAt } = fixture(t);
  put('src/a.ts');
  const sourceConfig = readFileSync(join(source, '.git/config'));
  const result = prepare();
  assert.equal(result.ok, true);
  assert.equal(result.hooksEnabled, true);
  assert.deepEqual(readFileSync(join(source, '.git/config')), sourceConfig);
  assert.equal(existsSync(join(source, '.git/hooks/liyuan-public-guard')), false);
  for (const hook of ['pre-commit', 'pre-push']) {
    const text = readFileSync(join(result.output, '.git/hooks', hook), 'utf8');
    assert.equal(text, `#!/bin/sh\nexec node .git/liyuan-public-guard/public-git-guard.mjs ${hook}\n`);
    assert.equal(text.includes(source), false);
    if (process.platform !== 'win32') assert.equal(statSync(join(result.output, '.git/hooks', hook)).mode & 0o777, 0o700);
  }
  assert.equal(gitAt(result.output, 'ls-files').includes('guard'), false);
  // Git really executes the installed pre-commit hook, even with no scripts/.
  gitAt(result.output, 'commit', '-qm', 'Synthetic audited candidate');
  const head = gitAt(result.output, 'rev-parse', 'HEAD');
  mkdirSync(join(result.output, 'scripts'));
  writeFileSync(join(result.output, 'scripts/check-repository-privacy.mjs'), 'process.exit(0);\n');
  writeFileSync(join(result.output, 'src/a.ts'), token);
  gitAt(result.output, 'add', '--', 'src/a.ts');
  writeFileSync(join(result.output, 'src/a.ts'), 'safe disk\n');
  const rejected = spawnSync('git', ['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'Synthetic blocked'], {
    cwd: result.output, encoding: 'utf8',
  });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stdout + rejected.stderr, /credential-token "src\/a.ts"/);
  assert.equal((rejected.stdout + rejected.stderr).includes(token), false);
  assert.equal(gitAt(result.output, 'rev-parse', 'HEAD'), head);
  gitAt(result.output, 'add', '--', 'src/a.ts');
  gitAt(result.output, 'commit', '-qm', 'Synthetic normal edit');
});

test('pre-push scans every introduced commit, skips deletions and fails closed for unknown endpoints and shallow new branches', t => {
  const { put, prepare, gitAt } = fixture(t);
  put('src/a.ts');
  const result = prepare();
  assert.equal(result.ok, true);
  const cwd = result.output;
  gitAt(cwd, 'commit', '-qm', 'Synthetic clean base');
  const base = gitAt(cwd, 'rev-parse', 'HEAD');
  const zero = '0'.repeat(base.length);
  const push = (input: string) => spawnSync('sh', ['.git/hooks/pre-push', 'unused', 'never-logged-secret-url'], { cwd, input, encoding: 'utf8' });
  assert.equal(push(`refs/heads/main ${base} refs/heads/main ${zero}\n`).status, 0);
  writeFileSync(join(cwd, 'src/a.ts'), token);
  gitAt(cwd, 'add', '--', 'src/a.ts');
  // Deliberately manufacture unsafe synthetic history to challenge pre-push.
  gitAt(cwd, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Synthetic unsafe history');
  writeFileSync(join(cwd, 'src/a.ts'), 'public repaired\n');
  gitAt(cwd, 'add', '--', 'src/a.ts');
  gitAt(cwd, 'commit', '-qm', 'Synthetic repair');
  const tip = gitAt(cwd, 'rev-parse', 'HEAD');
  for (const remote of [base, zero]) {
    const rejected = push(`refs/heads/main ${tip} refs/heads/main ${remote}\n`);
    assert.equal(rejected.status, 1);
    assert.match(rejected.stdout, /credential-token "src\/a.ts"/);
    assert.equal((rejected.stdout + rejected.stderr).includes(token), false);
    assert.equal((rejected.stdout + rejected.stderr).includes('never-logged-secret-url'), false);
  }
  assert.equal(push(`(delete) ${zero} refs/heads/main ${tip}\n`).status, 0);
  assert.equal(push(`refs/heads/main ${tip} refs/heads/main ${'f'.repeat(base.length)}\n`).status, 1);
  assert.equal(push('malformed private input\n').status, 1);
  // Updating an existing remote boundary is safe in a depth-one public base.
  writeFileSync(join(cwd, '.git/shallow'), base + '\n');
  assert.equal(push(`refs/heads/main ${base} refs/heads/main ${base}\n`).status, 0);
  const shallow = push(`refs/heads/main ${base} refs/heads/new ${zero}\n`);
  assert.equal(shallow.status, 1);
  assert.match(shallow.stdout, /shallow-history ""/);
  assert.equal(push(`refs/heads/main ${tip} refs/heads/main ${tip}\nrefs/heads/main ${base} refs/heads/new ${zero}\n`).status, 1);
});

test('hooks reject subsequent baseline binary edits without treating preparation approval as perpetual approval', t => {
  const { put, prepare, gitAt } = fixture(t);
  put('web/public/logo.png', Buffer.from([0, 255]));
  const result = prepare({ allowBinaryChanges: true });
  assert.equal(result.ok, true);
  gitAt(result.output, 'commit', '-qm', 'Synthetic reviewed binary');
  writeFileSync(join(result.output, 'web/public/logo.png'), Buffer.from([0, 254]));
  gitAt(result.output, 'add', '--', 'web/public/logo.png');
  const run = spawnSync(process.execPath, ['.git/liyuan-public-guard/public-git-guard.mjs', 'pre-commit'], { cwd: result.output, encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /binary-change-review-required "web\/public\/logo.png"/);
});

test('pre-push peels annotated and nested tags, scans messages, and rejects noncommit targets', t => {
  const { put, prepare, gitAt } = fixture(t);
  put('src/a.ts');
  const result = prepare();
  assert.equal(result.ok, true);
  const cwd = result.output;
  gitAt(cwd, 'commit', '-qm', 'Synthetic base');
  const base = gitAt(cwd, 'rev-parse', 'HEAD'), zero = '0'.repeat(base.length);
  const push = (local: string, remote = zero) => spawnSync('sh', ['.git/hooks/pre-push'], {
    cwd, input: `refs/tags/synthetic ${local} refs/tags/synthetic ${remote}\n`, encoding: 'utf8',
  });
  gitAt(cwd, '-c', 'tag.gpgsign=false', 'tag', '-a', 'clean', '-m', 'Synthetic release');
  const clean = gitAt(cwd, 'rev-parse', 'clean');
  assert.equal(push(clean).status, 0);
  assert.equal(push(base).status, 0);
  gitAt(cwd, '-c', 'tag.gpgsign=false', 'tag', '-a', 'secret', '-m', token);
  const secret = gitAt(cwd, 'rev-parse', 'secret');
  gitAt(cwd, '-c', 'tag.gpgsign=false', 'tag', '-a', 'nested', 'secret', '-m', 'Synthetic outer');
  for (const local of [secret, gitAt(cwd, 'rev-parse', 'nested')]) {
    const run = push(local, clean);
    assert.equal(run.status, 1);
    assert.match(run.stdout, /credential-token ""/);
    assert.equal((run.stdout + run.stderr).includes(token), false);
  }
  assert.equal(push(clean, 'f'.repeat(base.length)).status, 1);
  assert.equal(push(gitAt(cwd, 'rev-parse', 'HEAD:src/a.ts')).status, 1);
  gitAt(cwd, '-c', 'tag.gpgsign=false', 'tag', '-a', 'json-message', '-m', JSON.stringify({ apiKey: 'synthetic-non-placeholder-value' }));
  const jsonMessage = push(gitAt(cwd, 'rev-parse', 'json-message'), clean);
  assert.equal(jsonMessage.status, 1);
  assert.match(jsonMessage.stdout, /secret-json-field ""/);
  const messageFile = join(cwd, '.git/message');
  writeFileSync(messageFile, Buffer.alloc(16 * 1024 * 1024 + 1, 65));
  gitAt(cwd, '-c', 'tag.gpgsign=false', 'tag', '-a', 'oversize', '-F', messageFile);
  assert.match(push(gitAt(cwd, 'rev-parse', 'oversize')).stdout, /size-limit ""/);
  const invalidTag = join(cwd, '.git/invalid-tag');
  writeFileSync(invalidTag, Buffer.concat([Buffer.from(`object ${base}\ntype commit\ntag invalid\ntagger Synthetic <synthetic@example.invalid> 1 +0000\n\n`), Buffer.from([255])]));
  const invalidOid = gitAt(cwd, 'hash-object', '-t', 'tag', '-w', invalidTag);
  assert.equal(push(invalidOid).status, 1);
  writeFileSync(join(cwd, 'src/a.ts'), token);
  gitAt(cwd, 'add', '--', 'src/a.ts');
  gitAt(cwd, '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'Synthetic unsafe commit');
  gitAt(cwd, '-c', 'tag.gpgsign=false', 'tag', '-a', 'unsafe-tree', '-m', 'Synthetic release');
  const unsafe = push(gitAt(cwd, 'rev-parse', 'unsafe-tree'), clean);
  assert.equal(unsafe.status, 1);
  assert.match(unsafe.stdout, /credential-token "src\/a.ts"/);
});

test('candidate staged hooks reject excluded assets, diagnostics, local records and binary documents', t => {
  const { put, prepare, gitAt } = fixture(t);
  put('src/a.ts');
  const result = prepare();
  assert.equal(result.ok, true, JSON.stringify(result));
  gitAt(result.output, 'commit', '-qm', 'Synthetic clean candidate');
  for (const [path, category] of [
    ['packages/coding-agent/examples/extensions/doom-overlay/doom/build/doom.wasm', 'excluded-third-party-asset'],
    ['scripts/test-flash-sdk-transport.mjs', 'local-diagnostic'],
    ...['PUBLICATION.md', 'docs/VALIDATION-SYNTHETIC.md', 'docs/SYNTHETIC-REPORT.md',
      'docs/SYNTHETIC-AUDIT.md', 'docs/RELEASE-NOTES.md', 'docs/AGENTIC-RESEARCH.docx', 'docs/images/home.png'].map(path => [path, 'local-record']),
  ]) {
    mkdirSync(dirname(join(result.output, path)), { recursive: true });
    writeFileSync(join(result.output, path), path.endsWith('.md') ? token : Buffer.from([0, 255]));
    gitAt(result.output, 'add', '-f', '--', path);
    const run = spawnSync(process.execPath, ['.git/liyuan-public-guard/public-git-guard.mjs', 'pre-commit'], { cwd: result.output, encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.equal(run.stdout.includes(`${category} ${JSON.stringify(path)}`), true, run.stdout);
    assert.equal((run.stdout + run.stderr).includes(token), false);
    gitAt(result.output, 'update-index', '--force-remove', '--', path);
    rmSync(join(result.output, path));
  }
});

test('active filter attributes fail before output, including nested files and macros', t => {
  const { put, prepare } = fixture(t);
  put('src/a.ts');
  for (const attributes of ['*.ts filter=unsafe\n', '[attr]custom filter=unsafe\n*.ts custom\n', '*.ts filter\n']) {
    put('src/.gitattributes', attributes);
    const result = prepare();
    assert.equal(result.ok, false);
    assert.equal(result.output, undefined);
    assert.deepEqual(result.findings, [{ path: 'src/.gitattributes', category: 'unsupported-filter' }]);
  }
  put('src/.gitattributes', '# filter=ignored\n*.ts text eol=lf -filter\n');
  assert.equal(prepare().ok, true);
});

test('candidate pins hooks and attributes against inherited global configuration; scanner never executes fsmonitor', t => {
  if (process.platform === 'win32') return t.skip('POSIX sentinel executable');
  const { dir, source, put, git, prepare } = fixture(t);
  put('src/a.ts'); git('add', '--', 'src/a.ts');
  const monitor = join(dir, 'monitor'), sentinel = join(dir, 'executed');
  writeFileSync(monitor, `#!/bin/sh\ntouch '${sentinel}'\nexit 0\n`, { mode: 0o700 });
  git('config', 'core.fsmonitor', monitor);
  const config = readFileSync(join(source, '.git/config'));
  assert.equal(auditRepository({ cwd: source }).ok, true);
  assert.equal(auditRepository({ cwd: source, args: ['--staged'] }).ok, true);
  assert.equal(existsSync(sentinel), false);
  const result = prepare();
  assert.equal(result.ok, true);
  assert.deepEqual(readFileSync(join(source, '.git/config')), config);
  assert.equal(existsSync(sentinel), false);
  const global = join(dir, 'global-config');
  writeFileSync(global, `[core]\n hooksPath = ${dir}/missing-hooks\n fsmonitor = ${monitor}\n attributesFile = ${dir}/global-attributes\n`);
  writeFileSync(join(dir, 'global-attributes'), '*.ts filter=unsafe\n');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1' };
  const run = (...args: string[]) => spawnSync('git', args, { cwd: result.output, env, encoding: 'utf8' });
  for (const [key, value] of [['core.hooksPath', '.git/hooks'], ['core.fsmonitor', 'false'], ['core.attributesFile', '/dev/null']]) assert.equal(run('config', '--get', key).stdout.trim(), value);
  const good = run('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'Synthetic inherited config');
  assert.equal(good.status, 0, good.stdout + good.stderr);
  assert.equal(existsSync(sentinel), false);
  writeFileSync(join(result.output, 'src/a.ts'), token);
  assert.equal(run('add', '--', 'src/a.ts').status, 0);
  const bad = run('-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid', 'commit', '-qm', 'Synthetic blocked');
  assert.equal(bad.status, 1);
  assert.match(bad.stdout + bad.stderr, /credential-token/);
  assert.equal((bad.stdout + bad.stderr).includes(token), false);
});

test('validated exact-root ownership exception works without any global safe.directory', t => {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) return t.skip('Requires Linux root for synthetic ownership fixture');
  const { source, put, prepare } = fixture(t);
  put('src/a.ts');
  assert.equal(spawnSync('chown', ['995:991', source]).status, 0);
  const probe = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: source, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' }, encoding: 'utf8' });
  assert.notEqual(probe.status, 0);
  assert.match(probe.stderr, /dubious ownership/);
  assert.equal(prepare().ok, true);
  assert.equal(auditRepository({ cwd: source }).ok, true);
});
