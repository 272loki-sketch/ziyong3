// Publication policy, not runtime configuration or a copyright/provenance audit.
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

const roots = new Set([
  '.gitattributes', '.gitignore', '.dockerignore', 'AGENTS.md', 'CLAUDE.md',
  'README.md', 'TESTING.md', 'LICENSE', 'Dockerfile', 'docker-compose.yml',
  'package.json', 'package-lock.json', 'tsconfig.json',
  'start.sh', 'start.bat', 'start.command', 'docker-entrypoint.sh',
  'liyuan.agent.example.json', 'liyuan.config.example.json',
]);
// Reviewed path baseline from git ls-files assets/presets; tracking alone is not approval.
const assets = new Set([
  'assets/brand/logo.png', 'assets/cards/default_Qingwu.json', 'assets/lorebooks/Mistvale.json',
]);
// Provenance is not expanded: only the existing tracked default is grandfathered.
const presets = new Set(['presets/\u9ed8\u8ba4.json']);
// Only these current guides are public. Nested docs and all other records stay local.
export const approvedDocumentation = new Set([
  'AGENTIC-RESEARCH.md', 'ARCHITECTURE-NOVEL-PLAY.md', 'ARCHITECTURE-OVERVIEW.md',
  'BRANCH-RELEASE-WORKFLOW.md', 'DATABASE-PLUGIN.md', 'DIRECTOR-ROOM.md',
  'DOCUMENTATION-INDEX.md', 'FORMAT-DELIVERY.md', 'GENERATION-MODES.md',
  'IMAGE-GENERATION-RETIREMENT.md', 'LOCAL-UPSTREAM-UPDATES.md', 'LOREBOOKS.md',
  'MODEL-CONNECTIONS.md', 'MVU.md', 'NOVEL-PLAY.md', 'NOVEL-PLAY-MAINTENANCE.md',
  'NPC-PARALLEL.md', 'PLAN-LIVING-ECOLOGY.md', 'PLAN-NOVEL-DIGEST.md',
  'PLAN-OUTLINE-SYSTEM.md', 'PLAN-ROUND-FLOW.md', 'PLAN-RP-MEMORY.md',
  'PLAN-RP-TOOLING.md', 'PLAN-WORLD-ENGINE.md',
  'PRESET-SPLIT-TAXONOMY.md', 'STANDALONE-INTEGRATION-BASELINE.md',
  'PRIVACY-AND-PUBLISHING.md', 'PROJECT-STRUCTURE.md', 'PROMPT-BUDGETS.md',
  'PROMPT-SOURCES.md', 'READING-THINKING.md', 'RECOVERY-AND-DIAGNOSTICS.md',
  'REQUEST-INSPECTOR.md', 'TAVERN-PLUGINS.md',
  'THIRD-PARTY-INSPIRATION.md', 'VERIDIS-REWRITE.md', 'WRITER-API-COMPATIBILITY.md',
]);

export function isLocalRecord(path) {
  return path === 'PUBLICATION.md' || (path.startsWith('docs/') && !approvedDocumentation.has(path.slice(5)));
}
const publicDiagnostics = new Set([
  '_privacy_scan.py', 'check-tavern-canary.mjs', 'deploy-agentic-research.sh',
  'probe-backstage.mjs', 'rename-paths-once.mjs', 'research-test-model.ts',
  'smoke-f34.mjs', 'smoke-web.mjs',
  'test-npc-parallel-integration.mjs', 'test-plugin-server-canary.mjs',
  'test-summary.mjs', 'test-tavern-native.mjs', 'test-veridis-rewrite-integration.mjs',
  'update-local.sh',
]);

