import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkDocumentation } from '../scripts/check-docs.mjs';

function fixture(t: TestContext) {
  const parent = realpathSync(process.platform === 'linux' && existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir());
  const root = mkdtempSync(join(parent, 'documentation-links-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path: string, text = '') => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  for (const entry of ['README.md', 'TESTING.md', 'AGENTS.md', 'CLAUDE.md', 'docs/DOCUMENTATION-INDEX.md']) put(entry);
  return { root, put, check: () => checkDocumentation({ root }) };
}

test('entry closure follows current local Markdown once without Git or directory crawling', t => {
  const { put, check } = fixture(t);
  put('README.md', '[Guide](docs/GENERATION-MODES.md)');
  put('TESTING.md', '[Tests](deploy/README.md)');
  put('AGENTS.md', '[Agents](skills/主作者正文边界/SKILL.md)');
  put('CLAUDE.md', '[Claude](deploy/VPS-OPERATIONS.md)');
  put('docs/DOCUMENTATION-INDEX.md', '[Index](ARCHITECTURE-OVERVIEW.md)');
  put('docs/ARCHITECTURE-OVERVIEW.md', '[Guide](GENERATION-MODES.md)');
  put('docs/GENERATION-MODES.md', '[Cycle](../README.md) [Missing](MODEL-CONNECTIONS.md)');
  for (const path of ['deploy/README.md', 'skills/主作者正文边界/SKILL.md', 'deploy/VPS-OPERATIONS.md']) put(path);
  put('docs/unreachable.md', '[Not current](absent.md)');
  const result = check();
  assert.equal(result.ok, false);
  assert.equal(result.files.length, 10);
  assert.equal(new Set(result.files).size, result.files.length);
  assert.deepEqual(result.findings, [{ source: 'docs/GENERATION-MODES.md', target: 'docs/MODEL-CONNECTIONS.md', category: 'missing-target' }]);
});

test('spaces, percent decoding, relative parents, assets, titles and reference definitions', t => {
  const { put, check } = fixture(t);
  put('README.md', '[Space](deploy/space name.svg) [Encoded](deploy/space%20name.svg#not-a-heading) [Angle](<deploy/space name.svg>) [Title](docs/GENERATION-MODES.md "guide")\n[ref]: <docs/GENERATION-MODES.md> "title"');
  put('deploy/space name.svg', '<svg/>');
  put('docs/GENERATION-MODES.md', '[Home](../README.md?view=1#absent) [Asset](../deploy/image.svg)');
  put('deploy/image.svg', '<svg/>');
  const result = check();
  assert.equal(result.ok, true);
  assert.equal(result.checkedLinks, 7);
  assert.equal(result.files.includes('docs/GENERATION-MODES.md'), true);
});

test('code fences, inline samples, URLs and anchors are ignored; no heading validation', t => {
  const { put, check } = fixture(t);
  put('README.md', [
    '```md', '[Example](absent.md)', '````',
    '~~~markdown', '[Example](also-absent.md)', '~~~',
    '`[Example](inline.md)` and ``[Example](inline-two.md)``',
    '[Web](https://example.invalid/no.md) [Mail](mailto:synthetic@example.invalid)',
    '[Network](//example.invalid/no.md) [Anchor](#unknown)',
    '<a id="html-anchor"></a> [HTML anchor](#html-anchor)',
    '[Missing heading](TESTING.md#unknown)',
  ].join('\n'));
  const result = check();
  assert.equal(result.ok, true);
  assert.equal(result.checkedLinks, 1);
});

test('local records are rejected while upstream packages are existence checked only', t => {
  const { put, check } = fixture(t);
  const paths = ['docs/VALIDATION-OLD.md', 'docs/IMPLEMENTATION-REPORT.md', 'docs/INDEPENDENT-AUDIT.md', 'docs/RELEASE-NOTES.md', 'docs/LIVE-VALIDATION-OLD.md', 'packages/coding-agent/docs/sdk.md', 'packages/ai/README.md'];
  put('README.md', paths.map(path => `[Evidence](${path})`).join('\n') + '\n[Missing evidence](docs/VALIDATION-MISSING.md) [Missing upstream](packages/agent/docs/hooks.md)');
  for (const path of paths) put(path, '[Historical missing link](gone.md)');
  const result = check();
  assert.equal(result.files.length, 5);
  assert.deepEqual(result.findings.map(f => f.target), [...paths.slice(0, 5), 'docs/VALIDATION-MISSING.md', 'packages/agent/docs/hooks.md']);
  assert.deepEqual(result.findings.map(f => f.category), [...Array(6).fill('local-record'), 'missing-target']);
});

test('policy rejects Markdown content inputs before reading even historical or upstream paths', t => {
  const { root, put, check } = fixture(t);
  const paths = ['.liyuan/secret.md', 'docs/.local/secret.md', 'packages/sdk/data/secret.md', 'docs/.backup/VALIDATION-OLD.md', 'unapproved/guide.md'];
  put('README.md', paths.map(path => `[Synthetic private input](${path})`).join('\n'));
  // Directories instead of readable files prove the policy runs before content IO.
  for (const path of paths) mkdirSync(join(root, path), { recursive: true });
  const result = check();
  assert.deepEqual(result.findings.map(f => f.category), ['private-path', 'local-record', 'private-path', 'local-record', 'local-record']);
  assert.equal(result.files.length, 5);
});

test('unknown docs, nested guides and binary records fail before filesystem reads', t => {
  const { root, put, check } = fixture(t);
  const paths = ['docs/new.md', 'docs/nested/GENERATION-MODES.md', 'docs/AGENTIC-RESEARCH.docx', 'docs/images/home.png', 'docs/screenshots/mobile.png'];
  put('README.md', paths.map(path => `[Local record](${path})`).join('\n'));
  for (const path of paths) mkdirSync(join(root, path), { recursive: true });
  const result = check();
  assert.deepEqual(result.findings, paths.map(target => ({ source: 'README.md', target, category: 'local-record' })));
  assert.equal(result.files.length, 5);
});

test('outside traversal, encoded traversal, absolute paths and malformed encodings fail closed', t => {
  const { put, check } = fixture(t);
  put('README.md', '[Escape](../outside.md) [Encoded](%2e%2e/outside.md) [Absolute](/outside.md) [Drive](%43%3a/outside.md) [Backslash](docs%5cguide.md) [NUL](docs/%00.md) [Invalid](docs/%zz.md)');
  const result = check();
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map(f => f.category), [...Array(6).fill('outside-repository'), 'invalid-url-encoding']);
});

test('symlink parents and leaves are rejected even for evidence and non-Markdown targets', t => {
  const { root, put, check } = fixture(t);
  put('deploy/real/guide.md', '[Must not read](absent.md)');
  try {
    symlinkSync(join(root, 'deploy/real'), join(root, 'deploy/linked'), process.platform === 'win32' ? 'junction' : 'dir');
    symlinkSync(join(root, 'deploy/real/guide.md'), join(root, 'docs/GENERATION-MODES.md'), 'file');
  } catch (error: any) {
    if (['ENOSYS', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM'].includes(error.code)) return t.skip(`Symlinks unavailable: ${error.code}`);
    throw error;
  }
  put('README.md', '[Parent](deploy/linked/guide.md) [Leaf](docs/GENERATION-MODES.md) [Asset](deploy/linked/image.svg) [Upstream](deploy/linked/VALIDATION-OLD.md)');
  const result = check();
  assert.deepEqual(result.findings.map(f => f.category), ['local-record', 'symlink-path', 'symlink-path', 'local-record']);
  assert.equal(result.files.length, 5);
});

test('missing entries and nonregular Markdown fail; CLI reports existence-only scope and status', t => {
  const { root, put, check } = fixture(t);
  rmSync(join(root, 'AGENTS.md'));
  mkdirSync(join(root, 'docs/GENERATION-MODES.md'));
  put('README.md', '[Directory](docs/GENERATION-MODES.md)');
  assert.deepEqual(check().findings.map(f => f.category), ['missing-target', 'nonregular-markdown']);
  const cli = resolve('scripts/check-docs.mjs');
  const run = spawnSync(process.execPath, [cli, '--root', root], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /Existence only; headings\/HTML anchors are not checked/);
  assert.equal(run.stderr, '');
  put('AGENTS.md');
  put('README.md');
  assert.equal(spawnSync(process.execPath, [cli, '--root', root]).status, 0);
  assert.equal(spawnSync(process.execPath, [cli, '--unknown']).status, 1);
});
