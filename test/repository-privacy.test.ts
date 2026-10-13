import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, renameSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { auditRepository } from '../scripts/check-repository-privacy.mjs';
import { approvedDocumentation, approvedBinary, isLocalRecord, contentCategories, pathCategory, MAX_FILE_BYTES } from '../scripts/public-repository-policy.mjs';

const cli = resolve('scripts/check-repository-privacy.mjs');
const token = ['ghp_', 'A'.repeat(36)].join('');
const legacyPrivateNames = ['rp.config.json', 'rp.config.local.json', 'rp.config-private.json', 'rp-preset.json', 'rp.agent.json', 'rp.agent.meta.json', 'liyuan-profiles'];
function fixture(t: any) {
  const parent = process.platform === 'linux' && existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir();
  const dir = mkdtempSync(join(parent, 'repository-privacy-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: {
      ...process.env, GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid',
      GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid',
    } });
    assert.equal(result.status, 0);
    return result.stdout.trim();
  };
  git('init', '-q');
  const put = (path: string, value: string | Buffer = 'public') => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), value);
  };
  const audit = (...args: string[]) => auditRepository({ cwd: dir, args });
  return { dir, git, put, audit };
}

test('candidate union includes tracked ignored files and nonignored new files', t => {
  const { put, git, audit } = fixture(t);
  put('.gitignore', 'src/ignored.ts\n.local/\n');
  put('src/ignored.ts', token);
  git('add', '-f', '--', 'src/ignored.ts');
  put('src/new.ts', token);
  put('.local/private.json', token);
  assert.deepEqual(audit().findings.map(f => f.path).sort(), ['src/ignored.ts', 'src/new.ts']);
});

test('staged scans the whole index actual bytes, not the repaired worktree', t => {
  const { put, git, audit } = fixture(t);
  put('src/a.ts', token); git('add', '--', 'src/a.ts'); git('commit', '-qm', 'Synthetic fixture');
  put('src/a.ts', 'public');
  assert.equal(audit().ok, true);
  assert.equal(audit('--staged').findings[0].category, 'credential-token');
  git('add', '--', 'src/a.ts'); put('src/a.ts', token);
  assert.equal(audit('--staged').ok, true);
  assert.equal(audit().ok, false);
});

test('commit scans full snapshot blobs independently of index and disk', t => {
  const { put, git, audit } = fixture(t);
  put('src/a.ts', token); git('add', '.'); git('commit', '-qm', 'Synthetic secret fixture');
  const old = git('rev-parse', 'HEAD');
  put('src/a.ts', 'public'); git('add', '.'); git('commit', '-qm', 'Synthetic repaired fixture');
  assert.equal(audit('--commit', old).ok, false);
  assert.equal(audit('--commit', 'HEAD').ok, true);
  assert.equal(audit('--commit', '--bad-option').ok, false);
});

test('forbidden force-added paths are rejected without opening file or blob', t => {
  const { dir, put, git, audit } = fixture(t);
  put('.liyuan-cache/private.json', token); git('add', '-f', '.');
  // Remove the object: a forbidden entry must never be sent to cat-file.
  const oid = git('rev-parse', ':.liyuan-cache/private.json');
  rmSync(join(dir, '.git/objects', oid.slice(0, 2), oid.slice(2)));
  rmSync(join(dir, '.liyuan-cache/private.json'));
  mkdirSync(join(dir, '.liyuan-cache/private.json'));
  for (const args of [[], ['--staged']]) {
    assert.deepEqual(audit(...args).findings, [{ path: '.liyuan-cache/private.json', category: 'private-path' }]);
  }
});

