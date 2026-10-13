import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { auditPrivacyCI } from '../scripts/check-privacy-ci.mjs';
import { generateFixture, FIXTURE_NAMES } from '../packages/coding-agent/test/fixtures/generate-synthetic-fixtures.ts';

test('trusted CI scans head and every commit without executing candidate checker or generator', t => {
  const dir = mkdtempSync(join(tmpdir(), 'privacy-ci-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: {
      ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid',
      GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid',
    } });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const put = (path: string, value: string) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), value);
  };
  const commit = () => {
    git('add', '--', 'src', 'scripts', 'packages');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic CI fixture');
    return git('rev-parse', 'HEAD');
  };
  git('init', '-q');
  const sentinel = join(dir, 'executed');
  const malicious = `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'bad'); process.exit(0);`;
  for (const path of ['scripts/check-repository-privacy.mjs', 'scripts/public-repository-policy.mjs',
    'scripts/check-publication-range.mjs', 'scripts/check-public-data.mjs',
    'scripts/check-privacy-ci.mjs', 'packages/coding-agent/test/fixtures/generate-synthetic-fixtures.ts']) put(path, malicious);
  for (const name of FIXTURE_NAMES) put(`packages/coding-agent/test/fixtures/${name}`, generateFixture(name));
  put('src/a.ts', 'public');
  const base = commit();
  const run = (name: string, event: unknown) => {
    const eventPath = join(dir, 'event.json');
    writeFileSync(eventPath, JSON.stringify(event));
    const lines: string[] = [];
    const result = auditPrivacyCI({ cwd: dir, eventName: name, eventPath, report: line => lines.push(line) });
    assert.equal(existsSync(sentinel), false);
    return { ...result, lines };
  };
  assert.equal(run('pull_request_target', { pull_request: { base: { sha: base }, head: { sha: base } } }).ok, true);
  const token = ['ghp_', 'A'.repeat(36)].join('');
  put('src/a.ts', token);
  commit();
  put('src/a.ts', 'public repaired');
  const head = commit();
  const result = run('pull_request_target', { pull_request: { base: { sha: base }, head: { sha: head } } });
  assert.equal(result.ok, false);
  assert.equal(result.findings.includes('commit-range-failed'), true);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal(run('push', { before: '0'.repeat(40), after: head }).findings[0], 'trusted-baseline-required');
  put('packages/coding-agent/test/fixtures/large-session.jsonl', '{"synthetic":true}\n');
  const bad = commit();
  assert.equal(run('push', { before: head, after: bad }).findings.includes('synthetic-fixture-failed'), true);
  assert.equal(run('push', { before: 'f'.repeat(40), after: head }).ok, false);
});

test('privacy workflow runs only base tools with read-only target permissions and no candidate install', () => {
  const workflow = readFileSync(resolve('.github/workflows/privacy.yml'), 'utf8');
  assert.match(workflow, /pull_request_target:/);
  assert.match(workflow, /contents: read/);
  assert.equal((workflow.match(/persist-credentials: false/g) ?? []).length, 2);
  assert.match(workflow, /github\.event\.pull_request\.base\.sha \|\| github\.event\.before/);
  assert.match(workflow, /working-directory: candidate\s+run: node \.\.\/trusted\/scripts\/check-privacy-ci\.mjs/);
  assert.match(workflow, /working-directory: candidate\s+run: node \.\.\/trusted\/scripts\/check-docs\.mjs --root \./);
  assert.doesNotMatch(workflow, /npm |secrets\.|write|run:.*(?:candidate\/scripts|generate-synthetic)/);
});
