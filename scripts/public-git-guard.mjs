// Installed with its trusted scanner/policy under candidate .git, never run from
// the editable candidate scripts directory. No network or repository writes.
import { spawnSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, parse, relative, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { auditRepository } from './check-repository-privacy.mjs';
import { approvedBinary, contentCategories, MAX_FILE_BYTES } from './public-repository-policy.mjs';

export function guard({ mode, cwd = process.cwd(), input = '', report = () => {} }) {
  let scanned = 0;
  const findings = [];
  const emit = (category, path = '') => { findings.push({ category, path }); report(`${category} ${JSON.stringify(path)}`); };
  const git = args => {
    cwd = resolve(cwd);
    let parent = parse(cwd).root;
    for (const part of relative(parent, cwd).split(/[\\/]/).filter(Boolean)) {
      parent = join(parent, part);
      const stat = lstatSync(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe-parent');
    }
    const result = spawnSync('git', ['--no-optional-locks', '-c', `safe.directory=${cwd}`, '-c', 'core.fsmonitor=false', ...args], {
      cwd, env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' },
      timeout: 60_000, maxBuffer: 128 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) throw new Error('git-failure');
    return result.stdout;
  };
  const oid = value => /^[0-9a-f]{40}$|^[0-9a-f]{64}$/.test(value);
  const zero = value => /^0+$/.test(value);
  const verify = (value, scanTags = false) => {
    const seen = new Set();
    while (git(['cat-file', '-t', value]).toString('ascii').trim() === 'tag') {
      if (seen.has(value) || seen.size >= 32) throw new Error('invalid-endpoint');
      seen.add(value);
      const size = Number(git(['cat-file', '-s', value]).toString('ascii').trim());
      if (!Number.isSafeInteger(size) || size > MAX_FILE_BYTES) throw new Error('size-limit');
      const bytes = git(['cat-file', 'tag', value]);
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (scanTags) {
        const message = text.indexOf('\n\n');
        if (message < 0) throw new Error('invalid-endpoint');
        const categories = new Set([...contentCategories(bytes, '', false),
          ...contentCategories(Buffer.from(text.slice(message + 2)), '', false)]);
        for (const category of categories) emit(category);
        scanned++;
      }
      const target = /^object ([0-9a-f]{40}|[0-9a-f]{64})\n/.exec(text)?.[1];
      if (!target || target.length !== value.length) throw new Error('invalid-endpoint');
      value = target;
    }
    if (git(['rev-parse', '--verify', '--end-of-options', `${value}^{commit}`]).toString('ascii').trim() !== value) throw new Error('invalid-endpoint');
    return value;
  };
  try {
    if (!['pre-commit', 'pre-push'].includes(mode)) throw new Error('invalid-arguments');
    if (git(['rev-parse', '--show-toplevel']).toString('utf8').replace(/\n$/, '') !== resolve(cwd)) throw new Error('repository-root-required');
    const commits = new Set();
    if (mode === 'pre-push') {
      if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('invalid-push-input');
      const shallow = git(['rev-parse', '--is-shallow-repository']).toString('ascii').trim() === 'true';
      const boundaries = shallow ? new Set(readFileSync(resolve(cwd, '.git/shallow'), 'ascii').trim().split('\n')) : new Set();
      for (const line of input.split('\n').filter(Boolean)) {
        const fields = line.split(' ');
        if (fields.length !== 4 || !oid(fields[1]) || !oid(fields[3]) || fields[1].length !== fields[3].length
          || !fields[0] || !fields[2] || /[\x00-\x20\x7f]/.test(fields[0] + fields[2])) throw new Error('invalid-push-input');
        const [, local, , remote] = fields;
        if (zero(local)) continue;
        const localCommit = verify(local, true);
        let remoteCommit;
        if (zero(remote)) {
          if (shallow) throw new Error('shallow-history');
        } else remoteCommit = verify(remote); // Missing remote objects fail; never fetch from a hook.
        const range = git(['rev-list', localCommit, ...(remoteCommit ? [`^${remoteCommit}`] : []), '--']).toString('ascii').trim();
        for (const commit of range ? range.split('\n') : []) {
          if (!oid(commit)) throw new Error('invalid-manifest');
          if (boundaries.has(commit)) throw new Error('shallow-history');
          commits.add(commit);
        }
      }
    }
    const snapshots = mode === 'pre-commit' ? [null] : [...commits];
    const manifest = JSON.parse(readFileSync(resolve(cwd, '.git/liyuan-public-manifest.json'), 'utf8'));
    const reviewed = new Map(manifest.files.map(file => [file.path, file.sha256]));
    for (const commit of snapshots) {
      const result = auditRepository({ cwd, args: commit ? ['--commit', commit] : ['--staged'], report });
      findings.push(...result.findings);
      scanned += result.scanned;
      if (!result.ok) continue;
      // Approved binary paths are not an automatic license for subsequent edits.
      const tree = git(commit ? ['ls-tree', '-rz', '--full-tree', commit] : ['ls-files', '--stage', '-z']);
      for (const record of new TextDecoder('utf-8', { fatal: true }).decode(tree).split('\0').filter(Boolean)) {
        const tab = record.indexOf('\t'), path = record.slice(tab + 1);
        if (!approvedBinary(path, true)) continue;
        const fields = record.slice(0, tab).split(' '), blob = commit ? fields[2] : fields[1];
        const size = Number(git(['cat-file', '-s', blob]).toString('ascii').trim());
        if (!Number.isSafeInteger(size) || size > MAX_FILE_BYTES) throw new Error('size-limit');
        const bytes = git(['cat-file', 'blob', blob]);
        let isBinary = bytes.includes(0);
        try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { isBinary = true; }
        if (isBinary && createHash('sha256').update(bytes).digest('hex') !== reviewed.get(path)) emit('binary-change-review-required', path);
      }
    }
  } catch (error) {
    const categories = ['invalid-arguments', 'invalid-push-input', 'invalid-endpoint', 'shallow-history', 'repository-root-required', 'invalid-manifest', 'size-limit'];
    emit(categories.includes(error.message) ? error.message : 'guard-failure');
  }
  return { ok: findings.length === 0, findings, scanned };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let input = '';
  try {
    if (process.argv[2] === 'pre-push') {
      for await (const chunk of process.stdin) {
        input += chunk.toString('utf8');
        if (Buffer.byteLength(input) > 1024 * 1024) throw new Error();
      }
    }
    const result = guard({ mode: process.argv[2], input, report: line => console.log(line) });
    console.log(`${result.ok ? 'pass' : 'fail'} ${JSON.stringify('')} scanned=${result.scanned}`);
    process.exitCode = result.ok ? 0 : 1;
  } catch {
    console.log('guard-failure ""');
    process.exitCode = 1;
  }
}
