/* node test/agentid.test.js — the ONE agent-id law (sidecar/agentid.js): the id grammar PLUS the reserved names.

   An agent id resolves to WORKSPACES/<id>/ — the per-agent fs jail. The sidecar also creates non-agent directories
   directly under WORKSPACES (codex/ grok/ kimi/ token stores, connectors/ + channels/ secrets, plugins/, ...). An
   agent named `codex` would be jailed INSIDE the Codex token store and could read tokens.json through its own fs
   tools. This proves: (1) every grammar-spellable sibling index.js creates under WORKSPACES is reserved (the list
   cannot silently drift when a new station directory appears), (2) matching is case-insensitive (macOS/Windows
   filesystems are), (3) every surface an id enters — roster, run, delete, fs jail, save/workshop stores, config
   import — refuses a reserved id. Pure: no disk, no sidecar boot. */
'use strict';
const A = require('./_assert.js');
const fs = require('fs');
const path = require('path');
const { AGENT_ID_RE, RESERVED_AGENT_IDS, isReservedAgentId, isAgentId } = require('../sidecar/agentid.js');

const SIDECAR = path.join(__dirname, '..', 'sidecar');
const indexSrc = fs.readFileSync(path.join(SIDECAR, 'index.js'), 'utf8');

// ---- (1) the reserved set covers every grammar-spellable station directory index.js creates under WORKSPACES ----
{
  const literal = new Set();
  // every top-level sidecar module that joins a literal name onto the workspace root (index.js: WORKSPACES;
  // media-service.js: o.workspaces) — a new station directory anywhere in the sidecar must land in the reserved set.
  for (const f of fs.readdirSync(SIDECAR).filter(n => n.endsWith('.js'))) {
    const src = f === 'index.js' ? indexSrc : fs.readFileSync(path.join(SIDECAR, f), 'utf8');
    for (const m of src.matchAll(/join\((?:WORKSPACES|[A-Za-z_]+\.workspaces), '([^']+)'/g)) literal.add(m[1]);
  }
  const spellable = [...literal].filter(s => AGENT_ID_RE.test(s));   // dot-prefixed dirs and *.json files are unspellable
  A.ok(spellable.length >= 8, 'the sidecar creates grammar-spellable WORKSPACES siblings (found ' + spellable.length + ': ' + spellable.join(',') + ')');
  for (const s of spellable) A.ok(isReservedAgentId(s), 'grammar-spellable WORKSPACES sibling is reserved: ' + s);
  // the device-OAuth token stores live at WORKSPACES/<providerId>/tokens.json
  const oauthIds = (indexSrc.match(/const OAUTH_PROVIDER_IDS = \[([^\]]*)\]/) || [, ''])[1];
  const ids = [...oauthIds.matchAll(/'([^']+)'/g)].map(m => m[1]);
  A.ok(ids.length >= 2, 'OAUTH_PROVIDER_IDS enumerated (' + ids.join(',') + ')');
  for (const id of ids) A.ok(isReservedAgentId(id), 'OAuth token store dir is reserved: ' + id);
  A.ok(isReservedAgentId('codex'), 'the Codex token store dir is reserved');
  for (const r of RESERVED_AGENT_IDS) A.ok(AGENT_ID_RE.test(r), 'every reserved name is grammar-spellable (else it need not be listed): ' + r);
}

// ---- (2) the predicate: grammar AND not reserved, case-insensitively ----
{
  for (const good of ['agent', 'scout', 'lead-1', 'a_b', 'codex2', 'my-codex', 'x'.repeat(40)]) A.ok(isAgentId(good), 'accepts ordinary id: ' + good);
  for (const bad of ['codex', 'Codex', 'CODEX', 'grok', 'Kimi', 'connectors', 'CHANNELS', 'plugins', 'skill-packages', 'transcript-history-v2', '_archive', '_Archive', 'voice-cache', 'Voice-Cache']) {
    A.ok(!isAgentId(bad), 'refuses reserved id (any case): ' + bad);
    A.ok(isReservedAgentId(bad), 'isReservedAgentId names the reason: ' + bad);
  }
  for (const bad of ['', '../x', 'a b', 'x'.repeat(41), 123, null, undefined, {}]) A.ok(!isAgentId(bad), 'grammar still enforced: ' + JSON.stringify(bad));
  A.ok(!isReservedAgentId(null) && !isReservedAgentId(undefined) && !isReservedAgentId(''), 'isReservedAgentId is false for empty/nullish');
  A.ok(Object.isFrozen(RESERVED_AGENT_IDS), 'the reserved list is frozen');
}

