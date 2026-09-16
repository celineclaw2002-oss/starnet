/* sidecar/tools/builtin/fs.js — the CABINET capability: fs.read / fs.write / fs.list /
   fs.append / fs.edit / fs.search, jailed to <root>/<agentId>/. The path guard is the
   security spine: every model- or user-supplied path is resolved and PROVEN to stay inside
   the agent's workspace before any I/O. Node-only (node:path + node:fs/promises injected for
   testability). Matches the notebook.js / web.js tool shape.

   makeFsTools({ fsp, pathMod, root, limits }) -> { writeTool, readTool, listTool, register(reg) }
     fsp     : node:fs/promises (injectable)
     pathMod : node:path        (injectable)
     root    : absolute path to .../workspaces
     limits  : { writeBytes=1<<20, readReturn=200_000 } */
'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.SK = root.SK || {}; root.SK.tools = root.SK.tools || {}; (root.SK.tools.builtin = root.SK.tools.builtin || {}).fs = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const { parsePatch, hunkOldText, hunkNewText, addText } = require('./patchparse.js');
  const { fuzzyFindAndReplace } = require('./fuzzymatch.js');
  const crypto = require('node:crypto');

  const { isAgentId } = require('../../agentid.js');   // grammar + the reserved sibling-dir names (codex, connectors, ...)
  function safeAgentId(id) {
    if (!isAgentId(id || '')) throw new Error('bad agentId');
    return id;
  }
  function kb(n) { return n < 1024 ? n + ' B' : (n / 1024).toFixed(1) + ' KB'; }
  function emitDeliverable(ctx, aid, pathStr) {
    if (!ctx || typeof ctx.emit !== 'function') return;
    const d = { id: 'file_' + String(pathStr).replace(/[^A-Za-z0-9_.-]/g, '_'), agentId: aid, kind: 'file', title: String(pathStr) };
    if (ctx.room) d.room = ctx.room;
    ctx.emit('deliverable', d);
  }

  function makeFsTools(deps) {
    deps = deps || {};
    const fsp = deps.fsp, P = deps.pathMod, ROOT = deps.root, environment = deps.environment || null;
    if (!fsp || !P || (!ROOT && !environment)) throw new Error('fs.js requires { fsp, pathMod, root } or { fsp, pathMod, environment }');
    const WRITE_BYTES = (deps.limits && deps.limits.writeBytes) || (1 << 20);
    const READ_RETURN = (deps.limits && deps.limits.readReturn) || 200000;
    const redact = deps.redact || ((s) => s);   // §5.6: scrub secrets out of any surfaced search line (optional, default identity)
    // NS-5 CONVERSATIONAL PATH TRUST (optional): the ONE sanctioned way an fs call may reference a path
    // OUTSIDE the agent jail. Injected async guard(absPath, { scope, agentId, ctx }) -> { base, abs } | throws.
    // Wired only for the run registry (index.js). UNWIRED (the /api/file jail helper, tests) means the
    // historic behavior — every absolute path is illegal — so those surfaces stay locked to the jail.
    const pathTrust = typeof deps.pathTrust === 'function' ? deps.pathTrust : null;
    // OPTIONAL document-to-text for fs.read (.docx / .xlsx / .ipynb). Unwired = the historic behavior, where
    // those files decode as UTF-8 noise. index.js wires it with zlib.inflateRawSync.
    const docExtract = (deps.docExtract && typeof deps.docExtract.sniff === 'function') ? deps.docExtract : null;
    const imageWire = (deps.imageWire && typeof deps.imageWire.sniff === 'function') ? deps.imageWire : null;
    // Optional host-owned LSP provider. The fs tools own the mutation boundary, so they are the only place
    // that can guarantee a diagnostic baseline was captured before bytes changed. Unwired callers (the
    // route jail helper and focused fs tests) keep the historic byte-identical path.
    const editDiagnostics = deps.editDiagnostics
      && typeof deps.editDiagnostics.beginEdit === 'function'
      && typeof deps.editDiagnostics.finishEdit === 'function'
      ? deps.editDiagnostics : null;

    function sha256(data) {
      return data == null ? null : crypto.createHash('sha256').update(data).digest('hex');
    }
    function sameBytes(a, b) {
      if (a == null || b == null) return a == null && b == null;
      return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.equals(b);
    }
    async function readBytesOrMissing(abs) {
      try { return await fsp.readFile(abs); }
      catch (e) { if (e && e.code === 'ENOENT') return null; throw e; }
    }
    function receiptLine(receipt) {
      return '[mutation receipt: ' + receipt.state + '; attempted ' + receipt.attemptedBytes + ' bytes; written '
        + receipt.writtenBytes + '; verified ' + receipt.verifiedBytes + '; sha256 ' + (receipt.sha256 || 'deleted') + ']';
    }
    function receiptError(message, receipt) {
      const error = new Error(message + ' ' + receiptLine(receipt));
      error.mutationReceipt = receipt;
      // Alias retained for callers that use the shorter generic receipt field.
      error.receipt = receipt;
      return error;
    }
    async function verifiedMutation(spec) {
      const expected = spec.expected == null ? null : Buffer.from(spec.expected);
      const initial = spec.initial == null ? null : Buffer.from(spec.initial);
      const receipt = {
        operation: String(spec.operation), path: String(spec.path), state: 'attempted',
        phases: ['attempted'], attemptedBytes: expected ? expected.length : 0,
        writtenBytes: 0, verifiedBytes: 0, sha256: sha256(expected), actualSha256: null
      };
      try {
        await spec.mutate();
        receipt.state = 'written';
        receipt.phases.push('written');
        receipt.writtenBytes = expected ? expected.length : 0;
        const actual = await readBytesOrMissing(spec.abs);
        receipt.actualSha256 = sha256(actual);
        if (!sameBytes(actual, expected)) throw new Error('read-back bytes differ from the intended mutation');
        receipt.state = 'read-back-verified';
        receipt.phases.push('read-back-verified');
        receipt.verifiedBytes = expected ? expected.length : 0;
        return receipt;
      } catch (cause) {
        let actual = null, inspectFailed = null;
        try { actual = await readBytesOrMissing(spec.abs); } catch (e) { inspectFailed = e; }
        receipt.actualSha256 = inspectFailed ? null : sha256(actual);
        if (!inspectFailed && sameBytes(actual, expected)) {
          receipt.state = 'read-back-verified';
          if (receipt.phases.indexOf('written') < 0) receipt.phases.push('written');
          if (receipt.phases.indexOf('read-back-verified') < 0) receipt.phases.push('read-back-verified');
          receipt.writtenBytes = expected ? expected.length : 0;
          receipt.verifiedBytes = expected ? expected.length : 0;
          return receipt;
        }
        receipt.state = !inspectFailed && !sameBytes(actual, initial) ? 'partially-applied' : 'failed';
        receipt.phases.push(receipt.state);
        receipt.writtenBytes = actual ? actual.length : 0;
        throw receiptError('filesystem mutation ' + receipt.state + ' for ' + spec.path + ': ' + ((cause && cause.message) || cause), receipt);
      }
    }

    async function workspaceRoot(agentId) {
      if (environment && typeof environment.ensureWorkspace === 'function') return environment.ensureWorkspace(safeAgentId(agentId || 'agent'));
      const dir = P.join(ROOT, safeAgentId(agentId || 'agent'));
      await fsp.mkdir(dir, { recursive: true });
      return dir;
    }
    function pathInside(abs, base) {
      let a = P.resolve(abs), b = P.resolve(base);
      if (P.sep === '\\') { a = a.toLowerCase(); b = b.toLowerCase(); }
      return a === b || a.indexOf(b + P.sep) === 0;
    }
    async function realpathOrSelf(p) {
      try { return await fsp.realpath(p); } catch (_) { return p; }
    }
    async function deepestExisting(abs, base) {
      let cur = abs;
      for (;;) {
        try { await fsp.lstat(cur); return cur; }
        catch (e) {
          const parent = P.dirname(cur);
          if (!parent || parent === cur) return base;
          cur = parent;
        }
      }
    }
    async function checkpointResolvedRoot(base, opts) {
      const ctx = opts && opts.ctx;
      if (!ctx || typeof ctx.checkpointMutation !== 'function' || (opts && opts.scope) !== 'write') return;
      try { await ctx.checkpointMutation(base, 'fs mutation', { resolvedRoot: true }); } catch (_) {}
    }
    // Resolve a path and PROVE it is reachable. A relative path in a host-validated project session is rooted
    // at that exact project, not at the agent's private deliverables workspace. It still passes through the
    // same path-trust guard as an absolute project path and gets a second symlink-containment proof, so a
    // model cannot manufacture ctx.projectRoot or escape it through a link. Unscoped relative paths retain the
    // historic per-agent jail. Absolute paths always use pathTrust. opts.scope ('read' | 'write') is threaded
    // to the guard so writes can stay consent-gated; opts.ctx is passed through.
    async function resolveInside(agentId, rel, opts) {
      opts = opts || {};
      rel = String(rel == null ? '' : rel);
      if (rel.indexOf('\0') >= 0) throw new Error('illegal path: ' + rel);
      // Absolute on EITHER platform: posix "/abs", win32 "C:\..." AND UNC "\\server\share" (host
      // P.isAbsolute alone misses UNC when running on Linux). Routed to path-trust when wired, else illegal.
      const isAbs = P.win32.isAbsolute(rel) || P.posix.isAbsolute(rel) || /^[A-Za-z]:/.test(rel);
      if (isAbs) {
        if (!pathTrust) throw new Error('illegal path: ' + rel);
        const resolved = await pathTrust(rel, { scope: opts.scope === 'write' ? 'write' : 'read', agentId: agentId, ctx: opts.ctx });
        await checkpointResolvedRoot(resolved && resolved.base, opts);
        return resolved;
      }
      if (/(^|[\\/])\.\.([\\/]|$)/.test(rel)) throw new Error('illegal path: ' + rel);
      const projectRoot = opts.ctx && typeof opts.ctx.projectRoot === 'string'
        ? String(opts.ctx.projectRoot).trim() : '';
      if (projectRoot) {
        if (!pathTrust) throw new Error('project-relative path requires the project trust guard');
        const base = P.resolve(projectRoot);
        const abs = P.resolve(base, rel || '.');
        if (!pathInside(abs, base)) throw new Error('path escapes project root');
        // Selecting a relative base is not authority: re-run the station grant and protected-file floor for
        // every resolved target, just as an explicit absolute path would.
        await pathTrust(abs, { scope: opts.scope === 'write' ? 'write' : 'read', agentId: agentId, ctx: opts.ctx });
        const baseReal = await realpathOrSelf(base);
        const existing = await deepestExisting(abs, base);
        const existingReal = await realpathOrSelf(existing);
        if (!pathInside(existingReal, baseReal)) throw new Error('path escapes project root via symlink');
        await checkpointResolvedRoot(base, opts);
        return { base, abs };
      }
      const base = await workspaceRoot(agentId);
      const abs = P.resolve(base, rel || '.');
      if (!pathInside(abs, base)) throw new Error('path escapes workspace');
      const baseReal = await realpathOrSelf(base);
      const existing = await deepestExisting(abs, base);
      const existingReal = await realpathOrSelf(existing);
      if (!pathInside(existingReal, baseReal)) throw new Error('path escapes workspace via symlink');
      await checkpointResolvedRoot(base, opts);
      return { base, abs };
    }

    async function beginEditDiagnostics(aid, files, ctx) {
      if (!editDiagnostics) return null;
      try { return await editDiagnostics.beginEdit({ agentId: aid, files, signal: ctx && ctx.signal }); }
      catch (e) {
        // The new baseline wait must not turn an already-cancelled tool into a late file mutation. Other LSP
        // failures degrade honestly; cancellation keeps the ordinary registry abort semantics.
        if (e && e.name === 'AbortError') throw e;
        return { failedAtBaseline: String((e && e.message) || e), items: [], unavailable: [], unsupported: [] };
      }
    }
    function diagnosticLine(d) {
      const where = String(d.file || '?') + ':' + String(d.line || 1) + ':' + String(d.col || 1);
      return where + (d.code ? ' [' + d.code + ']' : '') + ' ' + String(d.message || 'diagnostic');
    }
    async function finishEditDiagnostics(ticket, result, ctx) {
      if (!editDiagnostics || !ticket) return result;
      let delta;
      if (ticket.failedAtBaseline) {
        delta = { status: 'unavailable', reason: ticket.failedAtBaseline, added: [], removed: [], addedCount: 0, removedCount: 0 };
      } else {
        try { delta = await editDiagnostics.finishEdit(ticket, { signal: ctx && ctx.signal }); }
        catch (e) { delta = { status: 'unavailable', reason: String((e && e.message) || e), added: [], removed: [], addedCount: 0, removedCount: 0 }; }
      }
      result.diagnostics = delta;
      if (delta.status === 'available' || delta.status === 'partial') {
        const rows = (delta.added || []).slice(0, 12).map(diagnosticLine);
        let note = delta.addedCount
          ? 'LSP: ' + delta.addedCount + ' new diagnostic' + (delta.addedCount === 1 ? '' : 's') + '\n' + rows.join('\n')
          : 'LSP: no new diagnostics';
        if (delta.removedCount) note += '\nLSP: ' + delta.removedCount + ' pre-existing diagnostic' + (delta.removedCount === 1 ? '' : 's') + ' cleared';
        if (delta.status === 'partial') note += '\nLSP: some edited files were not confirmed; run verify.run for the full project check';
        result.content += '\n\n[' + note + ']';
        try {
          if (ctx && typeof ctx.emit === 'function') ctx.emit('verify.result', {
            agentId: (ctx && ctx.agentId) || 'agent', runId: ctx.runId || '', tool: 'language server',
            passed: delta.addedCount === 0, added: delta.addedCount, removed: delta.removedCount,
            summary: delta.addedCount ? delta.addedCount + ' new language-server diagnostic(s)' : 'no new language-server diagnostics'
          });
        } catch (_) {}
      } else {
        const why = String(delta.reason || (delta.status === 'unsupported'
          ? 'no detected language server supports this file type'
          : 'language-server diagnostics were unavailable'));
        result.content += '\n\n[LSP unavailable: ' + why + '. Run verify.run for project-level proof.]';
      }
      return result;
    }

    /* STALE-WRITE GUARD (2026-07-27). A delegated worker, a second agent, or the Commander's own editor can
       change a file between the moment this agent READ it and the moment it writes back. Nothing here noticed,
       so the write silently reverted the other change — the classic lost update, and the harder kind to spot
       because both sides believe they succeeded.

       SCOPED TO fs.write ON PURPOSE, after tracing what each writer actually does:
         · fs.append reads the file and appends to what it FINDS, so a concurrent change survives.
         · fs.edit reads fresh and replaces an exact `find`; a drifted file either still matches (the edit
           lands on the NEW text, which is right) or misses and errors honestly.
         · fs.patch validates every hunk's context against current content before writing anything.
       All three are read-modify-write inside ONE call and cannot clobber. fs.write is the only writer that
       replaces a whole file with content composed from a read that may now be old — so it is the only one
       that needs a stamp, and guarding the others would only manufacture false refusals.

       A file this agent never read has no stamp and is never refused: writing a file you did not read is
       "create it", not "clobber it". One refusal per drift — the stamp is dropped so the required re-read
       re-arms it, and the agent can never be stuck in a loop it has no way to satisfy. */
    const readStamps = new Map();   // agentId \0 abs -> the mtime this agent last SAW
    const stampKey = (aid, abs) => String(aid) + '\0' + (P.sep === '\\' ? String(abs).toLowerCase() : String(abs));
    async function mtimeOf(abs) { try { const st = await fsp.stat(abs); return Number(st.mtimeMs || 0) || 0; } catch (_) { return 0; } }
    async function stampSeen(aid, abs) {
      const m = await mtimeOf(abs);
      if (m) readStamps.set(stampKey(aid, abs), m); else readStamps.delete(stampKey(aid, abs));
    }
    async function assertFresh(aid, abs, rel) {
      const key = stampKey(aid, abs);
      const seen = readStamps.get(key);
      if (!seen) return;                          // never read here -> nothing to be stale against
      const now = await mtimeOf(abs);
      if (!now || now <= seen) return;            // deleted since, or untouched since we looked
      readStamps.delete(key);                     // one refusal per drift; the re-read below re-arms it
      const error = new Error('stale write refused: ' + rel + ' changed on disk after you read it — someone else (another agent, or the Commander) edited it. Read it again and re-apply your change on top of the current content, or use fs.edit/fs.patch so your change merges instead of replacing the file.');
      error.precondition = { code: 'fresh_read_required', requiredTool: 'fs.read', requiredState: 'current_file_observed' };
      throw error;
    }

    const writeTool = {
      name: 'fs.write', capability: 'cabinet', scope: 'write', requiresConsent: true, timeoutMs: 10000,
      description: 'Write a UTF-8 text file into the current project folder when this session is project-scoped, otherwise into your private workspace. This is where your deliverables (reports, notes, code) are saved.',
      schema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } },
      run: async (args, ctx) => {
        const aid = (ctx && ctx.agentId) || 'agent';
        const { abs, base } = await resolveInside(aid, args.path, { scope: 'write', ctx });
        const data = Buffer.from(String(args.content), 'utf8');
        if (data.length > WRITE_BYTES) throw new Error('file too large (' + data.length + ' > ' + WRITE_BYTES + ' bytes)');
        await assertFresh(aid, abs, args.path);   // refuse to overwrite a file that moved under us
        let beforeBytes = null;
        try { beforeBytes = await fsp.readFile(abs); } catch (e) { if (!(e && e.code === 'ENOENT')) throw e; }
        const diagnosticTicket = await beginEditDiagnostics(aid, [{ abs, base, rel: String(args.path), text: beforeBytes ? beforeBytes.toString('utf8') : '' }], ctx);
        await fsp.mkdir(P.dirname(abs), { recursive: true });
        const receipt = await verifiedMutation({ operation: 'write', path: args.path, abs, expected: data, initial: beforeBytes, mutate: () => fsp.writeFile(abs, data) });
        await stampSeen(aid, abs);                // our own write is the new baseline, so a rewrite never self-trips
        emitDeliverable(ctx, aid, args.path);
        return finishEditDiagnostics(diagnosticTicket,
          { content: 'Wrote ' + args.path + ' (' + data.length + ' bytes).\n' + receiptLine(receipt), summary: 'wrote ' + args.path + ' (' + kb(data.length) + ')', mutationReceipt: receipt, receipt }, ctx);
      }
    };

    const readTool = {
      name: 'fs.read', capability: 'cabinet', scope: 'read', requiresConsent: false, timeoutMs: 10000,
      description: 'Read a file from the current project folder when this session is project-scoped, otherwise from your private workspace. Text files come back as text; for large text use offset and limit to page character ranges without rerunning the command that produced the file. Word (.docx), Excel (.xlsx) and Jupyter (.ipynb) files are extracted to readable text automatically; PNG/JPEG/GIF/WEBP images are shown to you as actual pixels so you can look at them directly.',
      schema: { type: 'object', required: ['path'], properties: { path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } } },
      run: async (args, ctx) => {
        const aid = (ctx && ctx.agentId) || 'agent';
        const { abs } = await resolveInside(aid, args.path, { scope: 'read', ctx });
        let raw;
        try { raw = await fsp.readFile(abs); }
        catch (e) { if (e && e.code === 'ENOENT') throw new Error('no such file: ' + args.path); throw e; }
        await stampSeen(aid, abs);   // what this agent believes the file says, as of now (see the stale-write guard)

        /* DOCUMENTS. Decoding a .docx as UTF-8 produced binary noise: the agent could see the file existed and
           had no way to read it, on exactly the formats a Commander keeps real work in. A malformed or
           mislabelled document falls THROUGH to the plain text path rather than failing the read — a file
           someone named .docx that is really text must still be readable. */
        const kind = docExtract ? docExtract.sniff(args.path, raw) : null;
        if (kind) {
          try {
            const text = docExtract.extract(raw, kind, { maxChars: READ_RETURN });
            if (text) return { content: text, summary: kind + ' → ' + kb(Buffer.byteLength(text)) + ' of text' };
          } catch (_) { /* fall through to the plain read below */ }
        }

        /* IMAGES. Same shape as documents, same reason: the bytes are unreadable as UTF-8, so without
           this the agent could see a screenshot existed and had no way to look at it — including the
           output of its OWN image_generate call. image_analyze routes the picture to a SEPARATE vision
           model and returns prose, which steers the driving model off a description of the pixels
           instead of the pixels. Here they ride the `images` channel into the conversation itself.
           Sniffed by magic bytes, so a mislabelled file falls through to the plain read below. */
        if (imageWire) {
          const img = imageWire.sniff(args.path, raw);
          if (img) {
            const wire = imageWire.toWire(raw, img);
            const desc = imageWire.describe(img, args.path);
            return {
              content: desc + (wire.note ? '\n' + wire.note : (wire.images ? '' : '')),
              summary: img.ext + ' ' + (img.width && img.height ? img.width + '×' + img.height : kb(img.bytes)),
              images: wire.images
            };
          }
        }

        const txt = raw.toString('utf8');
        const offset = Math.min(txt.length, Math.max(0, Math.floor(Number(args.offset) || 0)));
        const requested = args.limit == null ? READ_RETURN : Math.floor(Number(args.limit) || 0);
        if (requested <= 0) throw new Error('limit must be a positive number');
        const limit = Math.min(READ_RETURN, requested);
        const end = Math.min(txt.length, offset + limit);
        let out = txt.slice(offset, end);
        if (end < txt.length) out += '\n[showing characters ' + offset + '-' + end + ' of ' + txt.length
          + '; next: fs.read {"path":' + JSON.stringify(String(args.path)) + ',"offset":' + end + ',"limit":' + limit + '}]';
        else if (offset > 0) out += '\n[showing characters ' + offset + '-' + end + ' of ' + txt.length + '; end of file]';
        return { content: out, summary: kb(Buffer.byteLength(txt)) + ' read; characters ' + offset + '-' + end + ' of ' + txt.length };
      }
    };

    // recursive directory walk -> relative paths (dirs end with '/'), bounded so a huge tree can't flood the prompt
    async function walk(absDir, prefix, out, limit) {
      if (out.length >= limit) return;
      let entries;
      try { entries = await fsp.readdir(absDir, { withFileTypes: true }); }
      catch (e) { if (e && e.code === 'ENOENT') return; throw e; }
      for (const ent of entries) {
        if (out.length >= limit) { out.push('…[truncated]'); return; }
        const rel = prefix ? (prefix + '/' + ent.name) : ent.name;
        if (ent.isDirectory()) { out.push(rel + '/'); await walk(P.join(absDir, ent.name), rel, out, limit); }
        else out.push(rel);
      }
    }

    const listTool = {
      name: 'fs.list', capability: 'cabinet', scope: 'read', requiresConsent: false, timeoutMs: 8000,
      description: 'List files in your workspace. Pass { "recursive": true } to see the whole tree (directories end with "/"); optional "path" lists one subdirectory.',
      schema: { type: 'object', properties: { path: { type: 'string' }, recursive: { type: 'boolean' } } },
      run: async (args, ctx) => {
        const { abs } = await resolveInside((ctx && ctx.agentId) || 'agent', (args && args.path) || '.', { scope: 'read', ctx });
        if (args && args.recursive) {
          const out = []; await walk(abs, '', out, 500);
          return { content: out.length ? out.join('\n') : '(empty)', summary: out.length + ' entr' + (out.length === 1 ? 'y' : 'ies') };
        }
        let names;
        try { names = await fsp.readdir(abs); }
        catch (e) { if (e && e.code === 'ENOENT') return { content: '(empty)', summary: '0 files' }; throw e; }
        return { content: names.length ? names.join('\n') : '(empty)', summary: names.length + ' file(s)' };
      }
    };

    const appendTool = {
      name: 'fs.append', capability: 'cabinet', scope: 'write', requiresConsent: true, timeoutMs: 10000,
      description: 'Append UTF-8 text to a workspace file (creates it if missing) WITHOUT rewriting what is already there. Use this to add to a file you are building up.',
      schema: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } },
      run: async (args, ctx) => {
        const aid = (ctx && ctx.agentId) || 'agent';
        const { abs, base } = await resolveInside(aid, args.path, { scope: 'write', ctx });
        let existingBytes = null;
        try { existingBytes = await fsp.readFile(abs); } catch (e) { if (!(e && e.code === 'ENOENT')) throw e; }
        const existing = existingBytes ? existingBytes.toString('utf8') : '';
        const combined = existing + String(args.content);
        const bytes = Buffer.byteLength(combined, 'utf8');
        if (bytes > WRITE_BYTES) throw new Error('file too large after append (' + bytes + ' > ' + WRITE_BYTES + ' bytes)');
        const diagnosticTicket = await beginEditDiagnostics(aid, [{ abs, base, rel: String(args.path), text: existing }], ctx);
        await fsp.mkdir(P.dirname(abs), { recursive: true });
        const expected = Buffer.from(combined, 'utf8');
        const receipt = await verifiedMutation({ operation: 'append', path: args.path, abs, expected, initial: existingBytes, mutate: () => fsp.writeFile(abs, expected) });
        await stampSeen(aid, abs);   // our own append is the new baseline — a later fs.write must not read as a third-party race
        emitDeliverable(ctx, aid, args.path);
        const added = Buffer.byteLength(String(args.content), 'utf8');
        return finishEditDiagnostics(diagnosticTicket,
          { content: 'Appended to ' + args.path + ' (+' + added + ' bytes, now ' + bytes + ').\n' + receiptLine(receipt), summary: 'appended ' + args.path + ' (+' + kb(added) + ')', mutationReceipt: receipt, receipt }, ctx);
      }
    };

    const editTool = {
      name: 'fs.edit', capability: 'cabinet', scope: 'write', requiresConsent: true, timeoutMs: 10000,
      description: 'Edit a workspace file by exact text replacement: every occurrence of "find" becomes "replace". Use for small, exact changes; prefer fs.patch for multi-line source edits. Errors if "find" is absent — read the file first so your "find" matches exactly.',
      schema: { type: 'object', required: ['path', 'find', 'replace'], properties: { path: { type: 'string' }, find: { type: 'string' }, replace: { type: 'string' } } },
      run: async (args, ctx) => {
        const aid = (ctx && ctx.agentId) || 'agent';
        const { abs, base } = await resolveInside(aid, args.path, { scope: 'write', ctx });
        let initialBytes;
        try { initialBytes = await fsp.readFile(abs); }
        catch (e) { if (e && e.code === 'ENOENT') throw new Error('no such file: ' + args.path); throw e; }
        const txt = initialBytes.toString('utf8');
        const find = String(args.find);
        if (!find) throw new Error('"find" must be a non-empty string');
        if (txt.indexOf(find) < 0) throw new Error('"find" text not found in ' + args.path + ' — read the file and match it exactly');
        const count = txt.split(find).length - 1;
        const next = txt.split(find).join(String(args.replace));
        const bytes = Buffer.byteLength(next, 'utf8');
        if (bytes > WRITE_BYTES) throw new Error('file too large after edit (' + bytes + ' > ' + WRITE_BYTES + ' bytes)');
        const diagnosticTicket = await beginEditDiagnostics(aid, [{ abs, base, rel: String(args.path), text: txt }], ctx);
        const expected = Buffer.from(next, 'utf8');
        const receipt = await verifiedMutation({ operation: 'edit', path: args.path, abs, expected, initial: initialBytes, mutate: () => fsp.writeFile(abs, expected) });
        await stampSeen(aid, abs);   // our own edit is the new baseline: read -> edit -> write used to refuse with a FABRICATED "someone else edited it" story
        emitDeliverable(ctx, aid, args.path);
        return finishEditDiagnostics(diagnosticTicket,
          { content: 'Edited ' + args.path + ' (' + count + ' replacement' + (count === 1 ? '' : 's') + ').\n' + receiptLine(receipt), summary: 'edited ' + args.path + ' (' + count + 'x)', mutationReceipt: receipt, receipt }, ctx);
      }
    };

    const patchTool = {
      name: 'fs.patch', capability: 'cabinet', scope: 'write', requiresConsent: true, timeoutMs: 15000,
      description: 'Apply a V4A multi-hunk patch inside your workspace. Prefer this for multi-line source edits instead of temporary patch scripts or shell-quoted rewrites. Validates every path and hunk before writing, so a failed hunk leaves files unchanged.',
      schema: { type: 'object', required: ['patch'], properties: { patch: { type: 'string' } } },
      run: async (args, ctx) => {
        const aid = (ctx && ctx.agentId) || 'agent';
        const parsed = parsePatch(args && args.patch);
        if (!parsed.ok) throw new Error(parsed.error);

        const plans = new Map(); // abs -> { rel, abs, exists, content, touched }
        async function planFor(rel) {
          const resolved = await resolveInside(aid, rel, { scope: 'write', ctx });
          const key = resolved.abs;
          if (plans.has(key)) return plans.get(key);
          let content = null, exists = false;
          try { content = await fsp.readFile(key, 'utf8'); exists = true; }
          catch (e) { if (!(e && e.code === 'ENOENT')) throw e; }
          const plan = { rel: String(rel), abs: key, base: resolved.base, exists, content, initialContent: content, touched: false };
          plans.set(key, plan);
          return plan;
        }
        function assertSize(rel, content) {
          const bytes = Buffer.byteLength(String(content), 'utf8');
          if (bytes > WRITE_BYTES) throw new Error('file too large after patch for ' + rel + ' (' + bytes + ' > ' + WRITE_BYTES + ' bytes)');
        }
        function requireExists(plan, op) {
          if (!plan.exists || plan.content == null) throw new Error(op + ' target does not exist: ' + plan.rel);
        }
        function requireMissing(plan, op) {
          if (plan.exists || plan.content != null) throw new Error(op + ' target already exists: ' + plan.rel);
        }

        for (const op of parsed.operations) {
          if (op.type === 'add') {
            const plan = await planFor(op.path);
            requireMissing(plan, 'ADD');
            const next = addText(op);
            assertSize(op.path, next);
            plan.content = next;
            plan.exists = true;
            plan.touched = true;
          } else if (op.type === 'delete') {
            const plan = await planFor(op.path);
            requireExists(plan, 'DELETE');
            plan.content = null;
            plan.exists = false;
            plan.touched = true;
          } else if (op.type === 'move') {
            const src = await planFor(op.path);
            const dst = await planFor(op.newPath);
            requireExists(src, 'MOVE');
            if (src.abs !== dst.abs) requireMissing(dst, 'MOVE');
            dst.content = src.content;
            dst.exists = true;
            dst.touched = true;
            if (src.abs !== dst.abs) {
              src.content = null;
              src.exists = false;
              src.touched = true;
            }
          } else if (op.type === 'update') {
            const plan = await planFor(op.path);
            requireExists(plan, 'UPDATE');
            let current = plan.content;
            for (const hunk of op.hunks) {
              const oldText = hunkOldText(hunk);
              const newText = hunkNewText(hunk);
              const res = fuzzyFindAndReplace(current, oldText, newText);
              if (!res.ok) throw new Error('UPDATE ' + op.path + ': ' + res.error);
              current = res.content;
            }
            assertSize(op.path, current);
            if (op.newPath) {
              const dst = await planFor(op.newPath);
              if (plan.abs !== dst.abs) requireMissing(dst, 'MOVE');
              dst.content = current;
              dst.exists = true;
              dst.touched = true;
              if (plan.abs !== dst.abs) {
                plan.content = null;
                plan.exists = false;
                plan.touched = true;
              } else {
                plan.content = current;
                plan.touched = true;
              }
            } else {
              plan.content = current;
              plan.touched = true;
            }
          } else {
            throw new Error('unsupported patch operation: ' + op.type);
          }
        }

        const touched = Array.from(plans.values()).filter(p => p.touched);
        const diagnosticTicket = await beginEditDiagnostics(aid,
          touched.map(plan => ({ abs: plan.abs, base: plan.base, rel: plan.rel, text: plan.initialContent == null ? '' : plan.initialContent })), ctx);
        const patchReceipt = {
          operation: 'patch', path: touched.map(p => p.rel).join(', '), state: 'attempted', phases: ['attempted'],
          attemptedBytes: touched.reduce((n, p) => n + (p.content == null ? 0 : Buffer.byteLength(p.content, 'utf8')), 0), writtenBytes: 0, verifiedBytes: 0, sha256: null, files: []
        };
        try {
          // Apply destinations/updated files before deletes. In particular, a move must never
          // remove the last source copy until its destination was written and read back exactly.
          const ordered = touched.filter(plan => plan.content != null)
            .concat(touched.filter(plan => plan.content == null));
          for (const plan of ordered) {
            const expected = plan.content == null ? null : Buffer.from(plan.content, 'utf8');
            const initial = plan.initialContent == null ? null : Buffer.from(plan.initialContent, 'utf8');
            if (expected) await fsp.mkdir(P.dirname(plan.abs), { recursive: true });
            const fileReceipt = await verifiedMutation({
              operation: expected ? 'patch-write' : 'patch-delete', path: plan.rel, abs: plan.abs,
              expected, initial, mutate: () => expected ? fsp.writeFile(plan.abs, expected) : fsp.rm(plan.abs, { force: true })
            });
            await stampSeen(aid, plan.abs);   // our own patch is the new baseline for the stale-write guard (deletes drop the stamp)
            patchReceipt.files.push(fileReceipt);
          }
          patchReceipt.state = 'read-back-verified';
          patchReceipt.phases.push('written', 'read-back-verified');
          patchReceipt.writtenBytes = patchReceipt.files.reduce((n, r) => n + r.writtenBytes, 0);
          patchReceipt.verifiedBytes = patchReceipt.files.reduce((n, r) => n + r.verifiedBytes, 0);
        } catch (cause) {
          patchReceipt.files = [];
          let expectedCount = 0, initialCount = 0;
          for (const plan of touched) {
            const expected = plan.content == null ? null : Buffer.from(plan.content, 'utf8');
            const initial = plan.initialContent == null ? null : Buffer.from(plan.initialContent, 'utf8');
            let actual = null, unreadable = false;
            try { actual = await readBytesOrMissing(plan.abs); } catch (_) { unreadable = true; }
            const state = !unreadable && sameBytes(actual, expected) ? 'read-back-verified'
              : (!unreadable && sameBytes(actual, initial) ? 'failed' : 'partially-applied');
            if (state === 'read-back-verified') expectedCount++;
            if (state === 'failed') initialCount++;
            patchReceipt.files.push({
              operation: expected ? 'patch-write' : 'patch-delete', path: plan.rel, state,
              phases: ['attempted', state], attemptedBytes: expected ? expected.length : 0,
              writtenBytes: actual ? actual.length : 0, verifiedBytes: state === 'read-back-verified' && expected ? expected.length : 0,
              sha256: sha256(expected), actualSha256: unreadable ? null : sha256(actual)
            });
          }
          patchReceipt.state = expectedCount === touched.length ? 'read-back-verified'
            : (initialCount === touched.length ? 'failed' : 'partially-applied');
          patchReceipt.phases.push(patchReceipt.state);
          patchReceipt.writtenBytes = patchReceipt.files.reduce((n, r) => n + r.writtenBytes, 0);
          patchReceipt.verifiedBytes = patchReceipt.files.reduce((n, r) => n + r.verifiedBytes, 0);
          throw receiptError('filesystem patch ' + patchReceipt.state + ': ' + ((cause && cause.message) || cause), patchReceipt);
        }
        for (const plan of touched) if (plan.content != null) emitDeliverable(ctx, aid, plan.rel);
        return finishEditDiagnostics(diagnosticTicket, {
          content: 'Applied patch: ' + touched.length + ' file' + (touched.length === 1 ? '' : 's') + ' changed.\n' + receiptLine(patchReceipt),
          summary: 'patched ' + touched.length + ' file' + (touched.length === 1 ? '' : 's'),
          mutationReceipt: patchReceipt,
          receipt: patchReceipt
        }, ctx);
      }
    };

    // fs.search — a ripgrep-grade content/file search over the agent's workspace, in PURE Node (no `rg`
    // dependency, so it runs on a clean machine — our "bundle Node, no system deps" rule). Mirrors the
    // polished behaviour of a grep+find+ls replacement: target 'content' (grep) | 'files' (find/ls by glob,
    // newest-first); output_mode 'content'|'files_only'|'count'; file_glob filter; context lines; limit/offset
    // paging with an actionable next-offset hint; path-grouped ("densified") output above a few matches.
    // Jailed + bounded like every fs.* tool: skips hidden entries (rg default) + node_modules, oversized +
    // binary files, caps files scanned; redacts secrets out of every surfaced line (§5.6).
    const SEARCH_MAX_FILE_BYTES = 512 * 1024, SEARCH_MAX_FILES = 4000, SEARCH_LINE_CHARS = 500, SEARCH_DENSIFY_MIN = 5;
    // Longest line handed to a MODEL-SUPPLIED regex, and the wall-clock ceiling for the whole content scan.
    const SEARCH_MATCH_CHARS = 2000, SEARCH_TIME_BUDGET_MS = 8000;

    /* CATASTROPHIC-BACKTRACKING FLOOR (measured 2026-07-26).
       `fs.search { regex: true }` compiles the MODEL's string and runs it synchronously over every line of
       every candidate file. StarNet is ONE process — UI, API, SSE bus and every agent run — and a
       backtracking blow-up pegs the event loop, so a single call froze the entire station indefinitely:
       `(a|a)+$` against a 41-character line never returned, and the tool's own timeoutMs could not help
       (registry withTimeout REJECTS the promise; it cannot stop synchronous work). Only killing the process
       recovered. This needs no adversary — `(\s+)+$` or `(.*)*foo` are patterns a model writes by accident
       when searching code.

       Two bounds, and one honest limit. (1) refuse the shapes that actually blow up: an unbounded quantifier
       applied to a group whose body itself contains an unbounded quantifier, or an alternation with
       overlapping branches. (2) cap the input any one match sees, since blow-up scales with input length.
       LIMIT: this is a heuristic, exactly like shell.js's command floor — a determined pattern outside these
       shapes can still be slow. The durable fix is to run the match off the main loop (a worker with
       terminate(), the same "killable child" posture shell.exec already uses); until then the floor catches
       the realistic cases and the time budget below bounds everything polynomial. */
    const UNBOUNDED_Q = /[+*]|\{\d+,\}/;
    function groupBodies(src) {
      const out = [];
      for (let i = 0; i < src.length; i++) {
        if (src[i] === '\\') { i++; continue; }
        if (src[i] !== '(') continue;
        let depth = 1, j = i + 1;
        for (; j < src.length && depth > 0; j++) {
          if (src[j] === '\\') { j++; continue; }
          if (src[j] === '(') depth++;
          else if (src[j] === ')') depth--;
        }
        if (depth !== 0) break;                                   // unbalanced — the RegExp ctor will reject it
        const body = src.slice(i + 1, j - 1);
        const after = src.slice(j);                               // what follows the closing paren
        if (/^(?:[+*]|\{\d+,\})/.test(after)) out.push(body);     // this group is under an unbounded quantifier
      }
      return out;
    }
    function catastrophicRegex(src) {
      for (const body of groupBodies(String(src))) {
        const inner = body.replace(/^\?[:=!<][a-zA-Z]*/, '');     // drop a (?: (?= (?! (?<= prefix
        if (UNBOUNDED_Q.test(inner)) return 'a repeated group that itself repeats';
        const alts = inner.split('|');
        if (alts.length > 1) {
          for (let a = 0; a < alts.length; a++) for (let b = a + 1; b < alts.length; b++) {
            const x = alts[a], y = alts[b];
            if (x && y && (x === y || x.indexOf(y) === 0 || y.indexOf(x) === 0)) return 'a repeated group whose alternatives overlap';
          }
        }
      }
      return null;
    }

    // glob -> RegExp over a whole string. `*` = any run except '/', `**` = any run, `?` = one non-'/'.
    function globToRe(glob, ic) {
      const g = String(glob); let re = '';
      for (let i = 0; i < g.length; i++) {
        const c = g[i];
        if (c === '*') { if (g[i + 1] === '*') { re += '.*'; i++; } else { re += '[^/]*'; } }
        else if (c === '?') { re += '[^/]'; }
        else if ('\\^$.|+()[]{}'.indexOf(c) >= 0) { re += '\\' + c; }
        else { re += c; }
      }
      return new RegExp('^' + re + '$', ic ? 'i' : '');
    }
    /* recursive file walk -> acc of { rel, abs, mtimeMs }; rel is workspace-root-relative (feeds fs.read).
       Skips hidden entries + node_modules; never leaves the jailed base; bounded by SEARCH_MAX_FILES.

       SYMLINKS ARE RE-PROVEN HERE. resolveInside's realpath proof only covers the path the CALLER named —
       it says nothing about what the walk then reaches. So fs.read correctly refused a symlink pointing at
       ~/.ssh/id_rsa while fs.search happily grepped its CONTENTS and printed the matching line: the same
       jail, enforced on one tool and not its sibling. A link is cheap to check and rare, so only links pay
       the realpath (an ordinary file costs nothing extra); one that resolves outside is skipped entirely. */
    async function collectFiles(absDir, prefix, acc, stats, baseReal) {
      if (stats.files >= SEARCH_MAX_FILES) { stats.truncated = true; return; }
      let entries;
      try { entries = await fsp.readdir(absDir, { withFileTypes: true }); }
      catch (e) { if (e && e.code === 'ENOENT') return; throw e; }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const ent of entries) {
        if (stats.files >= SEARCH_MAX_FILES) { stats.truncated = true; return; }
        if (ent.name.charAt(0) === '.') continue;                 // hidden (matches ripgrep's default)
        const rel = prefix ? (prefix + '/' + ent.name) : ent.name;
        const abs = P.join(absDir, ent.name);
        // a link (or a Windows junction) must PROVE it still lands inside the jail before we read or descend
        if (typeof ent.isSymbolicLink === 'function' && ent.isSymbolicLink()) {
          if (baseReal && !pathInside(await realpathOrSelf(abs), baseReal)) { stats.skippedLinks = (stats.skippedLinks || 0) + 1; continue; }
        }
        if (ent.isDirectory()) { if (ent.name !== 'node_modules') await collectFiles(abs, rel, acc, stats, baseReal); continue; }
        let st; try { st = await fsp.stat(abs); } catch (e) { continue; }
        if (st.isDirectory && st.isDirectory()) {   // an in-jail symlinked DIRECTORY reads as a file in readdir
          if (ent.name !== 'node_modules') await collectFiles(abs, rel, acc, stats, baseReal);
          continue;
        }
        stats.files++; acc.push({ rel, abs, mtimeMs: st.mtimeMs || 0 });
      }
    }
    // `note` (optional) carries an honest reason the result set is partial for a reason OTHER than paging —
    // today, the scan hitting its wall-clock budget. Never silently truncate.
    function searchHint(truncated, offset, limit, total, note) {
      return (note || '') + (truncated ? ('\n\n[truncated — ' + total + '+ results shown so far; pass offset=' + (offset + limit) + ' for the next page, or narrow with file_glob / a more specific query]') : '');
    }
    function clipLine(s) { s = redact(String(s == null ? '' : s)).replace(/\s+$/, ''); return s.length > SEARCH_LINE_CHARS ? s.slice(0, SEARCH_LINE_CHARS) + '…' : s; }

    const searchTool = {
      name: 'fs.search', capability: 'cabinet', scope: 'read', requiresConsent: false, timeoutMs: 20000,
      description: 'Search your workspace — use this instead of grep/find/ls. Two modes via "target":\n• target:"content" (default) — find TEXT inside files. Substring by default; { "regex": true } treats "query" as a regex, { "ignoreCase": true } ignores case. "file_glob" limits which files are searched (e.g. "*.md"); "context" adds N lines around each hit; "output_mode" is "content" (matching lines, default), "files_only" (just the file paths), or "count" (matches per file).\n• target:"files" — find FILES by glob ("query" like "*.md" or "report"); newest first.\nResults are paths relative to your workspace (ready for fs.read). Use "limit"/"offset" to page; a truncation hint tells you the next offset.',
      schema: { type: 'object', required: ['query'], properties: {
        query: { type: 'string' },
        target: { type: 'string', enum: ['content', 'files'] },
        path: { type: 'string' }, file_glob: { type: 'string' },
        output_mode: { type: 'string', enum: ['content', 'files_only', 'count'] },
        context: { type: 'number' }, regex: { type: 'boolean' }, ignoreCase: { type: 'boolean' },
        limit: { type: 'number' }, offset: { type: 'number' }
      } },
      run: async (args, ctx) => {
        args = args || {};
        const q = String(args.query != null ? args.query : '');
        if (!q) throw new Error('"query" must be a non-empty string');
        const { base, abs } = await resolveInside((ctx && ctx.agentId) || 'agent', args.path || '.', { scope: 'read', ctx });
        const startPrefix = P.relative(base, abs).split(P.sep).join('/');     // '' when searching from the root
        const ic = !!args.ignoreCase;
        const limit = Math.max(1, Math.min(1000, Number(args.limit) || 50));
        const offset = Math.max(0, Number(args.offset) || 0);
        const target = ({ grep: 'content', find: 'files' })[args.target] || args.target || 'content';

        const all = [], stats = { files: 0, truncated: false };
        await collectFiles(abs, startPrefix, all, stats, await realpathOrSelf(base));

        // ---- target 'files': glob over names, newest first ----
        if (target === 'files') {
          const hasSlash = q.indexOf('/') >= 0;
          const re = globToRe((!hasSlash && q.charAt(0) !== '*') ? ('*' + q) : q, ic);   // bare name -> suffix match (rg --files -g *name)
          const hits = all.filter(f => re.test(hasSlash ? f.rel : f.rel.split('/').pop()));
          hits.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));   // newest first; path tiebreak = determinism
          const total = hits.length, page = hits.slice(offset, offset + limit);
          if (!page.length) return { content: '(no files matching ' + q + ')', summary: '0 files' };
          const truncated = stats.truncated || total > offset + limit;
          return { content: page.map(f => f.rel).join('\n') + searchHint(truncated, offset, limit, total),
                   summary: total + ' file' + (total === 1 ? '' : 's') + ' matched' + (truncated ? ' (showing ' + page.length + ')' : '') };
        }

        // ---- target 'content': grep ----
        let matcher;
        if (args.regex) {
          const risk = catastrophicRegex(q);
          if (risk) throw new Error('that regex can backtrack catastrophically (' + risk + ') and would stall the station — ' +
            'rewrite it without nesting one repeat inside another (e.g. "\\s+" instead of "(\\s+)+"), or drop "regex" and search for a plain substring');
          let re; try { re = new RegExp(q, ic ? 'i' : ''); } catch (e) { throw new Error('invalid regex: ' + ((e && e.message) || e)); }
          // blow-up scales with input length, so a model-supplied pattern never sees a whole long line
          matcher = (line) => re.test(line.length > SEARCH_MATCH_CHARS ? line.slice(0, SEARCH_MATCH_CHARS) : line);
        } else if (ic) { const n = q.toLowerCase(); matcher = (line) => line.toLowerCase().indexOf(n) >= 0; }
        else { matcher = (line) => line.indexOf(q) >= 0; }

        // file_glob was built from the FULL pattern but tested against the BASENAME only, so any path-shaped
        // glob (e.g. "src/" + star + ".js") matched nothing and returned a clean "0 matches" — indistinguishable
        // from "the text isn't there". Match on the same rule target:'files' already uses: a pattern containing
        // a slash is a PATH pattern, everything else is a name pattern.
        let globRe = null, globPath = false;
        if (args.file_glob) {
          let fg = String(args.file_glob);
          globPath = fg.indexOf('/') >= 0;
          if (!globPath && fg.charAt(0) !== '*') fg = '*' + fg;
          globRe = globToRe(fg, ic);
        }
        const candidates = all.filter(f => !globRe || globRe.test(globPath ? f.rel : f.rel.split('/').pop()))
          .sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));   // path order = deterministic, rg-like grouping

        const fileHits = [];   // { rel, idxs:[lineIdx…], lines:[…] }
        let totalMatches = 0;
        /* Ceiling for the whole scan. The pattern floor above catches the exponential shapes; this bounds
           everything merely SLOW (a polynomial pattern over a large tree), so fs.search can never be the
           reason the station stops answering. A TIMER, not a clock read — the determinism law bans ambient
           time in backend logic, and browser.js's waitForSettle already sets this precedent. It works here
           because the check sits between files, with an `await fsp.readFile` in between, so the loop turns
           and the timer can fire. A partial answer that SAYS it is partial beats a frozen process. */
        let expired = false;
        const budgetTimer = setTimeout(() => { expired = true; }, SEARCH_TIME_BUDGET_MS);
        if (budgetTimer && typeof budgetTimer.unref === 'function') budgetTimer.unref();
        let timedOut = false;
        for (const f of candidates) {
          if (expired) { timedOut = true; stats.truncated = true; break; }
          let buf; try { buf = await fsp.readFile(f.abs); } catch (e) { continue; }
          if (buf.length > SEARCH_MAX_FILE_BYTES || buf.indexOf(0) >= 0) continue;   // skip oversized / binary
          const lines = buf.toString('utf8').split(/\r?\n/), idxs = [];
          for (let i = 0; i < lines.length; i++) if (matcher(lines[i])) idxs.push(i);
          if (idxs.length) { fileHits.push({ rel: f.rel, idxs, lines }); totalMatches += idxs.length; }
        }
        clearTimeout(budgetTimer);
        if (timedOut) stats.timedOutNote = '\n\n[search stopped at the ' + Math.round(SEARCH_TIME_BUDGET_MS / 1000) +
          's budget — these are the matches found so far; narrow with file_glob or a more specific query]';

        const omode = args.output_mode || 'content';
        if (omode === 'count') {
          if (!fileHits.length) return { content: '(no matches for ' + q + ')', summary: '0 matches' };
          const total = fileHits.length, page = fileHits.slice(offset, offset + limit);
          const truncated = stats.truncated || total > offset + limit;
          return { content: page.map(h => h.rel + ': ' + h.idxs.length).join('\n') + searchHint(truncated, offset, limit, total, stats.timedOutNote),
                   summary: totalMatches + ' match' + (totalMatches === 1 ? '' : 'es') + ' across ' + total + ' file(s)' };
        }
        if (omode === 'files_only') {
          if (!fileHits.length) return { content: '(no matches for ' + q + ')', summary: '0 files' };
          const total = fileHits.length, page = fileHits.slice(offset, offset + limit);
          const truncated = stats.truncated || total > offset + limit;
          return { content: page.map(h => h.rel).join('\n') + searchHint(truncated, offset, limit, total, stats.timedOutNote),
                   summary: total + ' file' + (total === 1 ? '' : 's') + ' with matches' };
        }

        // content (default): page on the flat match list (file-ordered), render with optional context
        const flat = [];
        for (let fi = 0; fi < fileHits.length; fi++) for (const idx of fileHits[fi].idxs) flat.push({ fi, idx });
        const total = flat.length;
        if (!total) return { content: '(no matches for ' + q + ')', summary: '0 matches in ' + stats.files + ' file(s) scanned' };
        const pageRefs = flat.slice(offset, offset + limit);
        const truncated = stats.truncated || total > offset + limit;
        const cx = Math.max(0, Math.min(10, Number(args.context) || 0));

        let body;
        if (pageRefs.length < SEARCH_DENSIFY_MIN && cx === 0) {
          // few matches, no context: flat "path:line: text" rows (path on each line is convenient when small)
          body = pageRefs.map(r => { const h = fileHits[r.fi]; return h.rel + ':' + (r.idx + 1) + ': ' + clipLine(h.lines[r.idx]); }).join('\n');
        } else {
          // densified: file path once, then "  <line>: match" / "  <line>- context" rows ('--' marks a gap)
          const lines = [];
          let gi = 0;
          while (gi < pageRefs.length) {
            const fi = pageRefs[gi].fi, h = fileHits[fi], here = [];
            while (gi < pageRefs.length && pageRefs[gi].fi === fi) { here.push(pageRefs[gi].idx); gi++; }
            const matchSet = new Set(here), show = new Set();
            for (const i of here) for (let k = Math.max(0, i - cx); k <= Math.min(h.lines.length - 1, i + cx); k++) show.add(k);
            const ordered = Array.from(show).sort((a, b) => a - b);
            lines.push(h.rel);
            let prev = -1;
            for (const k of ordered) {
              if (prev >= 0 && k > prev + 1) lines.push('  --');
              lines.push('  ' + (k + 1) + (matchSet.has(k) ? ': ' : '- ') + clipLine(h.lines[k]));
              prev = k;
            }
          }
          body = lines.join('\n');
        }
        return { content: body + searchHint(truncated, offset, limit, total, stats.timedOutNote),
                 summary: total + ' match' + (total === 1 ? '' : 'es') + ' in ' + fileHits.length + ' file(s)' + (truncated ? ' (showing ' + pageRefs.length + ')' : '') };
      }
    };

    return {
      writeTool, readTool, listTool, appendTool, editTool, patchTool, searchTool,
      _internals: { resolveInside, workspaceRoot, safeAgentId, walk, collectFiles, globToRe, pathInside, parsePatch, fuzzyFindAndReplace },
      register(reg) { [writeTool, readTool, listTool, appendTool, editTool, patchTool, searchTool].forEach(t => reg.register(t)); return reg; }
    };
  }

  return { makeFsTools };
});
