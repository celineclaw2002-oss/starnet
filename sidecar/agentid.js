/* sidecar/agentid.js — the ONE agent-id law: the id grammar plus the RESERVED names an agent may never take.

   An agent id resolves to WORKSPACES/<id>/ — the per-agent fs jail behind fs.* tools, /api/file, /api/save,
   attachments, deliverables and checkpoints. The sidecar also creates NON-agent directories directly under
   WORKSPACES that the same grammar can spell: codex/, grok/, kimi/ (OAuth token stores), connectors/ and
   channels/ (secrets), plugins/, skill-packages/, transcript-history-v2/, _archive/ and (media-service.js)
   voice-cache/. An agent named `codex`
   would be jailed INSIDE the Codex token store and could read tokens.json through its own fs tools or through
   /api/file?agent=codex. Dot-prefixed siblings (.secrets, .browser-profile, .run-journal) are unspellable by the
   grammar already; sibling FILES all carry an extension the grammar forbids.

   Matching is case-insensitive because the default macOS and Windows filesystems are.
   Pure (no fs, no clock, no rng): index.js, the fs jail, the save/workshop stores and configexport import it. */
'use strict';

const AGENT_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const RESERVED_AGENT_IDS = Object.freeze([
  'codex', 'grok', 'kimi',                    // WORKSPACES/<provider>/tokens.json — OAuth token stores
  'connectors', 'channels',                   // MCP connector + channel secrets
  'plugins', 'skill-packages',                // installed code the harness executes
  'transcript-history-v2', '_archive',        // station transcripts; archived agents' whole jails
  'voice-cache'                               // media-service.js: the synthesized-voice / Transformers model cache
]);
const RESERVED = new Set(RESERVED_AGENT_IDS);

function isReservedAgentId(id) { return RESERVED.has(String(id == null ? '' : id).toLowerCase()); }
// grammar AND not reserved — the single predicate every id-accepting surface uses.
function isAgentId(id) { return typeof id === 'string' && AGENT_ID_RE.test(id) && !RESERVED.has(id.toLowerCase()); }

module.exports = { AGENT_ID_RE, RESERVED_AGENT_IDS, isReservedAgentId, isAgentId };
