#!/usr/bin/env node
// Read-only gate. All diagnostics are category + JSON-escaped path, never content/errors.
import { spawnSync } from 'node:child_process';
import { constants, lstatSync, openSync, fstatSync, readSync, closeSync, realpathSync } from 'node:fs';
import { resolve, join, parse, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_FILE_BYTES, pathCategory, contentCategories } from './public-repository-policy.mjs';

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

function git(cwd, args, input) {
  cwd = resolve(cwd);
  let parent = parse(cwd).root;
  for (const part of relative(parent, cwd).split(/[\\/]/).filter(Boolean)) {
    parent = join(parent, part);
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe-parent');
  }
  const result = spawnSync('git', ['--no-optional-locks', '-c', `safe.directory=${cwd}`, '-c', 'core.fsmonitor=false', ...args], {
    cwd, input, maxBuffer: 128 * 1024 * 1024, timeout: 60_000,
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error || result.status !== 0) throw new Error('git-failure');
  return result.stdout;
}
function records(bytes) {
  if (!bytes.length) return [];
  if (bytes.at(-1) !== 0) throw new Error('invalid-manifest');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, -1)).split('\0');
}
function manifest(bytes, staged) {
  return records(bytes).map(record => {
    const tab = record.indexOf('\t');
    if (tab < 0) throw new Error('invalid-manifest');
    const fields = record.slice(0, tab).split(' ');
    const [mode, middle, last] = fields;
    const oid = staged ? middle : last;
    if (!/^[0-9a-f]{40,64}$/.test(oid)) throw new Error('invalid-manifest');
    return { path: record.slice(tab + 1), mode, oid, tracked: true, conflict: staged && last !== '0' };
  });
}

