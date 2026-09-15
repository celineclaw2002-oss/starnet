/* node test/channels.discord.test.js — the Discord channel binding (P3.2).
   Mirrors channels.telegram.test.js: the pure normalize() truth table; send() returns a normalized SendResult
   (ok / 4xx not-retryable / 429 retryable+retryAfter / network never-throws); and an end-to-end connect() that
   drains an INJECTED gateway through the real transport+normalize+generic adapter to onInbound. The live
   WebSocket gateway is injected (a fake here), so this is deterministic and touches no real network. */
'use strict';
const A = require('./_assert.js');
const { makeDiscordAdapter, normalize, MAX_MESSAGE_LENGTH } = require('../sidecar/channels/discord.js');
const { makeDiscordTransport } = require('../sidecar/channels/discord.transport.js');

const tick = () => new Promise(r => setTimeout(r, 0));

// a fake fetch: route() decides the response per url; records calls.
function fakeFetch(route) {
  const calls = [];
  const f = async (url, opts) => { calls.push({ url, opts }); return route(url, opts); };
  f.calls = calls;
  return f;
}
function resp(status, body, headers) {
  return { ok: status >= 200 && status < 300, status, async json() { return body; }, headers: { get: k => (headers || {})[k] } };
}

(async () => {
  A.eq(MAX_MESSAGE_LENGTH, 2000, 'Discord per-message cap is 2000');

  // ---- A. normalize() truth table (pure) ----
  {
    const dm = normalize({ id: '900', channel_id: '111', content: 'hi', author: { id: '5', username: 'andro', global_name: 'Andro' } });
    A.eq(dm, { offset: '900', message: { chatId: '111', chatType: 'dm', userId: '5', userName: 'Andro', text: 'hi', messageId: '900' } }, 'a DM -> normalized message (global_name preferred)');
    const guild = normalize({ id: '901', channel_id: '222', guild_id: '7', content: 'yo', author: { id: '6', username: 'bob' } });
    A.eq(guild.message.chatType, 'group', 'a guild message -> group');
    A.eq(guild.message.userName, 'bob', 'falls back to username when no global_name');
    A.eq(normalize({ id: '902', channel_id: '111', content: 'beep', author: { id: '9', username: 'botto', bot: true } }), { offset: '902', message: null }, 'a bot/self message -> message:null (advance, deliver nothing)');
    A.eq(normalize({ id: '903', channel_id: '111', author: { id: '5' } }), { offset: '903', message: null }, 'a non-text payload -> message:null');
    A.eq(normalize({ channel_id: '111', content: 'x' }), null, 'no id -> null (skipped)');
  }

  // ---- B. send(): ok / 4xx / 429 / network ----
  {
    const okF = fakeFetch(() => resp(200, { id: '42' }));
    const t1 = makeDiscordTransport({ fetch: okF, token: 'T' });
    A.eq(await t1.send('111', 'hello'), { ok: true, messageId: '42' }, 'a 200 -> ok with messageId');
    A.ok(okF.calls[0].url.indexOf('/channels/111/messages') !== -1, 'POSTs to the channel messages endpoint');
    A.ok(JSON.parse(okF.calls[0].opts.body).content === 'hello', 'sends the content');

    const t2 = makeDiscordTransport({ fetch: fakeFetch(() => resp(403, { message: 'Missing Access' })), token: 'T' });
    const r403 = await t2.send('111', 'x');
    A.eq(r403.ok, false, '403 -> not ok'); A.eq(r403.retryable, false, '403 is not retryable (bad token/permission)');

    const t3 = makeDiscordTransport({ fetch: fakeFetch(() => resp(429, {}, { 'retry-after': '2' })), token: 'T' });
    const r429 = await t3.send('111', 'x');
    A.eq(r429.retryable, true, '429 -> retryable'); A.eq(r429.retryAfter, 2, '429 carries retry-after');

    const t4 = makeDiscordTransport({ fetch: async () => { throw new Error('socket hang up'); }, token: 'T' });
    const rNet = await t4.send('111', 'x');
    A.eq(rNet.ok, false, 'a network error never throws -> SendResult'); A.eq(rNet.retryable, true, 'a network blip is retryable');
  }

  // ---- C. end-to-end: an injected gateway feeds a DM -> onInbound via the real pipeline ----
  {
    const inbox = [];
    // the fake gateway pushes one DM synchronously when the transport opens it (real WS would push post-identify).
    const connectGateway = ({ onMessage }) => {
      onMessage({ id: '950', channel_id: '777', content: 'ping', author: { id: '1', username: 'a' } });
      return { close() {} };
    };
    const okF = fakeFetch(() => resp(200, { id: '1' }));
    const transport = makeDiscordTransport({ fetch: okF, token: 'T', connectGateway, parkMs: 1, sleep: () => Promise.resolve() });
    // dropPending OFF so the first poll IS the delivery (the gateway doesn't replay history anyway).
    const a = makeDiscordAdapter({ transport, onInbound: m => inbox.push(m), clock: { now: () => 1234 }, dropPendingOnConnect: false, allowTrustOnFirstUse: true });
    await a.connect();
    for (let i = 0; i < 20 && !inbox.length; i++) await tick();
    A.eq(inbox.length, 1, 'end-to-end: one inbound delivered');
    A.eq(inbox[0], { channel: 'discord', chatId: '777', chatType: 'dm', userId: '1', userName: 'a', text: 'ping', messageId: '950', ts: 1234 }, 'normalized InboundMessage via the real transport+normalize+adapter');
    await a.disconnect();
  }

  // ---- D. DM ownership: first Discord DM claims owner; preset owner survives restart/refuses strangers ----
  {
    const inbox = [], claims = [];
    const connectGateway = ({ onMessage }) => {
      onMessage({ id: '960', channel_id: 'a', content: 'first', author: { id: 'owner', username: 'o' } });
      onMessage({ id: '961', channel_id: 'b', content: 'takeover', author: { id: 'stranger', username: 's' } });
      onMessage({ id: '962', channel_id: 'a', content: 'again', author: { id: 'owner', username: 'o' } });
      return { close() {} };
    };
    const transport = makeDiscordTransport({ fetch: fakeFetch(() => resp(200, { id: '1' })), token: 'T', connectGateway, parkMs: 1, sleep: () => Promise.resolve() });
    const a = makeDiscordAdapter({
      transport, onInbound: m => inbox.push(m), onOwnerClaim: u => claims.push(u),
      clock: { now: () => 1 }, dropPendingOnConnect: false, allowTrustOnFirstUse: true   // legacy first-DM claim: explicit test-only opt-in (the host never sets it)
    });
    await a.connect();
    for (let i = 0; i < 20 && inbox.length < 2; i++) await tick();
    A.eq(inbox.map(m => m.text), ['first', 'again'], 'first Discord DM claims owner; a different user is dropped');
    A.eq(claims, ['owner'], 'Discord owner claim callback fires once with the first userId');
    A.eq(a._internals.owner, 'owner', 'Discord adapter records the claimed owner');
    await a.disconnect();
  }
  {
    const inbox = [], claims = [];
    const connectGateway = ({ onMessage }) => {
      onMessage({ id: '970', channel_id: 'x', content: 'reclaim', author: { id: 'stranger', username: 's' } });
      onMessage({ id: '971', channel_id: 'y', content: 'owner-ok', author: { id: 'owner', username: 'o' } });
      return { close() {} };
    };
    const transport = makeDiscordTransport({ fetch: fakeFetch(() => resp(200, { id: '1' })), token: 'T', connectGateway, parkMs: 1, sleep: () => Promise.resolve() });
    const a = makeDiscordAdapter({
      transport, ownerUserId: 'owner', onInbound: m => inbox.push(m), onOwnerClaim: u => claims.push(u),
      clock: { now: () => 1 }, dropPendingOnConnect: false
    });
    await a.connect();
    for (let i = 0; i < 20 && inbox.length < 1; i++) await tick();
    A.eq(inbox.map(m => m.text), ['owner-ok'], 'preset Discord owner survives restart; first stranger DM cannot reclaim');
    A.eq(claims, [], 'preset owner does not emit a new claim');
    await a.disconnect();
  }

  A.report('channels.discord.test');
})().catch(e => { console.error(e); process.exit(1); });
