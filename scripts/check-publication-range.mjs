#!/usr/bin/env node
// Event refs never fall back to HEAD. Diagnostics contain only categories and escaped OIDs.
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditRepository } from './check-repository-privacy.mjs';

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

const isOid = value => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value);
const isZero = value => isOid(value) && /^0+$/.test(value);

export function auditPublicationRange({ cwd = process.cwd(), eventName,
  eventPath = process.env.GITHUB_EVENT_PATH, report = () => {} } = {}) {
  const commits = [];
  const findings = [];
  const emit = (category, commit = '') => report(`${category} ${JSON.stringify(commit)}`);
  const fail = category => { throw new Error(category); };
  const git = args => {
    const result = spawnSync('git', ['--no-optional-locks', ...args], {
      cwd, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 60_000,
      env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' },
    });
    if (result.error || result.status !== 0) fail('git-failure');
    return result.stdout.trim();
  };
  const commitOid = ref => {
    if (ref !== 'HEAD' && (!isOid(ref) || isZero(ref))) fail('invalid-event-ref');
    const oid = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
    if (!isOid(oid) || (ref !== 'HEAD' && oid !== ref)) fail('invalid-commit');
    return oid;
  };
  try {
    if (!['pull_request', 'push', 'workflow_dispatch'].includes(eventName)) fail('unsupported-event');
    let event;
    try { event = JSON.parse(readFileSync(eventPath, 'utf8')); } catch { fail('event-read-failure'); }
    if (!event || typeof event !== 'object' || Array.isArray(event)) fail('invalid-event');
    let base, head;
    if (eventName === 'push') {
      if (!isOid(event.before) || !isOid(event.after) || event.before.length !== event.after.length
        || (event.deleted !== undefined && typeof event.deleted !== 'boolean')) fail('invalid-event-ref');
      if (event.deleted === true && isZero(event.after) && !isZero(event.before)) {
        emit('skipped-deleted-branch');
        return { ok: true, status: 'skipped-deleted-branch', commits, findings };
      }
      if (event.deleted === true || isZero(event.after)) fail('invalid-event-ref');
    }
    // A shallow boundary can hide an introduced secret, even when both endpoints exist.
    if (git(['rev-parse', '--is-shallow-repository']) !== 'false') fail('shallow-history');
    if (eventName === 'pull_request') {
      base = commitOid(event.pull_request?.base?.sha);
      head = commitOid(event.pull_request?.head?.sha);
    } else if (eventName === 'push') {
      head = commitOid(event.after);
      if (!isZero(event.before)) base = commitOid(event.before);
      // New branches scan ALL reachable history, not remote exclusions. Historical
      // findings may therefore fail a new-branch publication; this is intentional.
    } else {
      head = commitOid('HEAD');
    }
    const output = eventName === 'workflow_dispatch' ? head
      : git(['rev-list', '--reverse', base ? `${base}..${head}` : head]);
    if (output) {
      for (const oid of output.split('\n')) {
        if (!isOid(oid)) fail('invalid-commit');
        commits.push(oid);
      }
    }
    for (const commit of commits) {
      const audit = auditRepository({ cwd, args: ['--commit', commit] });
      for (const category of new Set(audit.findings.map(finding => finding.category))) {
        findings.push({ category, commit });
        emit(category, commit);
      }
      emit(audit.ok ? 'commit-pass' : 'commit-fail', commit);
    }
    const ok = findings.length === 0;
    emit(ok ? 'pass' : 'fail');
    return { ok, status: ok ? 'pass' : 'fail', commits, findings };
  } catch (error) {
    const category = ['unsupported-event', 'event-read-failure', 'invalid-event', 'invalid-event-ref',
      'git-failure', 'invalid-commit', 'shallow-history'].includes(error?.message) ? error.message : 'range-failure';
    findings.push({ category, commit: '' });
    emit(category);
    emit('fail');
    return { ok: false, status: 'fail', commits, findings };
  }
}

if (isMain()) {
  const result = auditPublicationRange({
    eventName: process.argv.length === 3 ? process.argv[2] : undefined,
    report: line => console.log(line),
  });
  process.exitCode = result.ok ? 0 : 1;
}
