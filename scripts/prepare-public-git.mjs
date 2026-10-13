#!/usr/bin/env node
// Snapshot exporter, not a commit/push command or a semantic privacy certification.
import { spawnSync } from 'node:child_process';
import { constants, lstatSync, openSync, fstatSync, readSync, closeSync, mkdirSync, mkdtempSync, writeFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, parse, relative, isAbsolute } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { MAX_FILE_BYTES, pathCategory, contentCategories, approvedBinary } from './public-repository-policy.mjs';
import { auditRepository } from './check-repository-privacy.mjs';

const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const hosts = new Set(['github.com', 'gitlab.com', 'bitbucket.org', 'codeberg.org']);
const safeCategories = new Set(['invalid-arguments', 'invalid-path', 'unsafe-parent', 'unsafe-output', 'output-exists', 'repository-root-required', 'unmerged-index', 'nonregular-file', 'size-limit', 'total-size-limit', 'file-changed', 'read-failure', 'invalid-manifest', 'binary-review-required', 'binary-change-review-required', 'unsupported-filter', 'invalid-remote', 'invalid-branch', 'git-failure', 'base-audit-failed', 'candidate-audit-failed']);

export function validateRemote(remote) {
  if (typeof remote !== 'string' || /[\s\x00-\x1f\\%?#]/.test(remote)) return false;
  const match = /^(?:https:\/\/([^/:@]+)\/|git@([^/:@]+):)([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)$/.exec(remote);
  return !!match && hosts.has(match[1] || match[2]) && match[3].split('/').every(p => p !== '.' && p !== '..' && !p.startsWith('-'));
}

function environment() {
  return {
    PATH: process.env.PATH, ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    LANG: 'C', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_CONFIG_SYSTEM: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0',
    GIT_ALLOW_PROTOCOL: 'https:ssh',
    GIT_SSH_COMMAND: 'ssh -oBatchMode=yes -oStrictHostKeyChecking=yes -F /dev/null',
  };
}

function git(cwd, args, input) {
  cwd = resolve(cwd);
  parents(cwd);
  const result = spawnSync('git', ['--no-optional-locks', '-c', `safe.directory=${cwd}`, '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-c', 'core.autocrlf=false', ...args], {
    cwd, input, env: environment(), timeout: 60_000, maxBuffer: MAX_TOTAL_BYTES,
  });
  if (result.error || result.status !== 0) throw new Error('git-failure');
  return result.stdout;
}

function records(bytes) {
  if (!bytes.length) return [];
  if (bytes.at(-1) !== 0) throw new Error('invalid-manifest');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, -1)).split('\0'); }
  catch { throw new Error('invalid-manifest'); }
}

function entries(bytes, tree = false) {
  return records(bytes).map(record => {
    const tab = record.indexOf('\t');
    const fields = record.slice(0, tab).split(' ');
    const [mode, middle, last] = fields;
    const oid = tree ? last : middle;
    if (tab < 0 || fields.length !== 3 || !/^[0-9a-f]{40,64}$/.test(oid)) throw new Error('invalid-manifest');
    return { path: record.slice(tab + 1), mode, oid, tracked: true, conflict: !tree && last !== '0' };
  });
}

function safePath(path) {
  // Also reject Windows aliases/ADS even when preparing on POSIX.
  return typeof path === 'string' && path.length > 0 && !/[\\\x00-\x1f\x7f:]/.test(path)
    && !isAbsolute(path) && path.split('/').every(p => p && p !== '.' && p !== '..'
      && !/[. ]$/.test(p) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p));
}

function parents(path) {
  const root = parse(path).root;
  const result = [{ path: root, stat: lstatSync(root) }];
  let current = root;
  for (const part of relative(root, path).split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe-parent');
    result.push({ path: current, stat });
  }
  return result;
}

function recheck(list) {
  for (const { path, stat } of list) {
    const now = lstatSync(path);
    if (!now.isDirectory() || now.isSymbolicLink() || now.dev !== stat.dev || now.ino !== stat.ino) throw new Error('unsafe-parent');
  }
}

