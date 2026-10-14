import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { auditRepository } from '../scripts/check-repository-privacy.mjs';
import { auditPublicationRange } from '../scripts/check-publication-range.mjs';
// Keep the dedicated CI trust-boundary regressions in the existing privacy suite.
import './privacy-ci.test.ts';

const cli = resolve('scripts/check-publication-range.mjs');
const zero = '0'.repeat(40);
const token = ['ghp_', 'A'.repeat(36)].join('');

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'publication-range-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: {
      ...process.env, GIT_AUTHOR_NAME: 'Synthetic', GIT_AUTHOR_EMAIL: 'synthetic@example.invalid',
      GIT_COMMITTER_NAME: 'Synthetic', GIT_COMMITTER_EMAIL: 'synthetic@example.invalid',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, 'absent-config'),
    } });
    assert.equal(result.status, 0, 'synthetic git command failed');
    return result.stdout.trim();
  };
  git('init', '-q');
  mkdirSync(join(dir, 'src'));
  const commit = (content = 'public') => {
    writeFileSync(join(dir, 'src/example.ts'), content);
    git('add', '--', 'src/example.ts');
    git('-c', 'commit.gpgsign=false', 'commit', '-qm', 'Synthetic fixture');
    return git('rev-parse', 'HEAD');
  };
  const eventPath = join(dir, 'event.json');
  const run = (eventName: string, event: unknown) => {
    writeFileSync(eventPath, JSON.stringify(event));
    const lines: string[] = [];
    const result = auditPublicationRange({ cwd: dir, eventName, eventPath, report: line => lines.push(line) });
    return { ...result, lines };
  };
  const execute = (eventName?: string) => spawnSync(process.execPath, [cli, ...(eventName ? [eventName] : [])], {
    cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_PATH: eventPath },
  });
  return { dir, git, commit, run, eventPath, execute };
}

test('push and PR reject introduce-then-remove secrets despite a clean tip', t => {
  const { dir, commit, run, execute } = fixture(t);
  const base = commit();
  const secret = commit(token);
  const head = commit();
  assert.equal(auditRepository({ cwd: dir, args: ['--commit', head] }).ok, true);
  for (const [name, event] of [
    ['push', { before: base, after: head }],
    ['pull_request', { pull_request: { base: { sha: base }, head: { sha: head } } }],
  ] as const) {
    const result = run(name, event);
    assert.equal(result.ok, false);
    assert.deepEqual(result.commits, [secret, head]);
    assert.deepEqual(result.findings, [{ category: 'credential-token', commit: secret }]);
    const processResult = execute(name);
    assert.equal(processResult.status, 1);
    assert.equal(processResult.stderr, '');
    assert.equal(processResult.stdout.includes(token), false);
    assert.equal(processResult.stdout.includes('example.ts'), false);
    assert.equal(processResult.stdout.includes(`credential-token ${JSON.stringify(secret)}`), true);
  }
});

test('clean range excludes base history and does not depend on checkout HEAD', t => {
  const { git, commit, run } = fixture(t);
  const base = commit(token);
  const first = commit();
  const head = commit('public update');
  git('checkout', '-q', '--detach', base);
  const result = run('pull_request', { pull_request: { base: { sha: base }, head: { sha: head } } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.commits, [first, head]);
  assert.deepEqual(run('push', { before: base, after: base }).commits, []);
});

test('force push enumerates the new side, including side-branch merge commits', t => {
  const { git, commit, run } = fixture(t);
  const root = commit();
  const old = commit('old public');
  git('checkout', '-qb', 'replacement', root);
  const replacement = commit('replacement public');
  git('checkout', '-qb', 'side');
  const secret = commit(token);
  const repaired = commit('replacement public');
  git('checkout', '-q', 'replacement');
  git('-c', 'commit.gpgsign=false', 'merge', '--no-ff', '-qm', 'Synthetic merge', 'side');
  const head = git('rev-parse', 'HEAD');
  const result = run('push', { before: old, after: head, forced: true });
  assert.equal(result.ok, false);
  assert.deepEqual(new Set(result.commits), new Set([replacement, secret, repaired, head]));
  assert.equal(result.commits.includes(root), false);
  assert.equal(result.commits.includes(old), false);
});

test('new branch scans entire reachable history even when remote refs already contain it', t => {
  const { git, commit, run } = fixture(t);
  const historical = commit(token);
  const head = commit();
  git('update-ref', 'refs/remotes/origin/existing', head);
  const result = run('push', { before: zero, after: head, created: true });
  assert.equal(result.ok, false);
  assert.deepEqual(result.commits, [historical, head]);
});

test('deleted branches explicitly skip without resolving an unavailable old commit', t => {
  const { run, execute } = fixture(t);
  const result = run('push', { before: 'a'.repeat(40), after: zero, deleted: true });
  assert.equal(result.ok, true);
  assert.equal(result.status, 'skipped-deleted-branch');
  assert.deepEqual(result.commits, []);
  assert.deepEqual(result.lines, ['skipped-deleted-branch ""']);
  assert.equal(execute('push').status, 0);
  assert.equal(run('push', { before: zero, after: zero, deleted: true }).ok, false);
  assert.equal(run('push', { before: 'a'.repeat(40), after: zero }).ok, false);
});

test('workflow dispatch scans only HEAD, with explicit event selection', t => {
  const { commit, run, execute } = fixture(t);
  commit(token);
  const head = commit();
  const result = run('workflow_dispatch', {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.commits, [head]);
  assert.equal(execute('workflow_dispatch').status, 0);
  assert.equal(execute().status, 1);
  commit(token);
  assert.equal(run('workflow_dispatch', {}).ok, false);
});

test('missing endpoints and malformed events fail closed without event or error fragments', t => {
  const { commit, run, eventPath, execute } = fixture(t);
  const head = commit();
  const sensitive = 'sensitive-ref\n::error::untrusted';
  for (const [name, event] of [
    ['push', { before: 'a'.repeat(40), after: head }],
    ['push', { before: head, after: 'b'.repeat(40) }],
    ['push', { before: sensitive, after: head }],
    ['pull_request', { pull_request: { base: { sha: head }, head: { sha: 'b'.repeat(40) } } }],
    ['pull_request', { pull_request: { head: { sha: head } } }],
    ['push', {}], ['push', null], ['push', []], ['pull_request_target', { sensitive }],
  ] as const) {
    assert.equal(run(name, event).ok, false);
    const result = execute(name);
    assert.equal(result.status, 1);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.includes(sensitive), false);
    assert.equal(result.stdout.includes('fatal:'), false);
    for (const line of result.stdout.trim().split('\n')) assert.match(line, /^[a-z-]+ "[0-9a-f]*"$/);
  }
  writeFileSync(eventPath, '{"sensitive unparseable event');
  const malformed = execute('push');
  assert.equal(malformed.status, 1);
  assert.equal(malformed.stdout, 'event-read-failure ""\nfail ""\n');
  rmSync(eventPath);
  assert.equal(execute('push').stdout, 'event-read-failure ""\nfail ""\n');
});

test('shallow history fails even with resolvable endpoints', t => {
  const { dir, commit, run } = fixture(t);
  const base = commit();
  const head = commit('public update');
  writeFileSync(join(dir, '.git', 'shallow'), `${base}\n`);
  const result = run('push', { before: base, after: head });
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings, [{ category: 'shallow-history', commit: '' }]);
});
