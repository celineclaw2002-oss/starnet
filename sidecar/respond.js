/* sidecar/respond.js — tiny shared HTTP response/validation helpers for index.js routes.

   index.js grew ~95 per-handler copies of the same three-line `json(code, obj)` closure (plus
   `sendJson` variants) and a dozen copies of the agent-id regex. This module is the ONE canonical
   copy, adopted INCREMENTALLY: new routes and touched handlers rebind their local closure to
   `json(res, ...)` here; untouched handlers keep their inline copy until a change brings them in.
   (Mass-migrating all of index.js at once is deliberately avoided — many parallel branches merge
   into that file, and a 95-site sweep would conflict with all of them.)

     json(res, code, obj)                 — application/json + no-store; no-op once headersSent
     readJsonBody(req, readBody, max, res)-> parsed body ({} for empty/null) | null on bad JSON /
                                            read failure. Pass index.js's own readBody in (it owns
                                            the 413-too-large answer when res is provided).
     isAgentId(s)                         — the ID_RE shape every roster/cron/orchestration route
                                            enforces on agent ids (defense in depth over the fs jail).

   Pure over (res, req) — no fs, no stores, no secrets; nothing here may synthesize state
   (truthful telemetry applies to JSON, not just pixels). */
'use strict';

// The canonical agent-id shape (ID_RE across roster/cron/orchestration surfaces): a crafted id
// must not be able to key outside its own workspace/checkpoint/grant lane.
// Grammar AND the reserved sibling-directory names (codex, connectors, channels, ...) — see sidecar/agentid.js.
const { AGENT_ID_RE, isAgentId } = require('./agentid.js');

// One JSON answer, exactly like the inline closures it replaces: no-store (telemetry must never
// cache-lie), and a silent no-op when headers already went out (e.g. readBody answered 413 first).
function json(res, code, obj) {
  if (res.headersSent) return;
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// Parse-or-null body reader matching the `JSON.parse(await readBody(...)) || {}` pattern used by
// every POST handler. Returns {} for an empty/`null` body (the existing `|| {}`), and null on ANY
// failure (bad JSON, or a readBody rejection — incl. 413 too-large, which readBody itself already
// answered when `res` was passed; the caller's json() no-ops after that thanks to the guard above).
async function readJsonBody(req, readBody, max, res) {
  try {
    const raw = await readBody(req, max, res);
    return String(raw == null ? '' : raw).trim() ? (JSON.parse(raw) || {}) : {};
  }
  catch (_) { return null; }
}

module.exports = { json, readJsonBody, isAgentId };