export function auditRepository({ cwd = process.cwd(), args = [], report = () => {} } = {}) {
  const findings = [];
  const emit = (path, category) => { findings.push({ path, category }); report(`${category} ${JSON.stringify(path)}`); };
  let scanned = 0;
  try {
    if (!(args.length === 0 || (args.length === 1 && args[0] === '--staged') || (args.length === 2 && args[0] === '--commit' && args[1]))) throw new Error('invalid-arguments');
    const root = git(cwd, ['rev-parse', '--show-toplevel']).toString('utf8').replace(/\r?\n$/, '');
    if (!sameFilesystemPath(cwd, root)) throw new Error('repository-root-required');
    let entries;
    if (args[0] === '--commit') {
      const oid = git(root, ['rev-parse', '--verify', '--end-of-options', `${args[1]}^{commit}`]).toString('ascii').trim();
      if (!/^[0-9a-f]{40,64}$/.test(oid)) throw new Error('invalid-manifest');
      entries = manifest(git(root, ['ls-tree', '-rz', '--full-tree', oid]), false);
    } else {
      entries = manifest(git(root, ['ls-files', '--stage', '-z']), true);
      if (!args.length) {
        const known = new Set(entries.map(e => e.path));
        for (const path of records(git(root, ['ls-files', '--others', '--exclude-standard', '-z']))) {
          if (!known.has(path)) entries.push({ path, tracked: false });
        }
      }
    }
    const allowed = [];
    for (const entry of entries) {
      const category = pathCategory(entry.path, entry.tracked);
      // Source worktrees retain local records; publication snapshots must not.
      if (!args.length && category === 'local-record') continue;
      if (category) emit(entry.path, category);
      else if (entry.conflict) emit(entry.path, 'unmerged-index');
      else if (entry.mode && !['100644', '100755'].includes(entry.mode)) emit(entry.path, 'nonregular-file');
      else allowed.push(entry);
    }
    const scan = (entry, bytes) => {
      if (bytes.length > MAX_FILE_BYTES) { emit(entry.path, 'size-limit'); return; }
      for (const category of contentCategories(bytes, entry.path, entry.tracked)) emit(entry.path, category);
      scanned++;
    };
    if (!args.length) {
      for (const entry of allowed) {
        let fd;
        try {
          const parts = entry.path.split('/');
          let parent = root;
          let absent = false;
          for (const part of parts.slice(0, -1)) {
            parent = join(parent, part);
            let stat;
            try { stat = lstatSync(parent); } catch (error) { if (error.code === 'ENOENT' && entry.tracked) { absent = true; break; } throw error; }
            if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe-parent');
          }
          if (absent) continue;
          const file = join(root, entry.path);
          let before;
          try { before = lstatSync(file); } catch (error) { if (error.code === 'ENOENT' && entry.tracked) continue; throw error; }
          if (!before.isFile()) throw new Error('nonregular-file');
          if (before.size > MAX_FILE_BYTES) { emit(entry.path, 'size-limit'); continue; }
          fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
          const opened = fstatSync(fd);
          if (!opened.isFile() || before.ino !== opened.ino || before.dev !== opened.dev) throw new Error('file-changed');
          // Recheck parents after opening; never follow a static parent symlink.
          parent = root;
          for (const part of parts.slice(0, -1)) {
            parent = join(parent, part);
            if (!lstatSync(parent).isDirectory()) throw new Error('unsafe-parent');
          }
          const buffer = Buffer.alloc(Math.min(opened.size + 1, MAX_FILE_BYTES + 1));
          let length = 0, count;
          while (length < buffer.length && (count = readSync(fd, buffer, length, buffer.length - length, null)) !== 0) length += count;
           if (length !== opened.size) emit(entry.path, 'file-changed');
          else scan(entry, buffer.subarray(0, length));
          const after = fstatSync(fd);
          if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) emit(entry.path, 'file-changed');
        } catch (error) {
          emit(entry.path, ['unsafe-parent', 'nonregular-file', 'file-changed'].includes(error.message) ? error.message : 'read-failure');
        } finally { if (fd !== undefined) closeSync(fd); }
      }
    } else {
      // Query sizes first, then bounded batches of actual object IDs (not path expressions).
      const metadata = git(root, ['cat-file', '--batch-check'], allowed.map(e => `${e.oid}\n`).join('')).toString('ascii').trim().split('\n');
      const blobs = [];
      for (let i = 0; i < allowed.length; i++) {
        const entry = allowed[i];
        const fields = metadata[i]?.split(' ');
        if (fields?.[0] !== entry.oid || fields[1] !== 'blob' || !/^\d+$/.test(fields[2])) { emit(entry.path, 'blob-failure'); continue; }
        entry.size = Number(fields[2]);
        if (entry.size > MAX_FILE_BYTES) emit(entry.path, 'size-limit');
        else blobs.push(entry);
      }
      for (let start = 0; start < blobs.length;) {
        let end = start, size = 0;
        while (end < blobs.length && size + blobs[end].size < 32 * 1024 * 1024) size += blobs[end++].size + 128;
        const batch = blobs.slice(start, end);
        const bytes = git(root, ['cat-file', '--batch'], batch.map(e => `${e.oid}\n`).join(''));
        let offset = 0;
        for (const entry of batch) {
          const newline = bytes.indexOf(10, offset);
          if (newline < 0 || bytes.subarray(offset, newline).toString('ascii') !== `${entry.oid} blob ${entry.size}`) throw new Error('blob-failure');
          offset = newline + 1;
          if (offset + entry.size >= bytes.length || bytes[offset + entry.size] !== 10) throw new Error('blob-failure');
          scan(entry, bytes.subarray(offset, offset + entry.size));
          offset += entry.size + 1;
        }
        if (offset !== bytes.length) throw new Error('blob-failure');
        start = end;
      }
    }
  } catch (error) {
    emit('', ['invalid-arguments', 'repository-root-required', 'invalid-manifest', 'blob-failure'].includes(error.message) ? error.message : 'git-failure');
  }
  return { ok: findings.length === 0, findings, scanned };
}

if (isMain()) {
  const result = auditRepository({ args: process.argv.slice(2), report: line => console.log(line) });
  console.log(`${result.ok ? 'pass' : 'fail'} ${JSON.stringify('')}`);
  process.exitCode = result.ok ? 0 : 1;
}