// ---- (3) every surface an id enters applies the law ----
{
  // respond.isAgentId — the canonical helper index.js destructures for its routes
  const respond = require('../sidecar/respond.js');
  A.ok(respond.isAgentId('scout') && !respond.isAgentId('codex') && !respond.isAgentId('Connectors'), 'respond.isAgentId applies the reserved-name law');

  // the fs jail: safeAgentId is the gate in front of every fs.* tool path resolution
  const { makeFsTools } = require('../sidecar/tools/builtin/fs.js');
  const { _internals: fsI } = makeFsTools({ fsp: {}, pathMod: path, root: '/ws' });
  A.eq(fsI.safeAgentId('scout'), 'scout', 'fs jail accepts an ordinary id');
  A.throws(() => fsI.safeAgentId('codex'), 'fs jail refuses the codex token-store dir as an agent');
  A.throws(() => fsI.safeAgentId('CHANNELS'), 'fs jail refuses channels/ (case-insensitive)');

  // the save store: saveFile() validates before any read/write
  const { makeSaveStore } = require('../sidecar/savestore.js');
  const store = makeSaveStore({ fs: { readFileSync() { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }, writeFileSync() {}, renameSync() {}, existsSync() { return false; }, mkdirSync() {} }, pathMod: path, root: '/ws', clock: { now: () => 0 } });
  A.eq(store.load('scout'), undefined, 'save store loads an ordinary id (absent → undefined)');
  A.throws(() => store.load('codex'), 'save store refuses a reserved id');
  A.throws(() => store.save('Grok', { a: 1 }), 'save store refuses a reserved id on write (any case)');

  // the workshop store key → agentId
  const { _internals: wsI } = require('../sidecar/workshop-store.js');
  A.eq(wsI.agentIdOf('workshop:scout'), 'scout', 'workshop store accepts an ordinary id');
  A.throws(() => wsI.agentIdOf('workshop:codex'), 'workshop store refuses a reserved id');

  // config import: a reserved roster entry is dropped, an ordinary one survives
  const C = require('../sidecar/configexport.js');
  const env = C.buildExport({ roster: [
    { agentId: 'lead', name: 'Lead', model: 'x/y', provider: 'openrouter', role: 'boss' },
    { agentId: 'codex', name: 'Sneaky', model: 'x/y', provider: 'openrouter', role: 'thief' }
  ] });
  env.sections.roster = (env.sections.roster || []).concat([{ agentId: 'Connectors', name: 'Sneaky2', model: 'x/y', provider: 'openrouter', role: 'thief' }]);
  const p = C.parseImport(env);
  A.ok(p.ok, 'parseImport accepts the envelope');
  const imported = ((p.sections && p.sections.roster) || []).map(a => a.agentId);
  A.ok(imported.indexOf('lead') >= 0, 'config import keeps the ordinary roster entry');
  A.ok(imported.indexOf('codex') < 0 && imported.indexOf('Connectors') < 0, 'config import drops reserved roster ids: ' + JSON.stringify(imported));

  // index.js: the roster push names the reason, and the on-disk roster / delete / run entry points use the ONE predicate
  const roster = A.fnBody(indexSrc, 'async function handleRoster(');
  A.ok(/isReservedAgentId\(a\.agentId\)/.test(roster) && /is reserved/.test(roster), 'POST roster refuses a reserved agentId with a clear 400 reason');
  A.ok(/isAgentId\(id\)/.test(A.fnBody(indexSrc, 'function replaceAgentRoster(')), 'an on-disk roster cannot smuggle a reserved id in');
  A.ok(/isAgentId\(agentId\)/.test(A.fnBody(indexSrc, 'async function handleAgentDelete(')), 'agent delete uses the one id law');
  A.ok(/isAgentId\(String\(agentId\)\)/.test(A.fnBody(indexSrc, 'async function handleRun(')), 'POST /api/run refuses a reserved agentId before any provider work');

  // DRIFT GUARD: the raw grammar regex may gate only the two sites that are not an agent-id law by themselves —
  // the connector-id route and the roster's string-type pre-check (which then names the reserved reason itself).
  // Every other agent-id entry point in index.js (file/save/checkpoint/snapshot/notes/cron/channel/orchestration
  // routes, the browser download dir, the stdio MCP binding) goes through the ONE predicate.
  const rawGates = indexSrc.split('\n').filter(l => l.indexOf('/^[A-Za-z0-9_-]{1,40}$/.test(') >= 0);
  A.eq(rawGates.length, 2, 'index.js keeps exactly two raw-grammar gates (connector id + roster pre-check), found ' + rawGates.length);
  A.ok(rawGates.every(l => /connector id/.test(l) || /typeof a\.agentId !== 'string'/.test(l)),
    'no other agent-id entry point in index.js bypasses isAgentId(): ' + rawGates.map(l => l.trim().slice(0, 60)).join(' | '));
}

A.report('agentid.test');