export function pathCategory(path, tracked = false) {
  const parts = path.split('/');
  if (!path || parts.some(p => !p || p === '.' || p === '..') || /[\\\x00]/.test(path)) return 'invalid-path';
  if (isLocalRecord(path)) return 'local-record';
  // Redistribution of this upstream binary has not been cleared.
  if (path === 'packages/coding-agent/examples/extensions/doom-overlay/doom/build/doom.wasm') return 'excluded-third-party-asset';
  if (path === 'scripts/test-flash-sdk-transport.mjs') return 'local-diagnostic';
  // This exact SDK image fixture is public; root data/ and other data directories are not.
  if (path === 'packages/ai/test/data/red-circle.png' && tracked) return null;
  if (parts.some(p => /^(?:\.liyuan-|\.rp-|\.pi(?:$|[.-])|\.local(?:$|[.-])|\.backup(?:$|[.-])|\.git$|data$|node_modules$|\.?cache(?:s)?$|screenshots?$|\.env)/i.test(p)
    || /(?:^|[.-])(?:bak|backup|tmp|temp|swp|swo)(?:$|[.-])|~$/i.test(p)
    || /\.(?:pem|key|p12|pfx|sqlite(?:3)?|db|log)$/i.test(p)
    || /^(?:rp\.config[^/]*\.json|rp-preset\.json|rp\.agent(?:\.meta)?\.json|liyuan-profiles|liyuan\.(?:agent|agent\.meta|config)\.json|liyuan-preset\.json|auth\.json|network\.json)$/i.test(p))) return 'private-path';
  if (path === '.liyuan/extensions/roleplay.ts') return null;
  if (parts.includes('.liyuan')) return 'private-path';
  if (parts.length === 1) return roots.has(path) ? null : 'unapproved-root';
  if (parts[0] === 'assets') return assets.has(path) ? null : 'unapproved-asset';
  if (parts[0] === 'presets') return tracked && presets.has(path) ? null : 'unapproved-preset';
  if (parts[0] === 'licenses') return ['licenses/Luker-AGPL-3.0.txt', 'licenses/README.md'].includes(path) ? null : 'unapproved-license';
  if (parts[0] === 'scripts' && /(?:^|[-_/])(?:local|private|production|prod|ops|audit|inspect|capture|dump|diagnos\w*|probe|canary|drive|smoke|deploy|analyze|privacy_scan|rename|research-test|test-flash|test-plugin)(?:[-_.\/]|$)/i.test(path.slice(8))) {
    return tracked && publicDiagnostics.has(path.slice(8)) ? null : 'local-diagnostic';
  }
  return ['src', 'server', 'web', 'packages', 'docs', 'deploy', 'skills', 'test', 'scripts', '.github'].includes(parts[0]) ? null : 'unapproved-directory';
}

// Exact existing public binary paths only. No semantic secret/provenance scan of these
// binaries is claimed; changing their contents still requires human publication review.
const binaryBaseline = new Set([
  'assets/brand/logo.png',
  'packages/ai/test/data/red-circle.png',
  ...['src', 'dist'].map(n => `packages/coding-agent/${n}/modes/interactive/assets/clankolas.png`),
  ...['doom-extension', 'exy', 'interactive-mode', 'tree-view'].map(n => `packages/coding-agent/docs/images/${n}.png`),
  ...['darwin', 'native/darwin'].flatMap(n => ['arm64', 'x64'].map(a => `packages/tui/native/${n}/prebuilds/darwin-${a}/darwin-modifiers.node`)),
  ...['win32', 'native/win32'].flatMap(n => ['arm64', 'x64'].map(a => `packages/tui/native/${n}/prebuilds/win32-${a}/win32-console-mode.node`)),
  ...['public', 'dist'].flatMap(n => ['favicon', 'logo', 'logo-32', 'logo-64', 'logo-128', 'logo-180', 'logo-192', 'logo-256', 'logo-512', 'logo-maskable-192', 'logo-maskable-512'].map(a => `web/${n}/${a}.png`)),
]);
export function approvedBinary(path, tracked) { return tracked && binaryBaseline.has(path); }

