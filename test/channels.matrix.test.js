/* node test/channels.matrix.test.js — the Matrix channel: transport (sync long-poll + send) and binding
   (normalize + owner gate through the generic adapter). No real network — an injected fake fetch scripts the
   homeserver: whoami, the DISCARDED first sync (drop-pending), then live syncs with room timeline events. */
'use strict';
const A = require('./_assert.js');
const { makeMatrixTransport } = require('../sidecar/channels/matrix.transport.js');
const { makeMatrixAdapter, normalize, MAX_MESSAGE_LENGTH } = require('../sidecar/channels/matrix.js');

const tick = () => new Promise(r => setTimeout(r, 0));
const jres = (status, body) => ({ ok: status >= 200 && status < 300, status, async json() { return body; } });

(async () => {
  // ---- A. normalize: wire event -> neutral InboundMessage ----
  {
    const ev = (over) => Object.assign({ type: 'm.room.message', sender: '@alice:hs', event_id: '$e1', content: { msgtype: 'm.text', body: 'hi' } }, over);
    const m = normalize({ roomId: '!r:hs', event: ev({}), selfId: '@bot:hs' });
    A.eq(m.message, { chatId: '!r:hs', chatType: 'dm', userId: '@alice:hs', userName: '@alice:hs', text: 'hi', messageId: '$e1' }, 'a text message normalizes to the neutral shape (rooms are dm/owner-gated)');
    A.eq(normalize({ roomId: '!r:hs', event: ev({ sender: '@bot:hs' }), selfId: '@bot:hs' }), null, 'the agent\'s own echo is dropped');
    A.eq(normalize({ roomId: '!r:hs', event: ev({ type: 'm.room.member' }), selfId: '' }), null, 'a state event delivers nothing');
    A.eq(normalize({ roomId: '!r:hs', event: ev({ content: { msgtype: 'm.image', url: 'mxc://x' } }), selfId: '' }), null, 'a non-text message delivers nothing');
    A.eq(normalize(null), null, 'malformed raw -> null');
    A.eq(MAX_MESSAGE_LENGTH, 4096, 'declared chunking limit');
    // ROOM TYPING: only a 1:1 room (bot + one human) is a DM surface; a shared room is a GROUP (dropped unless
    // allowlisted, like every other platform). An unknown member count keeps the owner-gated dm path.
    A.eq(normalize({ roomId: '!r:hs', event: ev({}), selfId: '@bot:hs', joinedMembers: 2 }).message.chatType, 'dm', 'a two-member room is a DM');
    A.eq(normalize({ roomId: '!r:hs', event: ev({}), selfId: '@bot:hs', joinedMembers: 3 }).message.chatType, 'group', 'a three-member room is a group');
    A.eq(normalize({ roomId: '!r:hs', event: ev({}), selfId: '@bot:hs', joinedMembers: 40 }).message.chatType, 'group', 'a big room is a group');
    A.eq(normalize({ roomId: '!r:hs', event: ev({}), selfId: '@bot:hs', joinedMembers: null }).message.chatType, 'dm', 'no summary from the homeserver -> owner-gated dm (never a silently deaf channel)');
  }

  // ---- B. transport: whoami once, first sync DISCARDED (backlog), since advances, send PUT shape ----
  {
    const calls = [];
    const backlogEvent = { type: 'm.room.message', sender: '@alice:hs', event_id: '$old', content: { msgtype: 'm.text', body: 'stale directive' } };
    const liveEvent = { type: 'm.room.message', sender: '@alice:hs', event_id: '$new', content: { msgtype: 'm.text', body: 'fresh' } };
    const fakeFetch = async (url, opts) => {
      calls.push({ url, method: (opts && opts.method) || 'GET', body: opts && opts.body });
      if (/\/account\/whoami$/.test(url)) return jres(200, { user_id: '@bot:hs' });
      // the initial sync carries every room's summary; the live sync carries one only when membership changed
      if (/\/sync\?timeout=0$/.test(url)) return jres(200, { next_batch: 's1', rooms: { join: { '!r:hs': { summary: { 'm.joined_member_count': 2 }, timeline: { events: [backlogEvent] } }, '!big:hs': { summary: { 'm.joined_member_count': 5 }, timeline: { events: [] } } } } });
      if (/\/sync\?timeout=30000&since=s1$/.test(url)) return jres(200, { next_batch: 's2', rooms: { join: { '!r:hs': { timeline: { events: [liveEvent] } }, '!big:hs': { timeline: { events: [liveEvent] } }, '!new:hs': { timeline: { events: [liveEvent] } } } } });
      if (/\/send\/m\.room\.message\//.test(url)) return jres(200, { event_id: '$sent' });
      return jres(404, { errcode: 'M_NOT_FOUND' });
    };
    let n = 0;
    const t = makeMatrixTransport({ fetch: fakeFetch, token: 'tok', homeserver: 'https://hs.example/', newId: () => 'txn' + (++n) });
    const first = await t.getUpdates({ timeoutSec: 30 });
    A.eq(first, [], 'the FIRST sync is discarded — a restart never replays the backlog');
    A.eq(t._internals.selfId, '@bot:hs', 'whoami resolved the self id once');
    const second = await t.getUpdates({ timeoutSec: 30 });
    A.eq(second.length, 3, 'the live sync yields the fresh events');
    A.eq(second[0].roomId, '!r:hs', 'raw update carries the room id');
    A.eq(second[0].selfId, '@bot:hs', 'raw update is annotated with selfId for the pure normalize');
    A.eq(second.map(r => r.joinedMembers), [2, 5, null], 'member counts harvested from the discarded initial sync ride every raw update (unknown room -> null)');
    A.eq(normalize(second[1]).message.chatType, 'group', 'a shared room reaches the adapter as a group, not an owner-gated dm');
    A.eq(t._internals.since, 's2', 'since advances per successful sync');
    const auth = calls.find(c => /whoami/.test(c.url));
    A.ok(!/tok/.test(auth.url), 'the access token never appears in a URL');
    const sr = await t.send('!r:hs', 'hello', {});
    A.eq(sr, { ok: true, messageId: '$sent' }, 'send returns the event id');
    const put = calls[calls.length - 1];
    A.eq(put.method, 'PUT', 'send is an idempotent PUT');
    A.ok(/\/rooms\/!r%3Ahs\/send\/m\.room\.message\/txn1$/.test(put.url), 'send URL carries the encoded room + injected txn id');
    A.eq(JSON.parse(put.body), { msgtype: 'm.text', body: 'hello' }, 'send body is a plain m.text event');
  }

  // ---- C. transport error classes: 401 fatal, 429 retryable with retryAfter, network throw retryable ----
  {
    const t401 = makeMatrixTransport({ fetch: async () => jres(401, { errcode: 'M_UNKNOWN_TOKEN', error: 'bad token' }), token: 'x', homeserver: 'https://hs', newId: () => 't' });
    let err = null; try { await t401.getUpdates({}); } catch (e) { err = e; }
    A.ok(err && err.fatal === true, 'a 401/M_UNKNOWN_TOKEN sync is FATAL (stop polling for good)');

    const seq = [jres(200, { user_id: '@b:hs' }), jres(200, { next_batch: 's1' })];
    const t429 = makeMatrixTransport({
      fetch: async (url) => { if (seq.length) return seq.shift(); return jres(429, { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 2000 }); },
      token: 'x', homeserver: 'https://hs', newId: () => 't'
    });
    await t429.getUpdates({});   // whoami + primed discard
    const r = await t429.send('!r:hs', 'x', {});
    A.eq(r.ok, false, '429 send fails');
    A.eq(r.retryable, true, '429 send is retryable');
    A.eq(r.retryAfter, 2, 'retry_after_ms surfaces in seconds for the adapter\'s bounded wait');

    const tNet = makeMatrixTransport({ fetch: async () => { throw new Error('ECONNREFUSED'); }, token: 'x', homeserver: 'https://hs', newId: () => 't' });
    const rn = await tNet.send('!r:hs', 'x', {});
    A.eq(rn.ok, false, 'network send failure is normalized (never throws)');
    A.eq(rn.retryable, true, 'network send failure is retryable');
  }

  // ---- D. binding end-to-end: adapter + fake transport honors normalize + owner trust-on-first-use ----
  {
    const seq = [
      [{ roomId: '!r:hs', event: { type: 'm.room.message', sender: '@stranger:hs', event_id: '$s', content: { msgtype: 'm.text', body: 'steal it' } }, selfId: '@bot:hs' },
       { roomId: '!r:hs', event: { type: 'm.room.message', sender: '@owner:hs', event_id: '$o', content: { msgtype: 'm.text', body: 'owner msg' } }, selfId: '@bot:hs' }]
    ];
    const inbound = [];
    const transport = {
      getUpdates: async () => seq.length ? seq.shift() : (await new Promise(r => setTimeout(() => r([]), 1))),
      send: async () => ({ ok: true, messageId: 'm' })
    };
    const ad = makeMatrixAdapter({ transport, clock: { now: () => 7 }, ownerUserId: '@owner:hs', onInbound: m => inbound.push(m), sleep: () => Promise.resolve() });
    A.eq(ad.name, 'matrix', 'adapter carries the channel name');
    A.eq(ad.MAX_MESSAGE_LENGTH, 4096, 'adapter declares the matrix limit');
    await ad.connect();
    for (let i = 0; i < 20 && inbound.length < 1; i++) await tick();
    await ad.disconnect();
    A.eq(inbound.length, 1, 'preset owner: the stranger\'s message never reached onInbound');
    A.eq(inbound[0].text, 'owner msg', 'the owner\'s message flowed through');
    A.eq(inbound[0].channel, 'matrix', 'inbound is stamped with the channel');
    A.eq(inbound[0].ts, 7, 'ts comes from the injected clock');
  }

  A.report('channels.matrix.test');
})().catch(e => { console.error(e); process.exit(1); });