test('legacy private segments are rejected before file or blob reads', t => {
  const { dir, put, git, audit } = fixture(t);
  const paths = legacyPrivateNames.flatMap(name => [name, `src/${name}`, `packages/nested/${name}/child.ts`]);
  for (const path of paths) put(path, token);
  git('add', '-f', '.');
  const oid = git('rev-parse', `:${paths[0]}`);
  rmSync(join(dir, '.git/objects', oid.slice(0, 2), oid.slice(2)));
  for (const path of paths) {
    rmSync(join(dir, path));
    mkdirSync(join(dir, path));
  }
  const expected = paths.map(path => ({ path, category: 'private-path' })).sort((a, b) => a.path.localeCompare(b.path));
  for (const args of [[], ['--staged']]) {
    const result = audit(...args);
    assert.deepEqual(result.findings.sort((a, b) => a.path.localeCompare(b.path)), expected);
    assert.equal(result.scanned, 0);
  }
});

test('parent symlinks are never read in worktree (Windows directory junction)', t => {
  const { dir, put, git, audit } = fixture(t);
  put('src/nested/a.ts', 'public'); git('add', '.');
  renameSync(join(dir, 'src/nested'), join(dir, 'outside'));
  try {
    symlinkSync(join(dir, 'outside'), join(dir, 'src/nested'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error: any) {
    if (['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)) return t.skip(`Directory links unsupported: ${error.code}`);
    throw error;
  }
  assert.equal(audit().findings.some(f => f.category === 'unsafe-parent'), true);
  assert.equal(audit('--staged').ok, true);
});

test('leaf symlinks are never read in worktree or index', t => {
  const { dir, put, git, audit } = fixture(t);
  put('src/a.ts', 'public'); git('add', '.');
  try {
    symlinkSync(join(dir, 'src/a.ts'), join(dir, 'src/link.ts'), 'file');
  } catch (error: any) {
    if (['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP'].includes(error.code)
      || (process.platform === 'win32' && error.code === 'EPERM')) {
      return t.skip(`File symlinks unsupported or Windows symlink privilege unavailable: ${error.code}`);
    }
    throw error;
  }
  assert.equal(audit().findings.some(f => f.category === 'nonregular-file'), true);
  git('config', 'core.symlinks', 'true');
  git('add', '--', 'src/link.ts');
  assert.equal(audit('--staged').findings.some(f => f.category === 'nonregular-file'), true);
});

test('submodule modes are rejected before blob reads', t => {
  const { put, git, audit } = fixture(t);
  put('src/a.ts'); git('add', '.'); git('commit', '-qm', 'Synthetic fixture');
  const oid = git('rev-parse', 'HEAD');
  git('update-index', '--add', '--cacheinfo', `160000,${oid},src/submodule`);
  assert.equal(audit('--staged').findings[0].category, 'nonregular-file');
});

test('NUL manifests preserve tabs, newlines and quotes; output is redacted', t => {
  if (process.platform === 'win32') {
    const reason = 'Windows filenames cannot contain LF, tabs or double quotes; this POSIX filename fixture is not representable.';
    assert.match(reason, /Windows filenames cannot contain LF, tabs or double quotes/);
    return t.skip(reason);
  }
  const { dir, put, git, audit } = fixture(t);
  const path = 'src/odd\n\t"name.ts';
  put(path, token); git('add', '.');
  assert.equal(audit('--staged').findings[0].path, path);
  const result = spawnSync(process.execPath, [cli, '--staged'], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.equal(result.stdout.includes(token), false);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.includes(JSON.stringify(path)), true);
  assert.equal(result.stdout.split('\n').filter(Boolean).length, 2);
});

test('git and CLI failures fail closed without error fragments', t => {
  const { dir, audit } = fixture(t);
  assert.equal(audit('--unknown').ok, false);
  const lines: string[] = [];
  const result = auditRepository({ cwd: join(dir, 'missing-secret-name'), report: line => lines.push(line) });
  assert.equal(result.ok, false);
  assert.deepEqual(lines, ['git-failure ""']);
  assert.deepEqual(audit('--commit', 'nonexistent-sensitive-ref').findings, [{ path: '', category: 'git-failure' }]);
});

test('missing public blobs fail closed', t => {
  const { dir, put, git, audit } = fixture(t);
  put('src/a.ts'); git('add', '.');
  const oid = git('rev-parse', ':src/a.ts');
  rmSync(join(dir, '.git/objects', oid.slice(0, 2), oid.slice(2)));
  assert.equal(audit('--staged').findings[0].category, 'blob-failure');
});

test('unmerged index fails closed', t => {
  const { dir, put, git, audit } = fixture(t);
  put('src/a.ts'); git('add', '.');
  const oid = git('rev-parse', ':src/a.ts');
  git('update-index', '--force-remove', 'src/a.ts');
  const result = spawnSync('git', ['update-index', '--index-info'], {
    cwd: dir, input: `100644 ${oid} 1\tsrc/a.ts\n100644 ${oid} 2\tsrc/a.ts\n`,
  });
  assert.equal(result.status, 0);
  assert.equal(audit('--staged').findings.every(f => f.category === 'unmerged-index'), true);
  assert.equal(audit('--staged').ok, false);
});

test('size limit fails rather than silently skipping oversized contents', t => {
  const { put, git, audit } = fixture(t);
  put('src/large.ts', Buffer.alloc(MAX_FILE_BYTES + 1, 65)); git('add', '.');
  assert.equal(audit().findings[0].category, 'size-limit');
  assert.equal(audit('--staged').findings[0].category, 'size-limit');
});

test('binary baseline is narrow and new binary paths require review', t => {
  const { put, git, audit } = fixture(t);
  put('web/public/logo.png', Buffer.from([0, 255]));
  assert.equal(audit().findings[0].category, 'binary-review-required');
  git('add', '.'); assert.equal(audit().ok, true);
  put('src/new.png', Buffer.from([0, 255])); git('add', '.');
  assert.equal(audit('--staged').findings[0].category, 'binary-review-required');
});

test('excluded upstream binary and host diagnostic reject before file or snapshot blob reads', t => {
  const { dir, put, git, audit } = fixture(t);
  const entries = [
    { path: 'packages/coding-agent/examples/extensions/doom-overlay/doom/build/doom.wasm', category: 'excluded-third-party-asset' },
    { path: 'scripts/analyze-session.mjs', category: 'local-diagnostic' },
    ...['choice', 'codex-mount', 'codex', 'f3', 'gate', 'panel', 'skill', 'upload'].map(name => ({
      path: `scripts/drive-${name}-test.mjs`, category: 'local-diagnostic',
    })),
    { path: 'scripts/test-flash-sdk-transport.mjs', category: 'local-diagnostic' },
  ];
  const ignore = readFileSync(resolve('.gitignore'), 'utf8');
  for (const { path, category } of entries) {
    assert.equal(ignore.split('\n').includes(path.startsWith('scripts/drive-') ? '/scripts/drive-*.mjs' : `/${path}`), true);
    for (const tracked of [false, true]) {
      assert.equal(pathCategory(path, tracked), category);
      assert.equal(approvedBinary(path, tracked), false);
    }
    put(path, token);
  }
  assert.equal(pathCategory('packages/coding-agent/examples/extensions/doom-overlay/doom/build/other.wasm', true), null);
  assert.equal(pathCategory('packages/sdk/PUBLICATION.md', true), 'local-record');
  assert.equal(isLocalRecord('packages/sdk/PUBLICATION.md'), true);
  git('add', '-f', '--', ...entries.map(e => e.path));
  git('commit', '-qm', 'Synthetic excluded publication paths');
  const oid = git('rev-parse', `:${entries[0].path}`);
  rmSync(join(dir, '.git/objects', oid.slice(0, 2), oid.slice(2)));
  for (const { path } of entries) {
    rmSync(join(dir, path));
    mkdirSync(join(dir, path));
  }
  for (const args of [[], ['--staged'], ['--commit', 'HEAD']]) {
    const result = audit(...args);
    assert.equal(result.ok, false);
    assert.deepEqual(result.findings, entries);
    assert.equal(result.scanned, 0);
  }
});

test('license approval is exact, available, mirrored in ignore rules and content-scanned', t => {
  const paths = ['licenses/Luker-AGPL-3.0.txt', 'licenses/README.md'];
  const ignore = readFileSync(resolve('.gitignore'), 'utf8');
  assert.match(ignore, /^\/licenses\/\*$/m);
  assert.deepEqual([...ignore.matchAll(/^!\/(licenses\/.+)$/gm)].map(m => m[1]).sort(), [...paths].sort());
  const license = readFileSync(resolve(paths[0]));
  // SHA-256 independently checked against GNU's official agpl-3.0.txt.
  assert.equal(createHash('sha256').update(license).digest('hex'), '0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0');
  const doc = readFileSync(resolve('docs/PROMPT-SOURCES.md'), 'utf8');
  assert.equal(doc.includes('prompt-attribution/Luker-AGPL-3.0.txt'), false);
  for (const path of paths) {
    assert.match(doc, new RegExp(path.replace(/[.]/g, '\\.')));
    assert.ok(readFileSync(resolve(path)).length > 0);
    for (const tracked of [false, true]) {
      assert.equal(pathCategory(path, tracked), null);
      assert.deepEqual(contentCategories(Buffer.from(token), path, tracked), ['credential-token']);
    }
  }
  for (const path of ['licenses/other.txt', 'licenses/nested/README.md', 'licenses/Luker-AGPL-3.0.txt/child', 'licenses/README.md.extra']) {
    for (const tracked of [false, true]) assert.equal(pathCategory(path, tracked), 'unapproved-license', path);
  }
  const { put, git, audit } = fixture(t);
  for (const path of paths) put(path, readFileSync(resolve(path)));
  assert.equal(audit().ok, true);
  git('add', '--', ...paths);
  assert.equal(audit('--staged').ok, true);
  for (const path of paths) put(path, token);
  assert.deepEqual(audit().findings.map(f => f.category), ['credential-token', 'credential-token']);
  git('add', '--', ...paths);
  assert.deepEqual(audit('--staged').findings.map(f => f.category), ['credential-token', 'credential-token']);
});

test('path allowlist rejects private segments, new assets, presets and diagnostics', () => {
  for (const name of legacyPrivateNames) {
    for (const path of [name, `src/${name}`, `packages/nested/${name}/child.ts`]) {
      for (const tracked of [false, true]) assert.equal(pathCategory(path, tracked), 'private-path', path);
    }
  }
  for (const path of ['src/.rp-state/a', 'web/.pi/a', 'docs/.local/a', 'src/data/a', 'src/node_modules/a', 'web/screenshots/a', 'src/a.json.tmp-123', 'src/a.bak', 'test/.env.example', '.liyuan/settings.json', 'liyuan.agent.json', 'assets/cards/private.json', 'presets/new.json', 'scripts/probe-private.mjs', 'scripts/local-audit.mjs']) {
    assert.notEqual(pathCategory(path, true), null, path);
  }
  for (const path of ['README.md', 'AGENTS.md', 'CLAUDE.md', 'TESTING.md', 'LICENSE', 'src/a.ts', 'server/main.ts', 'docs/GENERATION-MODES.md', 'packages/coding-agent/docs/sdk.md', '.liyuan/extensions/roleplay.ts', 'assets/cards/default_Qingwu.json', 'presets/\u9ed8\u8ba4.json']) assert.equal(pathCategory(path, true), null, path);
  assert.notEqual(pathCategory('scripts/probe-backstage.mjs', false), null);
  assert.equal(pathCategory('scripts/probe-backstage.mjs', true), null);
});

test('docs approval is exact, mirrored in ignore rules, and has no binary baseline', () => {
  assert.equal(approvedDocumentation.size, 37);
  const ignore = readFileSync(resolve('.gitignore'), 'utf8');
  const names = [...ignore.matchAll(/^!\/docs\/(.+)$/gm)].map(m => m[1]);
  assert.deepEqual(names.sort(), [...approvedDocumentation].sort());
  assert.match(ignore, /^\/docs\/\*$/m);
  for (const name of approvedDocumentation) {
    assert.equal(isLocalRecord(`docs/${name}`), false);
    assert.equal(pathCategory(`docs/${name}`), null);
    assert.equal(isLocalRecord(`docs/nested/${name}`), true);
  }
  for (const path of ['docs/new.md', 'docs/VALIDATION-NEW.md', 'docs/IMPLEMENTATION-REPORT.md', 'docs/INDEPENDENT-AUDIT.md', 'docs/CODEX-HANDOFF.md', 'docs/RELEASE-v1.7.4.md', 'docs/RELEASE-NOTES.md', 'docs/DATABASE-DETACHMENT-BLOCKERS.md', 'docs/KNOWLEDGE-RESEARCH-VALIDATION.md', 'docs/AGENTIC-RESEARCH-SEARCH-PROTOCOL.md', 'docs/PLAN-KNOWLEDGE-ENGINE.md', 'docs/AGENTIC-RESEARCH.docx', 'docs/images/home.png', 'docs/research-live-20261012/desktop.png', 'docs/screenshots/mobile.png']) {
    assert.equal(isLocalRecord(path), true, path);
    for (const tracked of [false, true]) {
      assert.equal(pathCategory(path, tracked), 'local-record', path);
      assert.equal(approvedBinary(path, tracked), false, path);
    }
  }
});

test('source worktree skips only local records; staged and commit reject without blob reads', t => {
  const { dir, put, git, audit } = fixture(t);
  const paths = ['PUBLICATION.md', 'docs/new.md', 'docs/VALIDATION-OLD.md', 'docs/images/home.png'];
  for (const path of paths) put(path, token);
  git('add', '-f', '--', ...paths);
  git('commit', '-qm', 'Synthetic local records');
  const oid = git('rev-parse', `:${paths[0]}`);
  rmSync(join(dir, '.git/objects', oid.slice(0, 2), oid.slice(2)));
  for (const path of paths) {
    rmSync(join(dir, path));
    mkdirSync(join(dir, path));
  }
  put('docs/NEW-REPORT.md', token);
  assert.equal(audit().ok, true);
  assert.equal(audit().scanned, 0);
  const expected = [...paths].sort().map(path => ({ path, category: 'local-record' }));
  for (const args of [['--staged'], ['--commit', 'HEAD']]) {
    const result = audit(...args);
    assert.deepEqual(result.findings.sort((a, b) => a.path.localeCompare(b.path, 'en')), expected.sort((a, b) => a.path.localeCompare(b.path, 'en')));
    assert.equal(result.scanned, 0);
  }
  put('src/new.ts', token);
  put('.liyuan-cache/private.json', token);
  assert.deepEqual(audit().findings.map(f => f.category).sort(), ['credential-token', 'private-path']);
});

test('public SDK image fixture exception is exact and tracked only', t => {
  const path = 'packages/ai/test/data/red-circle.png';
  const bytes = Buffer.from([0, 255]);
  assert.equal(pathCategory(path, true), null);
  assert.equal(pathCategory(path, false), 'private-path');
  assert.deepEqual(contentCategories(bytes, path, true), []);
  assert.deepEqual(contentCategories(bytes, path, false), ['binary-review-required']);
  for (const other of ['data/red-circle.png', 'packages/ai/test/data/other.png', 'packages/ai/test/data/red-circle.png/child.ts', 'packages/ai/test/data/nested/red-circle.png', 'src/packages/ai/test/data/red-circle.png']) {
    assert.equal(pathCategory(other, true), 'private-path', other);
    assert.deepEqual(contentCategories(bytes, other, true), ['binary-review-required'], other);
  }
  const { put, git, audit } = fixture(t);
  put(path, bytes);
  assert.deepEqual(audit().findings, [{ path, category: 'private-path' }]);
  git('add', '-f', '--', path);
  assert.equal(audit().ok, true);
  assert.equal(audit('--staged').ok, true);
});

test('high-confidence content rules scan entire text and exact placeholders only', () => {
  const scan = (text: string, path = 'src/new.ts') => contentCategories(Buffer.from(text), path, true);
  assert.deepEqual(scan('safe\n'.repeat(10000) + token), ['credential-token']);
  assert.deepEqual(scan(['-----BEGIN ', 'RSA PRIVATE KEY-----'].join('')), ['private-key']);
  assert.deepEqual(scan(JSON.stringify({ nested: { apiKey: 'not-a-placeholder' } })), ['secret-json-field']);
  assert.deepEqual(scan(JSON.stringify({ apiKey: 'YOUR_API_KEY_HERE' })), []);
  assert.deepEqual(scan(JSON.stringify({ apiKey: '<real-secret-value>' })), ['secret-json-field']);
  assert.deepEqual(scan('/* synthetic fixture */ ' + token), ['credential-token']);
  assert.deepEqual(scan('https://' + 'user:real-password@example.invalid'), ['credential-url']);
  assert.deepEqual(scan('ssh://git@github.com/user/repo'), []);
  const old = ['sk-proj-', '1234567890ABCDEF'].join('');
  assert.deepEqual(scan(old, 'test/web-research.test.ts'), []);
  assert.deepEqual(scan(old + 'X', 'test/web-research.test.ts'), ['credential-token']);
  assert.deepEqual(scan(old, 'test/new.test.ts'), ['credential-token']);
});

test('Markdown and session records cannot use public source directories as approval', t => {
  const { dir, put, git, audit } = fixture(t);
  const paths = ['src/story.md', 'server/AUDIT.md', 'web/notes.MD', 'deploy/RELEASE.md',
    'scripts/report.mdx', '.github/handoff.markdown', 'packages/coding-agent/docs/new.md',
    'skills/private/SKILL.md', 'skills/主作者正文边界/nested/SKILL.md',
    'test/story.jsonl', 'src/story.txt', 'web/story.pdf', 'packages/coding-agent/test/fixtures/new-session.jsonl'];
  for (const path of paths) {
    assert.equal(pathCategory(path, true), 'local-record', path);
    put(path, token);
  }
  git('add', '--', ...paths);
  git('commit', '-qm', 'Synthetic records');
  const oid = git('rev-parse', `HEAD:${paths[0]}`);
  rmSync(join(dir, '.git/objects', oid.slice(0, 2), oid.slice(2)));
  for (const path of paths) { rmSync(join(dir, path)); mkdirSync(join(dir, path)); }
  assert.equal(audit().scanned, 0);
  for (const args of [['--staged'], ['--commit', 'HEAD']]) {
    const result = audit(...args);
    assert.equal(result.scanned, 0);
    assert.equal(result.findings.length, paths.length);
    assert.equal(result.findings.every(f => f.category === 'local-record'), true);
  }
  for (const path of ['skills/主作者正文边界/SKILL.md', 'packages/coding-agent/examples/extensions/subagent/agents/scout.md',
    'packages/coding-agent/test/fixtures/skills/nested/child-skill/SKILL.md',
    'packages/coding-agent/test/fixtures/large-session.jsonl']) assert.equal(pathCategory(path, true), null, path);
  assert.equal(pathCategory('skills/主作者正文边界/story.json', true), 'unapproved-skill');
});


test('CI checker is included by source ignore policy and only exact installer URL fixtures are public', () => {
  const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
  const ignored = spawnSync('git', ['-c', `safe.directory=${root}`, 'check-ignore', '--no-index', 'scripts/check-privacy-ci.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(ignored.status, 1, 'trusted CI runner must not disappear from clean checkout/export');
  assert.equal(pathCategory('scripts/check-privacy-ci.mjs', true), null);
  const credentialUrl = ['https://synthetic-user', 'synthetic-secret@example.invalid/other.git'].join(':');
  assert.deepEqual(contentCategories(Buffer.from(credentialUrl), 'test/deploy-install-safety.test.ts', true), []);
  assert.deepEqual(contentCategories(Buffer.from(credentialUrl), 'src/not-a-fixture.ts', true), ['credential-url']);
  assert.deepEqual(contentCategories(Buffer.from(credentialUrl.replace('example.invalid', 'unexpected.invalid')), 'test/deploy-install-safety.test.ts', true), ['credential-url']);
});
