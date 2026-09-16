/* node test/channels.telegram.test.js — Telegram concrete adapter + Bot API fetch transport (C2).
   An injected FAKE fetch drives everything; no real network. Covers: getUpdates URL/body + result parsing,
   401 -> fatal throw, network throw -> non-fatal; sendMessage URL/body + message_id mapping, 429/5xx retryable,
   4xx not-retryable, network/abort never-throws-returns-SendResult; the pure normalize() truth table; and an
   end-to-end connect() -> onInbound through the real transport+normalize+generic adapter. Deterministic. */
'use strict';
const A = require('./_assert.js');
const { makeTelegramTransport, ALLOWED_UPDATES } = require('../sidecar/channels/telegram.transport.js');
const { makeTelegramAdapter, normalize, MAX_MESSAGE_LENGTH } = require('../sidecar/channels/telegram.js');

const tick = () => new Promise(r => setTimeout(r, 0));
const abortErr = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
const resp = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

// fake fetch: handler(url, opts, callNo) -> a resp(); or { __throw: err } to throw; or { __park:true } to
// park until opts.signal aborts (mimics a quiet long-poll). Records every call's url + parsed body.
function fakeFetch(handler) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url, opts, body: (opts && opts.body) ? JSON.parse(opts.body) : undefined });
    const r = handler(url, opts, calls.length);
    if (r && r.__throw) throw r.__throw;
    if (r && r.__park) return new Promise((resolve, reject) => {
      const sig = opts && opts.signal;
      if (sig && sig.aborted) return reject(abortErr());
      sig && sig.addEventListener('abort', () => reject(abortErr()), { once: true });
    });
    return r;
  };
  f.calls = calls;
  return f;
}

