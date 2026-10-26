import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathCategory } from './public-repository-policy.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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

const entries = ['README.md', 'TESTING.md', 'AGENTS.md', 'CLAUDE.md'];

// Deliberately a small Markdown parser, not a heading or full CommonMark validator.
function links(text) {
  let fence;
  const visible = text.split('\n').map(line => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
      return '';
    }
    if (marker) { fence = marker[1]; return ''; }
    return line;
  }).join('\n').replace(/(`+)([\s\S]*?)\1(?!`)/g, '');
  const destinations = [];
  // Angle-delimited destinations allow spaces; plain destinations also accept
  // spaces, with an optional quoted title removed. Nested parentheses are not parsed.
  const destination = raw => raw.trim().replace(/\s+["'][\s\S]*["']$/, '').replace(/^<([\s\S]*)>$/, '$1');
  for (const match of visible.matchAll(/\[[^\]\n]*\]\(\s*(<[^>\n]*>|[^)\n]*)\)/g)) destinations.push(destination(match[1]));
  // Checking all reference definitions also covers collapsed/shortcut references.
  for (const match of visible.matchAll(/^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]*>|[^\n]+)/gm)) destinations.push(destination(match[1]));
  return destinations;
}

export function checkDocumentation({ root = repositoryRoot } = {}) {
  root = resolve(root);
  const findings = [];
  const files = [];
  let checkedLinks = 0;
  const fail = (source, target, category) => findings.push({ source, target, category });
  // Check each component with lstat: stat/exists alone would follow parent links.
  const safeStat = absolute => {
    const parents = [];
    for (let current = absolute; ; current = dirname(current)) {
      parents.push(current);
      if (dirname(current) === current) break;
    }
    let stat;
    for (const component of parents.reverse()) {
      stat = lstatSync(component);
      if (stat.isSymbolicLink()) throw Object.assign(new Error(), { code: 'SYMLINK' });
      if (component !== absolute && !stat.isDirectory()) throw Object.assign(new Error(), { code: 'ENOTDIR' });
    }
    return stat;
  };
  const inspect = (source, target) => {
    const absolute = resolve(root, ...target.split('/'));
    const local = relative(root, absolute).split(/[\\/]/).join('/');
    if (!local || local === '..' || local.startsWith('../') || isAbsolute(local) || /[\\\x00]/.test(target)) {
      fail(source, target, 'outside-repository');
      return;
    }
    const markdown = /\.md$/i.test(local);
    const category = pathCategory(local, true);
    if (category) { fail(source, local, category); return; }
    try {
      const stat = safeStat(absolute);
      if (markdown && !stat.isFile()) { fail(source, local, 'nonregular-markdown'); return; }
    } catch (error) {
      fail(source, local, error.code === 'SYMLINK' ? 'symlink-path' : error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'missing-target' : 'stat-failure');
      return;
    }
    if (markdown && !local.startsWith('packages/')) return local;
  };
  const pending = entries.map(entry => inspect('', entry)).filter(Boolean);
  const visited = new Set();
  while (pending.length) {
    const source = pending.shift();
    if (visited.has(source)) continue;
    visited.add(source);
    // Recheck the content input immediately before reading, including its policy.
    if (!inspect('', source)) continue;
    let text;
    try { text = readFileSync(resolve(root, source), 'utf8'); }
    catch { fail(source, source, 'read-failure'); continue; }
    files.push(source);
    for (const href of links(text)) {
      if (!href || href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
      // Fragments (including HTML anchor ids) and queries are not validated.
      const path = href.split(/[?#]/, 1)[0];
      if (!path) continue;
      let decoded;
      try { decoded = decodeURIComponent(path); }
      catch { fail(source, '', 'invalid-url-encoding'); continue; }
      checkedLinks++;
      if (isAbsolute(decoded) || decoded.startsWith('/') || /^[a-z]:/i.test(decoded) || /[\\\x00]/.test(decoded)) {
        fail(source, decoded, 'outside-repository');
        continue;
      }
      const next = inspect(source, posix.join(posix.dirname(source), decoded));
      if (next && !visited.has(next)) pending.push(next);
    }
  }
  return { ok: findings.length === 0, files, checkedLinks, findings };
}

if (isMain()) {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--root')) {
    console.error('Usage: node scripts/check-docs.mjs [--root repository-directory]');
    process.exitCode = 1;
  } else {
    const result = checkDocumentation(args.length ? { root: args[1] } : {});
    for (const finding of result.findings) console.log(`${finding.category} ${JSON.stringify(finding.source)} -> ${JSON.stringify(finding.target)}`);
    console.log(`Documentation links: ${result.ok ? 'PASS' : 'FAIL'}; ${result.files.length} current Markdown files, ${result.checkedLinks} local targets. Existence only; headings/HTML anchors are not checked. Local records are rejected; packages/ are not recursively read.`);
    process.exitCode = result.ok ? 0 : 1;
  }
}
