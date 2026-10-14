#!/usr/bin/env node
// Run ONLY from the trusted base checkout, with the candidate repository as cwd.
// No candidate modules, package scripts, generators or executables are loaded.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditRepository } from './check-repository-privacy.mjs';
import { auditPublicationRange } from './check-publication-range.mjs';
import { countUngeneralizedHomePaths, analyzeSessionFixtureJsonl } from './check-public-data.mjs';
import { pathCategory, MAX_FILE_BYTES } from './public-repository-policy.mjs';
import { generateFixture, FIXTURE_NAMES } from '../packages/coding-agent/test/fixtures/generate-synthetic-fixtures.ts';

function sameFilesystemPath(left, right) {
  const canonical = path => {
    const value = realpathSync(resolve(path)).replace(/\\/g, '/');
    return process.platform === 'win32' ? value.toLowerCase() : value;
  };
  return canonical(left) === canonical(right);
}

function isMain() {
  if (!process.argv[1]) return false;
  try { return sameFilesystemPath(process.argv[1], fileURLToPath(import.meta.url)); }
  catch { return false; }
}

export function auditPrivacyCI({ cwd = process.cwd(), eventName = process.env.GITHUB_EVENT_NAME,
  eventPath = process.env.GITHUB_EVENT_PATH, report = () => {} } = {}) {
  const findings = [];
  const emit = category => { findings.push(category); report(`${category} ""`); };
  const git = args => {
    const result = spawnSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', ...args], {
      cwd, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' },
      timeout: 60_000, maxBuffer: 128 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error();
    return result.stdout;
  };
  try {
    const event = JSON.parse(readFileSync(eventPath, 'utf8'));
    const name = eventName === 'pull_request_target' ? 'pull_request' : eventName;
    // Baseline selection is enforced by the workflow, not supplied by head code.
    if (name === 'push' && /^0+$/.test(event.before ?? '')) {
      emit('trusted-baseline-required');
      return { ok: false, findings };
    }
    const range = auditPublicationRange({ cwd, eventName: name, eventPath, report });
    if (!range.ok) emit('commit-range-failed');
    const head = name === 'pull_request' ? event.pull_request?.head?.sha
      : name === 'push' ? event.after : git(['rev-parse', 'HEAD']).toString('ascii').trim();
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head ?? '')) throw new Error();
    // Always scan head, even if the introduced range is empty.
    const commits = new Set([head, ...range.commits]);
    const expected = new Map(FIXTURE_NAMES.map(name => [
      `packages/coding-agent/test/fixtures/${name}`, Buffer.from(generateFixture(name)),
    ]));
    for (const commit of commits) {
      if (!auditRepository({ cwd, args: ['--commit', commit] }).ok) emit('snapshot-failed');
      const records = new TextDecoder('utf-8', { fatal: true }).decode(git(['ls-tree', '-rz', '--full-tree', commit])).split('\0').filter(Boolean);
      const found = new Set();
      for (const record of records) {
        const tab = record.indexOf('\t'), path = record.slice(tab + 1);
        const [mode, type, oid] = record.slice(0, tab).split(' ');
        if (pathCategory(path, true) || (!/\.md$/i.test(path) && !expected.has(path))) continue;
        if (!['100644', '100755'].includes(mode) || type !== 'blob') throw new Error();
        const size = Number(git(['cat-file', '-s', oid]).toString('ascii').trim());
        if (!Number.isSafeInteger(size) || size > MAX_FILE_BYTES) throw new Error();
        const bytes = git(['cat-file', 'blob', oid]);
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        if (countUngeneralizedHomePaths(text)) emit('ungeneralized-home-path');
        if (expected.has(path)) {
          found.add(path);
          const fixture = analyzeSessionFixtureJsonl(text);
          if (!bytes.equals(expected.get(path)) || fixture.invalidJsonLineCount || !fixture.hasSyntheticProvenance
            || !fixture.textRoleMessageCount || fixture.unmarkedRoleMessageCount || fixture.homePathCount) emit('synthetic-fixture-failed');
        }
      }
      if (found.size !== expected.size) emit('required-fixture-missing');
    }
  } catch { emit('trusted-ci-failure'); }
  report(`${findings.length ? 'fail' : 'pass'} ""`);
  return { ok: findings.length === 0, findings };
}

if (isMain()) {
  process.exitCode = auditPrivacyCI({ report: line => console.log(line) }).ok ? 0 : 1;
}