async function run() {
  // ---- A. getUpdates: URL carries the token, body carries offset/timeout/allowed_updates, result parsed ----
  {
    const f = fakeFetch(() => resp(200, { ok: true, result: [{ update_id: 7, message: { message_id: 1, text: 'hi', chat: { id: 1, type: 'private' }, from: { id: 2 } } }] }));
    const t = makeTelegramTransport({ fetch: f, token: 'TKN' });
    const ups = await t.getUpdates({ offset: 5, timeoutSec: 50 });
    A.eq(ups.length, 1, 'getUpdates returns the raw Update[]');
    A.eq(f.calls[0].url, 'https://api.telegram.org/botTKN/getUpdates', 'getUpdates URL embeds the token in the path');
    A.eq(f.calls[0].body, { offset: 5, timeout: 50, allowed_updates: ALLOWED_UPDATES }, 'getUpdates body');
    A.eq(f.calls[0].opts.method, 'POST', 'POST');
  }

  // ---- B. getUpdates: 401 -> fatal throw (stops the loop); 5xx -> non-fatal throw (loop backs off) ----
  {
    const t401 = makeTelegramTransport({ fetch: fakeFetch(() => resp(401, { ok: false, error_code: 401, description: 'Unauthorized' })), token: 'BAD' });
    let e = null; try { await t401.getUpdates({ offset: 0 }); } catch (x) { e = x; }
    A.ok(e && e.fatal === true, '401 -> fatal throw');
    const t500 = makeTelegramTransport({ fetch: fakeFetch(() => resp(500, { ok: false, error_code: 500, description: 'Internal' })), token: 'TKN' });
    e = null; try { await t500.getUpdates({ offset: 0 }); } catch (x) { e = x; }
    A.ok(e && !e.fatal, '500 -> throws but NOT fatal (transient, loop will back off)');
    // 409 (another poller / stale webhook) -> CONFLICT, not fatal: the adapter re-probes slowly and self-heals
    // once the other consumer stops (a fatal 409 used to kill the channel — and channel.send with it — forever
    // over what is often a transient webhook-delete race or restart overlap).
    const t409 = makeTelegramTransport({ fetch: fakeFetch(() => resp(409, { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates request' })), token: 'TKN' });
    e = null; try { await t409.getUpdates({ offset: 0 }); } catch (x) { e = x; }
    A.ok(e && e.conflict === true && !e.fatal && /another instance|webhook/i.test(e.message), '409 -> conflict (recoverable) with actionable detail');
    /* THE REAL WORDING, captured live from api.telegram.org on 2026-07-29 by running two pollers on one token.
       The abbreviated fixture above would keep passing even if Telegram's phrasing drifted past our regex — an
       invented string can only prove the code matches itself. This one is the sentence the platform actually
       sends, so a future tightening of the pattern cannot silently stop recognising a conflict and leave the
       channel looping against a token another instance owns. */
    const LIVE_409 = 'Conflict: terminated by other getUpdates request; make sure that only one bot instance is running';
    const tLive = makeTelegramTransport({ fetch: fakeFetch(() => resp(409, { ok: false, error_code: 409, description: LIVE_409 })), token: 'TKN' });
    e = null; try { await tLive.getUpdates({ offset: 0 }); } catch (x) { e = x; }
    A.eq(e && e.conflict, true, "Telegram's ACTUAL conflict sentence is recognised as a conflict (live-captured fixture)");
    A.ok(e && !e.fatal, 'and it is NOT fatal — the loop must survive it');
    A.eq(e && e.code, 409, 'and carries the code the poll loop reads');
    A.ok(e && /stop the other poller/.test(e.message), 'and is rewritten into something the member can act on');
  }

  // ---- B7. getMe: token probe — id/username surfaced; bad token / network -> { ok:false }, never throws ----
  {
    const f = fakeFetch(() => resp(200, { ok: true, result: { id: 7446, is_bot: true, first_name: 'Overseer Bot', username: 'OverseerBot' } }));
    const t = makeTelegramTransport({ fetch: f, token: 'TKN' });
    A.eq(await t.getMe(), { ok: true, id: '7446', username: 'OverseerBot', name: 'Overseer Bot' }, 'getMe surfaces the stable id + username');
    /* PRIVACY MODE rides with the identity, because it decides what this bot can HEAR. With it on (Telegram's
       default, confirmed live) a group delivers us only commands, @mentions and replies to us — so wake words
       and observe-unmentioned receive nothing, and /mention has to say so instead of promising to follow a room
       it is not being sent. A server that does not mention the field leaves it ABSENT: unknown, never "off". */
    const withFlag = (v) => makeTelegramTransport({
      fetch: fakeFetch(() => resp(200, { ok: true, result: { id: 1, is_bot: true, first_name: 'B', username: 'b', can_read_all_group_messages: v } })),
      token: 'TKN'
    }).getMe();
    A.eq((await withFlag(false)).seesAllGroupMessages, false, 'privacy ON is reported as seesAllGroupMessages:false');
    A.eq((await withFlag(true)).seesAllGroupMessages, true, 'and privacy disabled as true');
    A.eq('seesAllGroupMessages' in (await t.getMe()), false, 'a server that never mentions it leaves the key ABSENT — unknown is not the same as "privacy is on"');
    A.eq(f.calls[0].url, 'https://api.telegram.org/botTKN/getMe', 'getMe hits the right method');
    const tbad = makeTelegramTransport({ fetch: fakeFetch(() => resp(401, { ok: false, error_code: 401, description: 'Unauthorized' })), token: 'BAD' });
    const rb = await tbad.getMe();
    A.ok(rb.ok === false && /Unauthorized/.test(rb.error), 'bad token -> ok:false with the Telegram description');
    const tnet2 = makeTelegramTransport({ fetch: fakeFetch(() => ({ __throw: new Error('net down') })), token: 'TKN' });
    const rn2 = await tnet2.getMe();
    A.ok(rn2.ok === false && /net down/.test(rn2.error), 'network error -> ok:false, never throws');
  }

  // ---- B6. sendChatAction: right method/body; 429 retryable with retryAfter; 400 not; network never throws ----
  {
    const f = fakeFetch(() => resp(200, { ok: true, result: true }));
    const t = makeTelegramTransport({ fetch: f, token: 'TKN' });
    A.eq(await t.sendChatAction(555), { ok: true }, 'sendChatAction ok');
    A.eq(f.calls[0].url, 'https://api.telegram.org/botTKN/sendChatAction', 'sendChatAction hits the right method');
    A.eq(f.calls[0].body, { chat_id: 555, action: 'typing' }, 'action defaults to typing');
    const t429 = makeTelegramTransport({ fetch: fakeFetch(() => resp(429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 7 } })), token: 'TKN' });
    const r429 = await t429.sendChatAction(555);
    A.ok(r429.ok === false && r429.retryable === true && r429.retryAfter === 7, '429 -> retryable with retry_after');
    const t400 = makeTelegramTransport({ fetch: fakeFetch(() => resp(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' })), token: 'TKN' });
    const r400 = await t400.sendChatAction(1);
    A.ok(r400.ok === false && !r400.retryable, '400 -> not retryable (stops the keep-alive loop)');
    const tnet = makeTelegramTransport({ fetch: fakeFetch(() => ({ __throw: new Error('net down') })), token: 'TKN' });
    const rn = await tnet.sendChatAction(1);
    A.ok(rn.ok === false && rn.retryable === true, 'network error -> never throws, retryable result');
  }

  // ---- B5. deleteWebhook posts the right method and never throws ----
  {
    const fdw = fakeFetch(() => resp(200, { ok: true, result: true }));
    const tdw = makeTelegramTransport({ fetch: fdw, token: 'TKN' });
    await tdw.deleteWebhook();
    A.eq(fdw.calls[0].url, 'https://api.telegram.org/botTKN/deleteWebhook', 'deleteWebhook hits the right method');
    A.eq(fdw.calls[0].body, { drop_pending_updates: false }, 'deleteWebhook body keeps pending (drop is handled by the offset prime)');
    const tdw2 = makeTelegramTransport({ fetch: fakeFetch(() => ({ __throw: new Error('net down') })), token: 'TKN' });
    await tdw2.deleteWebhook();   // must NOT throw
    A.ok(true, 'deleteWebhook swallows transport errors');
  }

  // ---- C. getUpdates: a network throw propagates (non-fatal) so the loop backs off ----
  {
    const t = makeTelegramTransport({ fetch: fakeFetch(() => ({ __throw: new Error('ECONNRESET') })), token: 'TKN' });
    let e = null; try { await t.getUpdates({ offset: 0 }); } catch (x) { e = x; }
    A.ok(e && /ECONNRESET/.test(e.message) && !e.fatal, 'network error propagates, not fatal');

    const undici = new TypeError('fetch failed');
    undici.cause = Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND', hostname: 'api.telegram.org' });
    const diagnosed = makeTelegramTransport({ fetch: fakeFetch(() => ({ __throw: undici })), token: 'TKN' });
    e = null; try { await diagnosed.getUpdates({ offset: 0 }); } catch (x) { e = x; }
    A.ok(e && /fetch failed \(ENOTFOUND api\.telegram\.org\)/.test(e.message), 'undici cause is surfaced for an actionable outage diagnosis');
  }

  // ---- C2. every non-poll Bot API call has a hard deadline; getUpdates keeps its dedicated signal ----
  {
    const hold = setInterval(() => {}, 1000);   // AbortSignal.timeout is unref'd by Node; keep this proof alive
    const parked = fakeFetch(() => ({ __park: true }));
    const bounded = makeTelegramTransport({ fetch: parked, token: 'TKN', requestTimeoutMs: 15 });
    const me = await bounded.getMe();
    A.ok(me.ok === false && /abort/i.test(me.error), 'a half-open getMe settles at the request deadline');
    const sent = await bounded.send('1', 'hello');
    A.ok(sent.ok === false && sent.retryable === false && /abort/i.test(sent.error), 'a half-open send settles instead of stranding the reply');
    const file = await bounded.getFile('f1');
    A.ok(file.ok === false && /abort/i.test(file.error), 'a half-open media lookup settles too');

    let pollSettled = false;
    const pollAbort = new AbortController();
    const poll = bounded.getUpdates({ offset: 0, timeoutSec: 50, signal: pollAbort.signal }).then(
      () => { pollSettled = true; }, () => { pollSettled = true; }
    );
    await new Promise(r => setTimeout(r, 30));
    A.eq(pollSettled, false, 'getUpdates is not incorrectly capped by the shorter ordinary-request deadline');
    pollAbort.abort();
    await poll;
    clearInterval(hold);
  }

  // ---- D. send: URL/body correct, message_id mapped, `signal` stripped from the wire body ----
  {
    const f = fakeFetch(() => resp(200, { ok: true, result: { message_id: 42 } }));
    const t = makeTelegramTransport({ fetch: f, token: 'TKN' });
    const r = await t.send('c1', 'hi', { parse_mode: 'HTML', signal: {} });
    A.eq(r, { ok: true, messageId: '42' }, 'send maps result.message_id -> string SendResult');
    A.eq(f.calls[0].url, 'https://api.telegram.org/botTKN/sendMessage', 'send URL');
    A.eq(f.calls[0].body, { chat_id: 'c1', text: 'hi', parse_mode: 'HTML' }, 'send body includes opts EXCEPT signal');
  }

  // ---- E. send error mapping: 429/5xx retryable (+retryAfter), 4xx not; never throws on network/abort ----
  {
    const t429 = makeTelegramTransport({ fetch: fakeFetch(() => resp(429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } })), token: 'TKN' });
    const r429 = await t429.send('c', 'x');
    A.eq(r429.ok, false, '429 -> not ok'); A.eq(r429.retryable, true, '429 retryable'); A.eq(r429.retryAfter, 3, 'retry_after surfaced');

    const t400 = makeTelegramTransport({ fetch: fakeFetch(() => resp(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' })), token: 'TKN' });
    const r400 = await t400.send('c', 'x');
    A.eq(r400.retryable, false, '400 -> not retryable');

    const tNet = makeTelegramTransport({ fetch: fakeFetch(() => ({ __throw: new Error('socket hang up') })), token: 'TKN' });
    const rNet = await tNet.send('c', 'x');
    A.eq(rNet, { ok: false, error: 'socket hang up', retryable: true }, 'network throw -> retryable SendResult (never throws)');

    const tAb = makeTelegramTransport({ fetch: fakeFetch(() => ({ __throw: abortErr() })), token: 'TKN' });
    const rAb = await tAb.send('c', 'x');
    A.eq(rAb.retryable, false, 'abort -> not retryable');
  }

  // ---- F. normalize() truth table (pure; no transport) ----
  {
    A.eq(MAX_MESSAGE_LENGTH, 4096, 'Telegram MAX_MESSAGE_LENGTH = 4096');
    A.eq(normalize({ update_id: 1, message: { message_id: 9, text: 'hi', chat: { id: 111, type: 'private' }, from: { id: 5, username: 'andro' } } }),
      { offset: 1, message: { chatId: 111, chatType: 'dm', userId: 5, userName: 'andro', text: 'hi', messageId: 9 } }, 'private chat -> dm');
    A.eq(normalize({ update_id: 2, message: { message_id: 10, text: 'yo', chat: { id: -200, type: 'supergroup' }, from: { id: 6, first_name: 'X' } } }).message.chatType, 'group', 'supergroup -> group');
    A.eq(normalize({ update_id: 2, message: { message_id: 10, text: 'yo', chat: { id: -200, type: 'supergroup' }, from: { id: 6, first_name: 'X' } } }).message.userName, 'X', 'falls back to first_name when no username');
    A.eq(normalize({ update_id: 3, callback_query: { id: 'q1', data: 'approve:p1', from: { id: 7 }, message: { message_id: 11, chat: { id: 111 } } } }),
      { offset: 3, callback: { chatId: 111, userId: 7, data: 'approve:p1', callbackId: 'q1', messageId: 11 } }, 'callback_query -> callback');
    // A SERVICE message (someone joined) is the real "nothing to say" case — it must stay silent. (A sticker used
    // to live here; it is user content and now arrives as a descriptor — see channels.telegram.context.test.js.)
    A.eq(normalize({ update_id: 4, message: { message_id: 12, chat: { id: 111, type: 'private' }, new_chat_members: [{ id: 3 }] } }), { offset: 4, message: null }, 'service message -> message:null (offset still advances)');
    A.eq(normalize({ foo: 1 }), null, 'no update_id -> null (skipped, no offset advance)');
  }

  // ---- F2. normalize() MEDIA truth table: photos/videos/voice/docs are ADMITTED, not dropped ----
  {
    const chat = { id: 111, type: 'private' }, from = { id: 5, username: 'andro' };
    // photo (sizes ordered small->large; largest wins) with a caption
    const p = normalize({ update_id: 10, message: { message_id: 20, chat, from, caption: 'look at this',
      photo: [{ file_id: 'small', file_size: 100 }, { file_id: 'big', file_size: 900 }] } });
    A.ok(p && p.message, 'photo message is admitted');
    A.eq(p.message.text, 'look at this', 'caption becomes the message text');
    A.eq(p.message.media, [{ kind: 'photo', fileId: 'big', name: 'photo.jpg', mime: 'image/jpeg', size: 900 }], 'largest photo size selected');
    // video: the clip AND its preview thumbnail (the model-visible frame) both ride
    const v = normalize({ update_id: 11, message: { message_id: 21, chat, from,
      video: { file_id: 'vid1', file_name: 'clip.mp4', mime_type: 'video/mp4', file_size: 5000, thumbnail: { file_id: 'th1', file_size: 40 } } } });
    A.ok(v && v.message, 'video message is admitted');
    A.eq(v.message.text, '', 'no caption -> empty text (still admitted)');
    A.eq(v.message.media, [
      { kind: 'video', fileId: 'vid1', name: 'clip.mp4', mime: 'video/mp4', size: 5000 },
      { kind: 'photo', fileId: 'th1', name: 'video-preview-frame.jpg', mime: 'image/jpeg', size: 40 }
    ], 'video carries the clip + its thumbnail as a photo frame');
    // legacy `thumb` field name (pre-Bot-API-6.x) still yields the frame
    const v2 = normalize({ update_id: 12, message: { message_id: 22, chat, from,
      video: { file_id: 'vid2', thumb: { file_id: 'th2' } } } });
    A.eq(v2.message.media.length, 2, 'legacy thumb field also yields the preview frame');
    // voice + document
    const vo = normalize({ update_id: 13, message: { message_id: 23, chat, from, voice: { file_id: 'voi', file_size: 800 } } });
    A.eq(vo.message.media[0].kind, 'audio', 'voice -> audio media item');
    const doc = normalize({ update_id: 14, message: { message_id: 24, chat, from, document: { file_id: 'd1', file_name: 'report.pdf', mime_type: 'application/pdf' } } });
    A.eq(doc.message.media[0], { kind: 'document', fileId: 'd1', name: 'report.pdf', mime: 'application/pdf', size: 0 }, 'document admitted with name+mime');
    // static sticker = viewable webp photo; animated/video stickers stay out
    A.eq(normalize({ update_id: 15, message: { message_id: 25, chat, from, sticker: { file_id: 's1' } } }).message.media[0].mime, 'image/webp', 'static sticker -> webp photo');
    // an animated sticker carries no frame any provider ingests, so it has no media — but it is NOT nothing:
    // it now arrives as a descriptor instead of being dropped into silence (channels.telegram.context.test.js).
    const anim = normalize({ update_id: 16, message: { message_id: 26, chat, from, sticker: { file_id: 's2', is_animated: true, emoji: '🔥' } } });
    A.eq('media' in anim.message, false, 'animated sticker still carries no ingestible media');
    A.ok(/animated sticker/.test(anim.message.text), 'animated sticker is described, not dropped');
    // text-only messages keep the EXACT old shape (no media field) — additive contract
    A.eq('media' in normalize({ update_id: 17, message: { message_id: 27, chat, from, text: 'plain' } }).message, false, 'text-only message has no media field');
    // album parts carry media_group_id -> mediaGroupId (the hub's merge key)
    const alb = normalize({ update_id: 18, message: { message_id: 28, chat, from, media_group_id: 777,
      photo: [{ file_id: 'a1', file_size: 5 }] } });
    A.eq(alb.message.mediaGroupId, '777', 'media_group_id rides as mediaGroupId (stringified)');
    A.eq('mediaGroupId' in normalize({ update_id: 19, message: { message_id: 29, chat, from, photo: [{ file_id: 'a2' }] } }).message, false, 'single photo has no mediaGroupId');
  }

  // ---- F3. transport.getFile: two-step Bot API download -> { ok, buffer }; errors/size caps degrade, never throw ----
  {
    const bytes = Buffer.from('JPEGDATA');
    const fileResp = () => ({ status: 200, ok: true, json: async () => ({}), arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), headers: { get: (h) => h === 'content-length' ? String(bytes.length) : null } });
    const f = fakeFetch((url) => url.indexOf('/file/bot') !== -1 ? fileResp() : resp(200, { ok: true, result: { file_path: 'photos/p1.jpg' } }));
    const t = makeTelegramTransport({ fetch: f, token: 'TKN' });
    const r = await t.getFile('abc');
    A.eq(r.ok, true, 'getFile ok');
    A.eq(Buffer.from(r.buffer).toString(), 'JPEGDATA', 'bytes round-trip');
    A.eq(f.calls[0].url, 'https://api.telegram.org/botTKN/getFile', 'step 1 hits getFile');
    A.eq(f.calls[0].body, { file_id: 'abc' }, 'file_id in body');
    A.eq(f.calls[1].url, 'https://api.telegram.org/file/botTKN/photos/p1.jpg', 'step 2 downloads via /file/bot<token>/<path>');
    // size cap via content-length refuses BEFORE buffering
    const rCap = await t.getFile('abc', { maxBytes: 2 });
    A.ok(rCap.ok === false && /too large/.test(rCap.error), 'maxBytes refused via content-length');
    // Bot API error -> honest { ok:false }
    const tErr = makeTelegramTransport({ fetch: fakeFetch(() => resp(400, { ok: false, error_code: 400, description: 'file not found' })), token: 'TKN' });
    A.eq((await tErr.getFile('zzz')).ok, false, 'getFile API error -> ok:false');
    // network throw -> never throws
    const tNet = makeTelegramTransport({ fetch: fakeFetch(() => ({ __throw: new Error('ECONNRESET') })), token: 'TKN' });
    A.eq((await tNet.getFile('zzz')).ok, false, 'network error -> ok:false, never throws');
  }

  const getUpdatesCalls = (f) => f.calls.filter(c => c.url.indexOf('/getUpdates') !== -1);

  // ---- G. end-to-end: connect() polls via the real transport+normalize+generic adapter -> onInbound fires ----
  {
    const inbox = [];
    let gu = 0;   // count getUpdates calls specifically (connect also fires deleteWebhook, so total-call index is unreliable)
    const f = fakeFetch((url) => {
      if (url.indexOf('/getUpdates') !== -1) {
        gu++;
        if (gu === 1) return resp(200, { ok: true, result: [{ update_id: 50, message: { message_id: 1, text: 'ping', chat: { id: 999, type: 'private' }, from: { id: 1, username: 'a' } } }] });
        return { __park: true };   // subsequent polls park (abort-aware) so the test's timers aren't starved
      }
      return resp(200, { ok: true, result: { message_id: 1 } });   // deleteWebhook / sendMessage
    });
    // drop-pending OFF here so the first poll IS the delivery (this case tests basic end-to-end, not backlog).
    const a = makeTelegramAdapter({ allowTrustOnFirstUse: true, fetch: f, token: 'TKN', allowTrustOnFirstUse: true, dropPendingOnConnect: false, onInbound: m => inbox.push(m), clock: { now: () => 1234 }, sleep: () => Promise.resolve() });
    await a.connect();
    for (let i = 0; i < 8 && !inbox.length; i++) await tick();
    A.eq(inbox.length, 1, 'end-to-end: one inbound delivered');
    A.eq(inbox[0], { channel: 'telegram', chatId: '999', chatType: 'dm', userId: '1', userName: 'a', text: 'ping', messageId: '1', ts: 1234 }, 'normalized InboundMessage via the real pipeline');
    const gus = getUpdatesCalls(f);
    A.ok(gus[1] && gus[1].body.offset === 51, 'second getUpdates confirmed offset 50+1 (each update fetched once)');
    await a.disconnect();
  }

  // ---- G2. end-to-end MEDIA: a video message rides the real transport+normalize+adapter into onInbound ----
  {
    const inbox = [];
    let gu = 0;
    const f = fakeFetch((url) => {
      if (url.indexOf('/getUpdates') !== -1) {
        gu++;
        if (gu === 1) return resp(200, { ok: true, result: [{ update_id: 60, message: { message_id: 3, caption: 'watch this', chat: { id: 999, type: 'private' }, from: { id: 1, username: 'a' },
          video: { file_id: 'v9', file_name: 'demo.mp4', mime_type: 'video/mp4', file_size: 1000, thumbnail: { file_id: 't9', file_size: 50 } } } }] });
        return { __park: true };
      }
      return resp(200, { ok: true, result: { message_id: 1 } });
    });
    const a = makeTelegramAdapter({ allowTrustOnFirstUse: true, fetch: f, token: 'TKN', allowTrustOnFirstUse: true, dropPendingOnConnect: false, onInbound: m => inbox.push(m), clock: { now: () => 7 }, sleep: () => Promise.resolve() });
    await a.connect();
    for (let i = 0; i < 8 && !inbox.length; i++) await tick();
    A.eq(inbox.length, 1, 'media message delivered inbound (no longer dropped)');
    A.eq(inbox[0].text, 'watch this', 'caption rides as text');
    A.eq(inbox[0].media.map(m => m.kind), ['video', 'photo'], 'clip + preview frame both ride');
    A.ok(typeof a.getFile === 'function', 'adapter exposes getFile for the hub');
    await a.disconnect();
  }

  // ---- H. drop-pending is ON by default for Telegram: connect primes offset:-1 and discards the backlog ----
  {
    const inbox = [];
    let gu = 0;
    const f = fakeFetch((url) => {
      if (url.indexOf('/getUpdates') !== -1) {
        gu++;
        if (gu === 1) return resp(200, { ok: true, result: [{ update_id: 70, message: { message_id: 1, text: 'STALE', chat: { id: 5, type: 'private' }, from: { id: 9 } } }] });   // prime -> dropped
        if (gu === 2) return resp(200, { ok: true, result: [{ update_id: 71, message: { message_id: 2, text: 'fresh', chat: { id: 5, type: 'private' }, from: { id: 9 } } }] });   // real -> delivered
        return { __park: true };
      }
      return resp(200, { ok: true, result: { message_id: 1 } });
    });
    const a = makeTelegramAdapter({ allowTrustOnFirstUse: true, fetch: f, token: 'TKN', onInbound: m => inbox.push(m), clock: { now: () => 1 }, sleep: () => Promise.resolve() });
    await a.connect();
    for (let i = 0; i < 8 && !inbox.length; i++) await tick();
    A.eq(inbox.map(m => m.text), ['fresh'], 'Telegram default discards the offline backlog, delivers only fresh');
    A.eq(getUpdatesCalls(f)[0].body.offset, -1, 'prime getUpdates used offset -1');
    await a.disconnect();
  }

  A.report('channels.telegram.test');
}

run().catch(e => { console.log('FAIL: run() threw — ' + (e && e.stack || e)); process.exit(1); });
