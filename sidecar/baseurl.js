/* sidecar/baseurl.js — the ONE base-URL law for provider endpoints and channel service URLs.

   A base URL carries a credential on every request (a bearer key, an x-api-key, a Matrix access token), so a
   user-supplied endpoint is accepted only when the transport can keep that credential private:
     - https://  to any host, or
     - http://   only to the local machine — 127.0.0.1, localhost or [::1] — where the bytes never leave the box.
   Embedded user:pass@ credentials are refused outright (they would be logged, echoed and exported with the URL).
   An EMPTY value is not a problem: it means "no explicit endpoint" and the caller keeps its own default.

   Pure (no fs, no network). index.js applies it at every route that accepts an endpoint (answering 400 with the
   message), and the provider adapters apply it again when they are constructed, so an endpoint saved before this
   law — or one arriving through a path no route guards — still refuses loudly instead of leaking. */
'use strict';

function isLoopbackHost(hostname) {
  let h = String(hostname || '').toLowerCase();
  if (h.charAt(0) === '[') h = h.slice(1, -1);   // WHATWG keeps the brackets on an IPv6 hostname
  else h = h.replace(/\.+$/, '');                 // fold the FQDN root label: `localhost.` is `localhost`
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

// '' when the value is acceptable (or empty), else one plain sentence a settings screen can show as-is.
function baseUrlProblem(raw, label) {
  const what = label || 'base URL';
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch (_) { return what + ' must be an absolute URL starting with https:// (or http:// for 127.0.0.1, localhost or [::1])'; }
  if (u.username || u.password) return what + ' must not embed credentials (user:pass@) — put the key in its own field';
  if (u.protocol === 'https:') return '';
  if (u.protocol === 'http:') return isLoopbackHost(u.hostname) ? '' : what + ' must use https:// — plain http:// is allowed only for 127.0.0.1, localhost or [::1]';
  return what + ' must use https:// (got ' + u.protocol + ')';
}

function assertBaseUrl(raw, label) {
  const problem = baseUrlProblem(raw, label);
  if (problem) { const e = new Error(problem); e.code = 'bad_base_url'; e.status = 400; throw e; }
  return String(raw == null ? '' : raw).trim();
}

// The adapters' normalizer: trim, drop trailing slashes, fall back to the adapter default, then apply the law.
// An empty result stays empty (an endpointless adapter must refuse loudly later, never reroute).
function cleanBaseUrl(value, fallback) {
  const s = String(value || fallback || '').trim().replace(/\/+$/, '');
  if (s) assertBaseUrl(s);
  return s;
}

module.exports = { isLoopbackHost, baseUrlProblem, assertBaseUrl, cleanBaseUrl };