// Exceptions match the entire value, never surrounding comments or arbitrary prefixes.
export function placeholder(value) {
  return /^(?:|\*+|\.{3}|<(?:API_KEY|TOKEN|PASSWORD|YOUR_API_KEY)>|\$\{[A-Z_][A-Z0-9_]*\}|YOUR[_ -](?:API[_ -]?KEY|TOKEN|PASSWORD)(?:_HERE)?|(?:your|example|dummy|fake|test|mock|synthetic|placeholder|redacted)(?:[-_](?:key|token|secret|password))?|(?:sk-)?(?:test|fake|dummy|example|placeholder)(?:-key)?|sk-\.{3})$/i.test(value);
}

// Existing adversarial regression literals, individually reviewed. These are exact
// value + path exceptions, not blanket test exemptions or comment-based suppression.
const syntheticTokens = new Map([
  ['test/agentic-production.test.ts', ['sk-proj-' + '1234567890ABCDEF']],
  ['test/research-privacy.test.ts', ['sk-proj-' + '1234567890abcdef']],
  ['test/web-research.test.ts', ['sk-proj-' + '1234567890ABCDEF']],
  ['test/repair-runtime.test.ts', ['sk-' + 'abcdefghijk123456789']],
]);
const syntheticUrls = new Map([
  ['test/database-plugin-source.test.ts', ['https://' + 'user:pass@gcore.jsdelivr.net']],
  ['test/mvu-managed-routing.test.ts', ['https://' + 'user:pass@parser.invalid']],
  ['test/mvu-model-list.test.ts', ['https://' + 'user:password@managed.invalid']],
  ['test/npc-parallel-source.test.ts', ['http://' + 'user:pass@proxy.example.invalid:7890']],
  ['test/veridis-rewrite-source.test.ts', ['http://' + 'user:pass@proxy.example.invalid:7890']],
  ['test/plugin-git-network.test.ts', ['http://' + 'user:synthetic-private-secret@127.0.0.1:9']],
  ['test/tavern-plugin-source.test.ts', ['http://' + 'fixture-user:fixture-pass@127.0.0.1:1']],
  ['test/web-research-network.test.ts', ['http://' + 'synthetic:credential@proxy.test:7890']],
  ['test/web-research.test.ts', ['https://' + 'a:private@example.org', 'https://' + 'user:secret@cn.bing.com']],
  ['test/web-source-reader.test.ts', ['https://' + 'me:pw@example.org', 'https://' + 'example.org@127.0.0.1']],
  ['test/web-source-transport.test.ts', ['http://' + '%zz:pw@127.0.0.1:1']],
]);

export function contentCategories(bytes, path, tracked) {
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { return approvedBinary(path, tracked) ? [] : ['binary-review-required']; }
  if (bytes.includes(0)) return approvedBinary(path, tracked) ? [] : ['binary-review-required'];
  const categories = new Set();
  if (/-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/.test(text)) categories.add('private-key');
  for (const m of text.matchAll(/\b(?:ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,}|sk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{20,})\b/g)) {
    if (!placeholder(m[0]) && !syntheticTokens.get(path)?.includes(m[0])) categories.add('credential-token');
  }
  for (const m of text.matchAll(/\b([a-z][a-z0-9+.-]*):\/\/([^\s/<>"'`@]+)@([^\s/<>"'`]+)/gi)) {
    if (m[1].toLowerCase() === 'ssh' && !m[2].includes(':')) continue;
    if (syntheticUrls.get(path)?.includes(m[0])) continue;
    const credentials = m[2].split(':');
    if (credentials.some(v => !placeholder(v))) categories.add('credential-url');
  }
  // Parse JSON rather than treating TS object declarations/regexes as saved credentials.
  // Source-code string literals are covered by high-confidence token/URL/PEM checks.
  try {
    const pending = [JSON.parse(text)];
    while (pending.length) {
      const value = pending.pop();
      if (!value || typeof value !== 'object') continue;
      for (const [key, item] of Object.entries(value)) {
        if (/^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|secret|token|authorization)$/i.test(key)
          && typeof item === 'string' && !placeholder(item)) categories.add('secret-json-field');
        if (item && typeof item === 'object') pending.push(item);
      }
    }
  } catch { /* Not a JSON document. */ }
  return [...categories];
}