function contains(parent, child) {
  const rel = relative(parent, child);
  return !rel || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`));
}

function outputPath(source, output) {
  if (typeof output !== 'string' || !output || /[\x00-\x1f\x7f]/.test(output)
    || output.split(/[\\/]/).includes('..')) throw new Error('unsafe-output');
  const path = resolve(output);
  if (contains(source, path) || contains(path, source)) throw new Error('unsafe-output');
  parents(dirname(path));
  try { lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return path; throw error; }
  throw new Error('output-exists');
}

function readFile(source, entry, remaining) {
  let fd;
  let observed = false;
  try {
    const file = join(source, entry.path);
    const list = parents(dirname(file));
    const before = lstatSync(file);
    observed = true;
    if (!before.isFile() || before.isSymbolicLink()) throw new Error('nonregular-file');
    if (before.size > MAX_FILE_BYTES) throw new Error('size-limit');
    if (before.size > remaining) throw new Error('total-size-limit');
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs || opened.ctimeMs !== before.ctimeMs) throw new Error('file-changed');
    recheck(list);
    const buffer = Buffer.alloc(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd), leaf = lstatSync(file);
    recheck(list);
    if (length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs || leaf.isSymbolicLink() || leaf.dev !== opened.dev || leaf.ino !== opened.ino) throw new Error('file-changed');
    return { bytes: buffer.subarray(0, length), mode: entry.mode || (opened.mode & 0o111 ? '100755' : '100644') };
  } catch (error) {
    if (error.code === 'ENOENT' && entry.tracked && !observed) return null;
    throw new Error(safeCategories.has(error.message) ? error.message : 'read-failure');
  } finally { if (fd !== undefined) closeSync(fd); }
}

function binary(bytes) {
  if (bytes.includes(0)) return true;
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return false; } catch { return true; }
}

function audit(cwd, args, report) {
  // The existing synchronous auditor has no env parameter. Isolate its Git commands too.
  const previous = process.env;
  try { process.env = environment(); return auditRepository({ cwd, args, report }); }
  finally { process.env = previous; }
}

export function preparePublicGit({ source = process.cwd(), output, remote, branch = 'main', allowBinaryChanges = false, report = () => {} } = {}) {
  const findings = [], skipped = {}, files = new Map();
  let destination, baseOid = null, scanned = 0, totalBytes = 0, deleted = 0;
  const emit = (path, category) => { findings.push({ path, category }); report(`${category} ${JSON.stringify(path)}`); };
  try {
    if (typeof source !== 'string' || typeof branch !== 'string' || typeof allowBinaryChanges !== 'boolean') throw new Error('invalid-arguments');
    source = resolve(source);
    parents(source);
    const root = git(source, ['rev-parse', '--show-toplevel']).toString('utf8').replace(/\n$/, '');
    if (root !== source) throw new Error('repository-root-required');
    if (!branch || branch.startsWith('-') || /[\x00-\x20\x7f]/.test(branch)) throw new Error('invalid-branch');
    try { git(source, ['check-ref-format', '--branch', branch]); } catch { throw new Error('invalid-branch'); }
    if (remote !== undefined && !validateRemote(remote)) throw new Error('invalid-remote');
    if (output !== undefined) output = outputPath(source, output);

    const candidates = entries(git(source, ['ls-files', '--stage', '-z']));
    const known = new Set(candidates.map(e => e.path));
    for (const path of records(git(source, ['ls-files', '--others', '--exclude-standard', '-z']))) {
      if (!known.has(path)) candidates.push({ path, tracked: false });
    }
    const allowed = [];
    for (const entry of candidates) {
      if (entry.conflict) { emit('', 'unmerged-index'); continue; }
      const category = pathCategory(entry.path, entry.tracked);
      if (category === 'invalid-path' || !safePath(entry.path)) { emit(entry.path, 'invalid-path'); continue; }
      if (category) { skipped[category] = (skipped[category] || 0) + 1; continue; }
      if (entry.mode && !['100644', '100755'].includes(entry.mode)) { emit(entry.path, 'nonregular-file'); continue; }
      allowed.push(entry);
    }
    if (findings.length) return { ok: false, findings, skipped, scanned, totalBytes };
    let headTree;
    for (const entry of allowed) {
      try {
        const file = readFile(source, entry, MAX_TOTAL_BYTES - totalBytes);
        if (!file) { deleted++; continue; }
        scanned++;
        totalBytes += file.bytes.length;
        const isBinary = binary(file.bytes);
        const baselineBinary = isBinary && approvedBinary(entry.path, true);
        const categories = contentCategories(file.bytes, entry.path, baselineBinary ? true : entry.tracked);
        if (entry.path.split('/').at(-1) === '.gitattributes'
          && file.bytes.toString('utf8').split(/\r?\n/).some(line => !/^\s*#/.test(line) && /(?:^|\s)filter(?:=\S*|(?=\s|$))/.test(line))) categories.push('unsupported-filter');
        if (baselineBinary && !allowBinaryChanges) {
          if (!headTree) {
            parents(source);
            const head = spawnSync('git', ['--no-optional-locks', '-c', `safe.directory=${source}`, '-c', 'core.fsmonitor=false', 'rev-parse', '--verify', 'HEAD^{commit}'], { cwd: source, env: environment(), encoding: 'utf8' });
            headTree = new Map();
            if (head.status === 0 && /^[0-9a-f]{40,64}\n$/.test(head.stdout)) {
              for (const e of entries(git(source, ['ls-tree', '-rz', '--full-tree', head.stdout.trim()]), true)) headTree.set(e.path, e);
            }
          }
          const original = headTree.get(entry.path);
          let unchanged = false;
          if (original && ['100644', '100755'].includes(original.mode)) {
            // Only this already approved public blob is read, never private HEAD blobs.
            const size = Number(git(source, ['cat-file', '-s', original.oid]).toString('ascii').trim());
            if (size === file.bytes.length && size <= MAX_FILE_BYTES) unchanged = git(source, ['cat-file', 'blob', original.oid]).equals(file.bytes);
          }
          if (!unchanged) categories.push('binary-change-review-required');
        }
        for (const category of categories) emit(entry.path, category);
        files.set(entry.path, file);
      } catch (error) { emit(entry.path, safeCategories.has(error.message) ? error.message : 'read-failure'); }
    }
    if (findings.length) return { ok: false, findings, skipped, scanned, totalBytes };

    // Tools come from the running exporter, not the source argument or remote.
    const tools = new Map();
    const toolRoot = dirname(fileURLToPath(import.meta.url));
    for (const name of ['public-git-guard.mjs', 'check-repository-privacy.mjs', 'public-repository-policy.mjs']) {
      const tool = readFile(toolRoot, { path: name, tracked: false }, MAX_TOTAL_BYTES);
      for (const category of contentCategories(tool.bytes, `scripts/${name}`, true)) emit(`scripts/${name}`, category);
      tools.set(name, tool.bytes);
    }
    if (findings.length) return { ok: false, findings, skipped, scanned, totalBytes };

    if (output !== undefined) {
      destination = outputPath(source, output);
      mkdirSync(destination, { mode: 0o700 });
    } else {
      const parent = process.platform === 'linux' && existsSync('/tmp/opencode') ? '/tmp/opencode' : tmpdir();
      parents(resolve(parent));
      if (contains(source, resolve(parent))) throw new Error('unsafe-output');
      destination = mkdtempSync(join(parent, 'liyuan-public-'));
    }
    chmodSync(destination, 0o700);
    git(destination, ['init', '--quiet', '--template=', '--initial-branch', branch]);
    // Only this newly created repository is configured; never the source.
    for (const [key, value] of [['core.hooksPath', '.git/hooks'], ['core.fsmonitor', 'false'], ['core.attributesFile', process.platform === 'win32' ? 'NUL' : '/dev/null']]) {
      git(destination, ['config', '--local', key, value]);
    }
    const basePaths = [];
    if (remote !== undefined) {
      git(destination, ['fetch', '--quiet', '--no-tags', '--depth=1', '--no-recurse-submodules', '--', remote, `refs/heads/${branch}`]);
      baseOid = git(destination, ['rev-parse', '--verify', 'FETCH_HEAD^{commit}']).toString('ascii').trim();
      if (!/^[0-9a-f]{40,64}$/.test(baseOid)) throw new Error('invalid-manifest');
      // The scanner rejects forbidden paths before reading their blobs. Only
      // historical local records may survive this audit, solely for removal.
      const result = audit(destination, ['--commit', baseOid], () => {});
      const rejected = result.findings.filter(finding => finding.category !== 'local-record'
        || pathCategory(finding.path, true) !== 'local-record');
      for (const finding of rejected) emit(finding.path, finding.category);
      if (rejected.length || (!result.ok && !result.findings.length)) throw new Error('base-audit-failed');
      for (const entry of entries(git(destination, ['ls-tree', '-rz', '--full-tree', baseOid]), true)) {
        if (!safePath(entry.path)) { emit(entry.path, 'invalid-path'); continue; }
        basePaths.push(entry.path);
      }
      if (findings.length) throw new Error('base-audit-failed');
      git(destination, ['update-ref', `refs/heads/${branch}`, baseOid]);
      git(destination, ['read-tree', baseOid]);
    }

    // No checkout, filters, source index writes, blanket add, or inherited templates.
    // Hash the vetted bytes directly so attributes cannot transform the snapshot.
    for (const [path, file] of files) {
      const target = join(destination, path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      parents(dirname(target));
      writeFileSync(target, file.bytes, { flag: 'wx', mode: file.mode === '100755' ? 0o700 : 0o600 });
    }
    const removals = basePaths.filter(path => !files.has(path));
    if (removals.length) git(destination, ['update-index', '--force-remove', '-z', '--stdin'], Buffer.from(removals.join('\0') + '\0'));
    const index = [];
    for (const [path, file] of files) {
      const oid = git(destination, ['hash-object', '-w', '--stdin'], file.bytes).toString('ascii').trim();
      if (!/^[0-9a-f]{40,64}$/.test(oid)) throw new Error('invalid-manifest');
      index.push(`${file.mode} ${oid}\t${path}\0`);
    }
    if (index.length) git(destination, ['update-index', '-z', '--index-info'], Buffer.from(index.join('')));
    for (const args of [['--staged'], []]) {
      const result = audit(destination, args, report);
      if (!result.ok) { findings.push(...result.findings); throw new Error('candidate-audit-failed'); }
    }
    const manifest = {
      version: 1, baseOid, counts: { files: files.size, scanned, totalBytes, skipped, deleted, baseRemovals: removals.length },
      files: [...files].map(([path, file]) => ({ path, sha256: createHash('sha256').update(file.bytes).digest('hex') })),
    };
    writeFileSync(join(destination, '.git/liyuan-public-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const guardDir = join(destination, '.git/liyuan-public-guard');
    mkdirSync(guardDir, { mode: 0o700 });
    for (const [name, bytes] of tools) writeFileSync(join(guardDir, name), bytes, { flag: 'wx', mode: 0o600 });
    mkdirSync(join(destination, '.git/hooks'), { mode: 0o700 });
    for (const hook of ['pre-commit', 'pre-push']) {
      writeFileSync(join(destination, '.git/hooks', hook), `#!/bin/sh\nexec node .git/liyuan-public-guard/public-git-guard.mjs ${hook}\n`, { flag: 'wx', mode: 0o700 });
    }
    return { ok: true, output: destination, findings, ...manifest.counts, baseOid, hooksEnabled: true };
  } catch (error) {
    emit('', safeCategories.has(error.message) ? error.message : 'git-failure');
    return { ok: false, ...(destination ? { output: destination } : {}), findings, skipped, scanned, totalBytes };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const options = { report: line => console.log(line) };
  let valid = true;
  const seen = new Set();
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('Usage: node scripts/prepare-public-git.mjs [--output NEW_EXTERNAL_DIRECTORY] [--remote PUBLIC_URL] [--branch BRANCH] [--allow-binary-changes] [--json]');
    console.log('Exports current allowed worktree bytes into a fresh staged repository. No commit or push. Remote mode fetches only the explicit public branch. Binary changes at approved paths require human review.');
  } else {
    let json = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (seen.has(arg)) { valid = false; break; }
      seen.add(arg);
      if (arg === '--allow-binary-changes') options.allowBinaryChanges = true;
      else if (arg === '--json') json = true;
      else if (['--output', '--remote', '--branch'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) options[arg.slice(2)] = args[++i];
      else { valid = false; break; }
    }
    if (json) options.report = () => {};
    const result = valid ? preparePublicGit(options) : { ok: false, findings: [{ path: '', category: 'invalid-arguments' }] };
    if (json) console.log(JSON.stringify(result));
    else {
      if (!valid) console.log('invalid-arguments ""');
      console.log(`${result.ok ? 'pass' : 'fail'} ${JSON.stringify(result.output || '')}`);
      if (result.ok) console.log(JSON.stringify({ files: result.files, totalBytes: result.totalBytes, skipped: result.skipped, deleted: result.deleted, baseRemovals: result.baseRemovals, hooksEnabled: result.hooksEnabled }));
    }
    process.exitCode = result.ok ? 0 : 1;
  }
}
