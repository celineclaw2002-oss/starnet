/* node test/channels.adapter.test.js — the generic transport-agnostic channel adapter (C1).
   A FAKE transport (no network) drives the inbound poll/normalize/admission/onInbound pipeline, the
   offset advance, the DM/allowlist admission gate, the bounded send-retry, and clean disconnect.
   Pure + deterministic: ts comes from an injected fixed clock; an injected instant `sleep`. */
'use strict';
const A = require('./_assert.js');
const { makeChannelAdapter, normalizeAllowed } = require('../sidecar/channels/adapter.js');

const tick = () => new Promise(r => setTimeout(r, 0));   // let the detached poll loop make progress
const CLOCK = { now: () => 1000 };

// A fake transport: getUpdates drains a queue of raw-update batches; once empty it PARKS (mimicking a
// long-poll waiting for traffic) until disconnect aborts it. send() records calls and replays scripted results.
function fakeTransport(batches, sendResults) {
  const queue = batches.slice();
  const pollOffsets = [];      // the offset passed to each getUpdates call (proves advancement)
  const sends = [];            // every send() call
  const results = (sendResults || []).slice();
  return {
    pollOffsets, sends,
    getUpdates({ offset, signal }) {
      pollOffsets.push(offset);
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        if (signal && signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        signal && signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
      });
    },
    send(chatId, text, opts) {
      sends.push({ chatId, text, opts });
      const r = results.length ? results.shift() : { ok: true, messageId: 'm' + sends.length };
      return Promise.resolve(r);
    }
  };
}

// Telegram-ish normalize: an update either carries a message or a callback; a non-text update -> null (ignored).
function normalize(ru) {
  if (ru.cb) return { offset: ru.id, callback: { chatId: ru.cb.chat, userId: ru.cb.user, data: ru.cb.data, callbackId: ru.cb.id } };
  if (ru.text == null) return { offset: ru.id, message: null };   // e.g. a sticker/photo update -> drop, just advance offset
  return { offset: ru.id, message: { chatId: ru.chat, chatType: ru.type, userId: ru.user, userName: ru.uname, text: ru.text, messageId: ru.mid } };
}

async function run() {
  // ---- A. a DM update flows through to onInbound, fully normalized, ts from the injected clock ----
  {
    const inbox = [];
    const t = fakeTransport([[{ id: 10, chat: 'c1', type: 'dm', user: 'u1', uname: 'andro', text: 'hello', mid: '500' }]]);
    const a = makeChannelAdapter({ transport: t, normalize, name: 'telegram', allowTrustOnFirstUse: true, maxMessageLength: 4096,
      onInbound: m => inbox.push(m), clock: CLOCK, sleep: () => Promise.resolve() });
    await a.connect();
    for (let i = 0; i < 4 && !inbox.length; i++) await tick();
    A.eq(inbox.length, 1, 'one DM delivered to onInbound');
    A.eq(inbox[0], { channel: 'telegram', chatId: 'c1', chatType: 'dm', userId: 'u1', userName: 'andro', text: 'hello', messageId: '500', ts: 1000 }, 'InboundMessage normalized with ts from clock');
    await a.disconnect();
  }

  // ---- B. admission: DM always allowed; a group only if whitelisted ----
  {
    const inbox = [];
    const t = fakeTransport([[
      { id: 1, chat: 'g_open', type: 'group', user: 'u', text: 'no', mid: '1' },     // group, NOT allowed -> dropped
      { id: 2, chat: 'g_ok', type: 'group', user: 'u', text: 'yes', mid: '2' },      // group, allowed -> passes
      { id: 3, chat: 'dm1', type: 'dm', user: 'u', text: 'dm', mid: '3' }            // dm -> always passes
    ]]);
    const a = makeChannelAdapter({ transport: t, normalize, name: 'telegram', allowTrustOnFirstUse: true, allowedChats: ['g_ok'],
      onInbound: m => inbox.push(m), clock: CLOCK, sleep: () => Promise.resolve() });
    await a.connect();
    for (let i = 0; i < 5 && inbox.length < 2; i++) await tick();
    A.eq(inbox.map(m => m.chatId), ['g_ok', 'dm1'], 'unlisted group dropped; listed group + dm admitted');
    await a.disconnect();
  }

  // ---- B1. NO trust-on-first-use: an unclaimed adapter with no enrollment hook admits NOBODY ----
  {
    const inbox = [], claims = [];
    const t = fakeTransport([[
      { id: 1, chat: 'dmA', type: 'dm', user: 'u1', text: 'first', mid: '1' },      // would have claimed ownership before
      { id: 2, chat: 'dmA', type: 'dm', user: 'u1', text: 'again', mid: '2' }
    ]]);
    const a = makeChannelAdapter({ transport: t, normalize, name: 'telegram',
      onInbound: m => inbox.push(m), onOwnerClaim: u => claims.push(u), clock: CLOCK, sleep: () => Promise.resolve() });
    await a.connect();
    for (let i = 0; i < 6; i++) await tick();
    A.eq(inbox, [], 'default: the first DM does NOT claim the bot — nothing reaches onInbound');
    A.eq(claims, [], 'no owner claim fires without an enrollment hook');
    A.eq(a._internals.owner, '', 'the adapter stays unclaimed');
    A.eq(t.sends, [], 'and the stranger gets no reply (silent drop)');
    await a.disconnect();
    // the host wiring never opts into the legacy first-DM claim; every platform forwards the /pair hook instead
    const fs = require('fs'), path = require('path');
    const idx = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');
    A.ok(!/allowTrustOnFirstUse/.test(idx), 'sidecar/index.js never sets allowTrustOnFirstUse');
    A.ok((idx.match(/ownerAdmission: \(message\) => channelOwnerAdmission\(/g) || []).length >= 4, 'telegram (station + agent bots), discord and the generic channels all wire the /pair admission hook');
    for (const mod of ['discord', 'slack', 'matrix', 'signal', 'telegram']) {
      const src = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'channels', mod + '.js'), 'utf8');
      A.ok(/ownerAdmission: o\.ownerAdmission/.test(src), mod + '.js forwards ownerAdmission to the generic adapter');
    }
  }

  // ---- B2. owner-only DM admission (LEGACY first-DM claim, explicit test-only opt-in): first DM claims owner;
  //      other users denied; preset owner skips claim ----
  {
    const inbox = [], claims = [];
    const t = fakeTransport([[
      { id: 1, chat: 'dmA', type: 'dm', user: 'u1', text: 'first', mid: '1' },      // claims ownership
      { id: 2, chat: 'dmB', type: 'dm', user: 'u2', text: 'intruder', mid: '2' },   // different user -> dropped
      { id: 3, chat: 'dmA', type: 'dm', user: 'u1', text: 'again', mid: '3' }        // owner -> admitted
    ]]);
    const a = makeChannelAdapter({ transport: t, normalize, name: 'telegram', allowTrustOnFirstUse: true,
      onInbound: m => inbox.push(m), onOwnerClaim: u => claims.push(u), clock: CLOCK, sleep: () => Promise.resolve() });
    await a.connect();
    for (let i = 0; i < 6 && inbox.length < 2; i++) await tick();
    A.eq(inbox.map(m => m.text), ['first', 'again'], 'first DM claims owner; a different user is dropped; owner re-admitted');
    A.eq(claims, ['u1'], 'onOwnerClaim fired once with the first userId');
    A.eq(a._internals.owner, 'u1', 'owner recorded on the adapter');
    await a.disconnect();
  }
  {
    const inbox = [], claims = [];
    const t = fakeTransport([[
      { id: 1, chat: 'dmX', type: 'dm', user: 'stranger', text: 'hi', mid: '1' },    // not the preset owner -> dropped
      { id: 2, chat: 'dmO', type: 'dm', user: 'boss', text: 'yo', mid: '2' }          // preset owner -> admitted
    ]]);
    const a = makeChannelAdapter({ transport: t, normalize, name: 'telegram', ownerUserId: 'boss',
      onInbound: m => inbox.push(m), onOwnerClaim: u => claims.push(u), clock: CLOCK, sleep: () => Promise.resolve() });
    await a.connect();
    for (let i = 0; i < 6 && !inbox.length; i++) await tick();
    A.eq(inbox.map(m => m.text), ['yo'], 'preset owner: only the owner is admitted, stranger dropped');
    A.eq(claims, [], 'no claim fires when owner is preset');
    await a.disconnect();
  }
  {
    // owner gate is DM-only: a whitelisted GROUP message from any user is still admitted
    const inbox = [];
    const t = fakeTransport([[{ id: 1, chat: 'g_ok', type: 'group', user: 'whoever', text: 'grp', mid: '1' }]]);
    const a = makeChannelAdapter({ transport: t, normalize, name: 'telegram', ownerUserId: 'boss', allowedChats: ['g_ok'],
      onInbound: m => inbox.push(m), clock: CLOCK, sleep: () => Promise.resolve() });
    await a.connect();
    for (let i = 0; i < 5 && !inbox.length; i++) await tick();
    A.eq(inbox.map(m => m.chatId), ['g_ok'], 'group admission is unaffected by the DM owner gate');
    await a.disconnect();
  }

  // ---- B2a. explicit owner enrollment: an unclaimed bot stays silent until a local pairing callback admits it ----
  {
    const inbox = [], claims = [];
    const t = fakeTransport([[
      { id: 1, chat: 'dmA', type: 'dm', user: 'stranger', text: 'hello', mid: '1' },
      { id: 2, chat: 'dmA', type: 'dm', user: 'owner', text: '/pair ABCDE-FGHIJ', mid: '2' },
      { id: 3, chat: 'dmA', type: 'dm', user: 'owner', text: 'run this', mid: '3' }
    ]]);
    const a = makeChannelAdapter({ transport: t, normalize, name: 'telegram', allowTrustOnFirstUse: true,
      onInbound: m => inbox.push(m), onOwnerClaim: u => claims.push(u),
      ownerAdmission: (m, uid) => (uid === 'owner' && m.text === '/pair ABCDE-FGHIJ')
        ? { allow: true, consume: true, reply: 'Owner paired.' } : false,
      clock: CLOCK, sleep: () => Promise.resolve() });
    await a.connect();
    for (let i = 0; i < 8 && !inbox.length; i++) await tick();
    A.eq(claims, ['owner'], 'only a valid local enrollment can claim an unclaimed bot');
    A.eq(inbox.filter(m => !m.directReply).map(m => m.text), ['run this'], 'the pairing exchange never reaches the agent transcript');
    A.eq(inbox.filter(m => m.directReply).map(m => m.directReply), ['Owner paired.'], 'the owner acknowledgement enters the durable direct-reply path');
    A.eq(t.sends, [], 'the adapter never bypasses the hub/outbox for enrollment acknowledgements');
    await a.disconnect();
  }

  // ---- B4. dropPendingOnConnect: prime the offset past the backlog and discard it (no stale replay) ----
  {
    const inbox = [];
    const t = fakeTransport([
      [{ id: 100, chat: 'c', type: 'dm', user: 'u', text: 'STALE', mid: '1' }],   // prime poll (offset:-1) -> dropped
      [{ id: 101, chat: 'c', type: 'dm', user: 'u', text: 'fresh', mid: '2' }]     // first real poll -> delivered
    ]);
    const a = makeChannelAdapter({ transport: t, normalize, name: 'telegram', ownerUserId: 'u', dropPendingOnConnect: true,
      onInbound: m => inbox.push(m), clock: CLOCK, sleep: () => Promise.resolve() });
    await a.connect();
    for (let i = 0; i < 6 && !inbox.length; i++) await tick();
    A.eq(inbox.map(m => m.text), ['fresh'], 'offline backlog discarded on connect; only fresh delivered');
    A.eq(t.pollOffsets[0], -1, 'prime poll uses offset -1');
    A.eq(t.pollOffsets[1], 101, 'real poll seeded to last-backlog-id + 1');
    await a.disconnect();
  }
  {
    // generic default is OFF: without the flag the backlog IS delivered (no prime poll)
    const inbox = [];
    const t = fakeTransport([[{ id: 5, chat: 'c', type: 'dm', user: 'u', text: 'backlog', mid: '1' }]]);
    const a = makeChannelAdapter({ transport: t, normalize, name: 'telegram', ownerUserId: 'u',
      onInbound: m => inbox.push(m), clock: CLOCK, sleep: () => Promise.resolve() });
    await a.connect();
    for (let i = 0; i < 5 && !inbox.length; i++) await tick();
    A.eq(inbox.map(m => m.text), ['backlog'], 'generic adapter default OFF: backlog delivered');
    A.eq(t.pollOffsets[0], 0, 'no prime poll when drop-pending is off');
    await a.disconnect();
  }

  // ---- B4b. dropPendingOnConnect posts a ONE-LINE "I was offline" notice per chat whose backlog was discarded
  //           (honesty: the message arrived and was NOT processed) — best-effort, counted, admitted-only. ----
  {
    const inbox = [];
    const t = fakeTransport([
      // prime poll (offset:-1) returns the whole discarded backlog: 2 from the owner's DM, 1 stranger DM (never
      // admitted -> no apology, no key spend), 1 from a whitelisted group.
      [
        { id: 200, chat: 'c', type: 'dm', user: 'u', text: 'stale1', mid: '1' },
        { id: 201, chat: 'c', type: 'dm', user: 'u', text: 'stale2', mid: '2' },
        { id: 202, chat: 'evil', type: 'dm', user: 'stranger', text: 'stale', mid: '3' },
        { id: 203, chat: 'g', type: 'group', user: 'u', text: 'stale', mid: '4' }
      ],
      []   // first real poll: nothing new
    ]);
    const a = makeChannelAdapter({ transport: t, normalize, name: 'telegram', ownerUserId: 'u',
      allowedChats: ['g'], dropPendingOnConnect: true,
      onInbound: m => inbox.push(m), clock: CLOCK, sleep: () => Promise.resolve() });
    await a.connect();
    for (let i = 0; i < 8 && t.sends.length < 2; i++) await tick();
    A.eq(inbox.length, 0, 'backlog is discarded, not dispatched');
    const byChat = {}; for (const s of t.sends) byChat[s.chatId] = s.text;
    A.eq(Object.keys(byChat).sort(), ['c', 'g'], 'notice goes to the owner DM + whitelisted group only (stranger DM skipped)');
    // The notice states NO count on purpose. In production getUpdates({offset:-1}) returns only the LAST
    // pending update, yet advancing past it discards every earlier one too — so any tally would under-report
    // what was actually dropped. It asks for a resend instead, which is true whatever the real number was.
    A.ok(/I was offline/.test(byChat['c']) && /resend/i.test(byChat['c']), 'owner DM notice says it was offline and asks for a resend');
    A.ok(/I was offline/.test(byChat['g']) && /resend/i.test(byChat['g']), 'group notice says the same');
    A.ok(!/\d+ messages? arrived/.test(byChat['c']), 'and claims NO count it cannot actually prove');
    await a.disconnect();
  }

  // ---- B4c. FIRST-RUN SILENCE: backlog discarded while the owner was still UNCLAIMED ----
  // Ownership must never be claimed from stale backlog, and a stranger who found a discoverable bot must never
  // get a reply — so the apology cannot be sent at connect. It is DEFERRED until that chat proves it is the
  // owner by sending a live message. Before this, a first-time user who messaged a stopped bot got pure
  // silence, which is indistinguishable from a broken bot (hit twice during the 2026-07-24 live walk).
  {
    // (i) nobody has proven ownership yet -> the apology is WITHHELD, not sent into the dark.
    // The queue is exhausted after the prime batch, so the poll parks and no message can ever be admitted.
    const t = fakeTransport([
      [{ id: 400, chat: 'c', type: 'dm', user: 'u', text: 'sent while it was down', mid: '1' }]
    ]);
    const a = makeChannelAdapter({ transport: t, normalize, name: 'telegram', allowTrustOnFirstUse: true, dropPendingOnConnect: true,
      onInbound: () => {}, clock: CLOCK, sleep: () => Promise.resolve() });
    await a.connect();
    for (let i = 0; i < 8; i++) await tick();
    A.eq(t.sends.length, 0, 'NOTHING is sent at connect — no chat has proven it is the owner');
    await a.disconnect();
  }
  {
    // (ii) the same chat then sends a LIVE message, which claims ownership -> the apology is paid, exactly once.
    const inbox = [];
    const t = fakeTransport([
      [{ id: 400, chat: 'c', type: 'dm', user: 'u', text: 'sent while it was down', mid: '1' }],
      [{ id: 401, chat: 'c', type: 'dm', user: 'u', text: 'live one', mid: '2' }],
      [{ id: 402, chat: 'c', type: 'dm', user: 'u', text: 'live two', mid: '3' }]
    ]);
    const a = makeChannelAdapter({ transport: t, normalize, name: 'telegram', allowTrustOnFirstUse: true, dropPendingOnConnect: true,
      onInbound: m => inbox.push(m), clock: CLOCK, sleep: () => Promise.resolve() });
    await a.connect();
    for (let i = 0; i < 12 && inbox.length < 2; i++) await tick();
    A.eq(inbox.map(m => m.text), ['live one', 'live two'], 'both live messages are admitted (the first claims ownership)');
    for (let i = 0; i < 8 && !t.sends.length; i++) await tick();
    A.eq(t.sends.length, 1, 'the deferred apology fires ONCE, on the message that proved ownership — not per message');
    A.eq(t.sends[0].chatId, 'c', 'and goes to that chat');
    A.ok(/I was offline/.test(t.sends[0].text) && /resend/i.test(t.sends[0].text), 'carrying the offline notice');
    await a.disconnect();
  }

  // ---- B4d. a STRANGER whose backlog was dropped is never answered, even after someone else claims ----
  {
    const inbox = [];
    const t = fakeTransport([
      [{ id: 500, chat: 'evil', type: 'dm', user: 'stranger', text: 'stale', mid: '1' }],
      [{ id: 501, chat: 'c', type: 'dm', user: 'u', text: 'owner here', mid: '2' }],
      []
    ]);
    const a = makeChannelAdapter({ transport: t, normalize, name: 'telegram', allowTrustOnFirstUse: true, dropPendingOnConnect: true,
      onInbound: m => inbox.push(m), clock: CLOCK, sleep: () => Promise.resolve() });
    await a.connect();
    for (let i = 0; i < 10 && !inbox.length; i++) await tick();
    A.eq(inbox.map(m => m.text), ['owner here'], 'the owner claims the bot');
    for (let i = 0; i < 6; i++) await tick();
    A.eq(t.sends.filter(s => s.chatId === 'evil').length, 0, 'the stranger is NEVER answered — owner-only silence holds');
    await a.disconnect();
  }
  {
    // a throwing send must NOT stop connect — the notice is best-effort; the real poll still runs.
    const inbox = [];
    const t = fakeTransport([
      [{ id: 300, chat: 'c', type: 'dm', user: 'u', text: 'stale', mid: '1' }],
      [{ id: 301, chat: 'c', type: 'dm', user: 'u', text: 'fresh', mid: '2' }]
    ]);
    t.send = () => Promise.reject(new Error('boom'));   // every notice send throws
    const a = makeChannelAdapter({ transport: t, normalize, name: 'telegram', ownerUserId: 'u', dropPendingOnConnect: true,
      onInbound: m => inbox.push(m), clock: CLOCK, sleep: () => Promise.resolve() });
    await a.connect();
    for (let i = 0; i < 8 && !inbox.length; i++) await tick();
    A.eq(inbox.map(m => m.text), ['fresh'], 'a throwing offline-notice send does not stop connect; fresh still delivered');
    await a.disconnect();
  }

  // ---- C. offset advances past processed update ids (each update fetched once) ----
  {
    const inbox = [];
    const t = fakeTransport([
      [{ id: 10, chat: 'c', type: 'dm', user: 'u', text: 'a', mid: '1' }],
      [{ id: 11, chat: 'c', type: 'dm', user: 'u', text: 'b', mid: '2' }]
    ]);
    const a = makeChannelAdapter({ transport: t, normalize, name: 'telegram', allowTrustOnFirstUse: true,
      onInbound: m => inbox.push(m), clock: CLOCK, sleep: () => Promise.resolve() });
    await a.connect();
    for (let i = 0; i < 6 && inbox.length < 2; i++) await tick();
    A.eq(inbox.length, 2, 'both batches processed');
    A.eq(t.pollOffsets[0], 0, 'first getUpdates uses initial offset 0');
    A.eq(t.pollOffsets[1], 11, 'second getUpdates advanced to lastId(10)+1');
    A.ok(t.pollOffsets[2] === 12, 'third getUpdates advanced to lastId(11)+1');
    await a.disconnect();
  }

  // ---- C2. a synchronous durable-intake failure is never acknowledged to the transport ----
  {
    const inbox = [];
    const update = [{ id: 20, chat: 'c', type: 'dm', user: 'u', text: 'must survive', mid: '20' }];
    const t = fakeTransport([update, update]);   // Telegram redelivers because the first offset was not advanced
    let claims = 0;
    const a = makeChannelAdapter({ transport: t, normalize, name: 'telegram', allowTrustOnFirstUse: true,
      onInbound: m => { claims++; if (claims === 1) throw new Error('disk unavailable'); inbox.push(m); },
      clock: CLOCK, sleep: () => Promise.resolve() });
    await a.connect();
    for (let i = 0; i < 8 && !inbox.length; i++) await tick();
    A.eq(t.pollOffsets.slice(0, 3), [0, 0, 21], 'failed durable claim keeps offset 0; successful retry advances to 21');
    A.eq(inbox.map(m => m.text), ['must survive'], 'the redelivered update reaches the handler exactly once after storage recovers');
    await a.disconnect();
  }

  // ---- D. send sends ONE message; a retryable failure gets exactly one resend; non-retryable does not ----
  {
    const t = fakeTransport([[]], [
      { ok: true, messageId: 'ok1' },
      { ok: false, retryable: true }, { ok: true, messageId: 'ok2' },   // resend succeeds
      { ok: false, retryable: false }                                    // hard fail: no resend
    ]);
    const a = makeChannelAdapter({ transport: t, normalize, name: 'telegram', allowTrustOnFirstUse: true,
      onInbound: () => {}, clock: CLOCK, sleep: () => Promise.resolve() });
    const r1 = await a.send('c', 'hi');
    A.eq(t.sends.length, 1, 'ok send -> one transport call');
    A.eq(r1.messageId, 'ok1', 'returns the transport result');
    const r2 = await a.send('c', 'retry me');
    A.eq(t.sends.length, 3, 'retryable failure -> exactly one bounded resend (total 2 more calls)');
    A.eq(r2.messageId, 'ok2', 'resend result returned');
    const r3 = await a.send('c', 'hard fail');
    A.eq(t.sends.length, 4, 'non-retryable failure -> no resend');
    A.eq(r3.ok, false, 'hard failure surfaced');
  }

  // ---- D2. send honors 429 retry_after: WAIT the server window before the one-shot resend ----
  {
    const waits = [];
    const t = fakeTransport([[]], [{ ok: false, retryable: true, retryAfter: 3 }, { ok: true, messageId: 'ok' }]);
    const a = makeChannelAdapter({ transport: t, normalize, name: 'telegram', allowTrustOnFirstUse: true,
      onInbound: () => {}, clock: CLOCK, sleep: (ms) => { waits.push(ms); return Promise.resolve(); } });
    const r = await a.send('c', 'flooded');
    A.eq(t.sends.length, 2, 'resend fired (after the wait)');
    A.eq(r.messageId, 'ok', 'resend result returned');
    A.ok(waits.indexOf(3000) !== -1, 'waited retry_after (3s) before the resend');
  }

  // ---- D3. poll health and delivery health are separate, with the final retry verdict reported ----
  {
    const delivery = [];
    const t = fakeTransport([[]], [{ ok: false, retryable: true, error: 'temporary' }, { ok: false, retryable: false, error: 'blocked' }]);
    const a = makeChannelAdapter({ transport: t, normalize, name: 'telegram', allowTrustOnFirstUse: true, onInbound: () => {}, clock: CLOCK,
      sleep: () => Promise.resolve(), onDelivery: d => delivery.push(d) });
    await a.send('chat-1', 'reply');
    A.eq(delivery.length, 1, 'one aggregate delivery outcome after bounded retry');
    A.eq(delivery[0].ok, false, 'the final send failure is visible even while inbound polling may remain healthy');
    A.eq(delivery[0].attempts, 2, 'health reports both bounded send attempts');
    A.eq(delivery[0].detail, 'blocked', 'health exposes the transport-sanitized final reason only');
  }

  // ---- E. disconnect stops the loop; no further onInbound; the parked getUpdates aborts cleanly ----
  {
    const inbox = [];
    const t = fakeTransport([[{ id: 1, chat: 'c', type: 'dm', user: 'u', text: 'x', mid: '1' }]]);
    const a = makeChannelAdapter({ transport: t, normalize, name: 'telegram', allowTrustOnFirstUse: true,
      onInbound: m => inbox.push(m), clock: CLOCK, sleep: () => Promise.resolve() });
    await a.connect();
    for (let i = 0; i < 4 && !inbox.length; i++) await tick();
    A.eq(inbox.length, 1, 'one message before disconnect');
    await a.disconnect();
    const before = inbox.length;
    await tick(); await tick();
    A.eq(inbox.length, before, 'no further onInbound after disconnect');
  }

  // ---- F. a non-text update (normalize -> message:null) is ignored but still advances the offset ----
  {
    const inbox = [];
    const t = fakeTransport([[{ id: 7, chat: 'c', type: 'dm', user: 'u' /* no text -> sticker/photo */ }]]);
    const a = makeChannelAdapter({ transport: t, normalize, name: 'telegram', allowTrustOnFirstUse: true,
      onInbound: m => inbox.push(m), clock: CLOCK, sleep: () => Promise.resolve() });
    await a.connect();
    await tick(); await tick();
    A.eq(inbox.length, 0, 'non-text update produced no inbound');
    A.ok(t.pollOffsets.length >= 2 && t.pollOffsets[1] === 8, 'offset still advanced past the ignored update (7+1)');
    await a.disconnect();
  }

  // ---- G. callback updates route to onCallback (C6 consent-button plumbing) — OWNER ONLY ----
  {
    const cbs = [];
    const t = fakeTransport([[{ id: 9, cb: { chat: 'c', user: 'owner1', data: 'approve:p1', id: 'q1' } }]]);
    const a = makeChannelAdapter({ transport: t, normalize, name: 'telegram', ownerUserId: 'owner1',
      onInbound: () => {}, onCallback: c => cbs.push(c), clock: CLOCK, sleep: () => Promise.resolve() });
    await a.connect();
    for (let i = 0; i < 4 && !cbs.length; i++) await tick();
    A.eq(cbs.length, 1, 'the owner\'s callback routes to onCallback');
    A.eq(cbs[0], { chatId: 'c', userId: 'owner1', data: 'approve:p1', callbackId: 'q1' }, 'callback payload normalized');
    await a.disconnect();
  }

  // ---- G2. a NON-owner tap never acts, and an UNCLAIMED owner is not a licence ----
  // Ownership is claimed on the DM path alone, so a bot reachable only in a whitelisted group has
  // owner === '' forever. `!owner ||` used to fail OPEN there, handing any group member the approve/deny
  // buttons. A callback can never be the trust-on-first-use moment: the keyboard is on a message WE sent.
  {
    const cbs = [];
    const t = fakeTransport([[{ id: 11, cb: { chat: 'g', user: 'stranger', data: 'approve:p1', id: 'q2' } }]]);
    const a = makeChannelAdapter({ transport: t, normalize, name: 'telegram', ownerUserId: 'owner1',
      onInbound: () => {}, onCallback: c => cbs.push(c), clock: CLOCK, sleep: () => Promise.resolve() });
    await a.connect();
    await tick(); await tick(); await tick();
    A.eq(cbs.length, 0, 'a stranger\'s tap is dropped when an owner IS claimed');
    await a.disconnect();
  }
  {
    const cbs = [];
    const t = fakeTransport([[{ id: 12, cb: { chat: 'g', user: 'stranger', data: 'approve:p1', id: 'q3' } }]]);
    const a = makeChannelAdapter({ transport: t, normalize, name: 'telegram',   // no ownerUserId: unclaimed
      onInbound: () => {}, onCallback: c => cbs.push(c), clock: CLOCK, sleep: () => Promise.resolve() });
    await a.connect();
    await tick(); await tick(); await tick();
    A.eq(cbs.length, 0, 'an UNCLAIMED owner fails CLOSED — no tap acts until a DM proves who the owner is');
    await a.disconnect();
  }

  // ---- H. one failed request is a blip; sustained failures report down; both retry and recover forever ----
  {
    const statuses = [];
    let calls = 0;
    const transport = {
      getUpdates({ signal }) {
        calls++;
        if (calls === 1) return Promise.reject(new Error('network blip'));            // transient -> backoff
        if (calls === 2) return Promise.resolve([{ id: 1, chat: 'c', type: 'dm', user: 'u', text: 'hi', mid: '1' }]);
        return new Promise((resolve, reject) => {                                     // then park (abortable)
          if (signal && signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          signal && signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        });
      },
      send() { return Promise.resolve({ ok: true }); }
    };
    const inbox = [];
    const a = makeChannelAdapter({ transport, normalize, name: 'telegram', allowTrustOnFirstUse: true,
      onInbound: m => inbox.push(m), onStatus: s => statuses.push(s), clock: CLOCK, sleep: () => Promise.resolve() });
    await a.connect();
    for (let i = 0; i < 8 && !inbox.length; i++) await tick();
    A.eq(inbox.length, 1, 'recovered after a transient error + backoff');
    A.ok(!statuses.some(s => s.state === 'down'), 'one failed poll does not falsely revoke the last proven connection');
    A.ok(statuses.some(s => s.state === 'up'), 'successful retry proves state:up');
    await a.disconnect();
  }

  {
    const statuses = [];
    let calls = 0;
    const transport = {
      getUpdates({ signal }) {
        calls++;
        if (calls <= 2) return Promise.reject(new Error(calls === 1 ? 'network blip' : 'ECONNRESET api.telegram.org'));
        if (calls === 3) return Promise.resolve([]);
        return new Promise((resolve, reject) => {
          if (signal && signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          signal && signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        });
      },
      send() { return Promise.resolve({ ok: true }); }
    };
    const a = makeChannelAdapter({ transport, normalize, name: 'telegram', allowTrustOnFirstUse: true, onInbound: () => {},
      onStatus: s => statuses.push(s), clock: CLOCK, sleep: () => Promise.resolve() });
    await a.connect();
    for (let i = 0; i < 10 && !statuses.some(s => s.state === 'up'); i++) await tick();
    A.eq(statuses.filter(s => s.state === 'down').length, 1, 'two consecutive failures report one sustained outage');
    A.ok(statuses.some(s => s.state === 'down' && /ECONNRESET/.test(s.detail)), 'outage carries the actionable latest cause');
    A.ok(statuses.some(s => s.state === 'up'), 'sustained outage self-heals and emits up without reconnect input');
    await a.disconnect();
  }

  {
    const fatal = Object.assign(new Error('401 unauthorized'), { fatal: true });
    const statuses = [];
    const transport = { getUpdates() { return Promise.reject(fatal); }, send() { return Promise.resolve({ ok: true }); } };
    const a = makeChannelAdapter({ transport, normalize, name: 'telegram', allowTrustOnFirstUse: true,
      onInbound: () => {}, onStatus: s => statuses.push(s), clock: CLOCK, sleep: () => Promise.resolve() });
    await a.connect();
    for (let i = 0; i < 4 && !statuses.length; i++) await tick();
    A.ok(statuses.some(s => s.state === 'error'), 'fatal poll error -> state:error and the loop stops');
    await a.disconnect();
  }

  // ---- H2. a token CONFLICT (Telegram 409) keeps the loop alive on the slow re-probe cadence and SELF-HEALS ----
  // The old behaviour treated 409 as fatal: one transient conflict (webhook-delete race, restart overlap, a
  // briefly-open second instance) killed the poll loop for good, and because `connected` derives from poll
  // state, channel.send died with it. Now: state:'error' once (actionable), keep re-probing, 'up' on recovery.
  {
    const statuses = [];
    let calls = 0, conflictSleeps = 0;
    const conflict = () => Object.assign(new Error('another instance or a webhook is using this bot token'), { conflict: true });
    const transport = {
      getUpdates({ signal }) {
        calls++;
        if (calls <= 3) return Promise.reject(conflict());                             // contested for 3 rounds
        if (calls === 4) return Promise.resolve([{ id: 1, chat: 'c', type: 'dm', user: 'u', text: 'hi', mid: '1' }]);
        return new Promise((resolve, reject) => {                                      // then park (abortable)
          if (signal && signal.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
          signal && signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
        });
      },
      send() { return Promise.resolve({ ok: true }); }
    };
    const inbox = [];
    const a = makeChannelAdapter({ transport, normalize, name: 'telegram', allowTrustOnFirstUse: true, conflictRetryMs: 12345,
      onInbound: m => inbox.push(m), onStatus: s => statuses.push(s), clock: CLOCK,
      sleep: (ms) => { if (ms === 12345) conflictSleeps++; return Promise.resolve(); } });
    await a.connect();
    for (let i = 0; i < 12 && !inbox.length; i++) await tick();
    A.eq(inbox.length, 1, 'a 409 conflict does NOT kill the channel — polling recovered once the contest ended');
    A.eq(statuses.filter(s => s.state === 'error').length, 1, 'the conflict is reported as ONE actionable state:error, not spammed per retry');
    A.ok(statuses.some(s => s.state === 'up'), 'recovery from a conflict emits a real state:up (connected/channel.send come back)');
    A.eq(conflictSleeps, 3, 'each contested round waited the slow conflictRetryMs cadence, not the transient backoff ladder');
    await a.disconnect();
  }

  // ---- I. surface invariants + pure helpers ----
  {
    A.eq([...normalizeAllowed(['a', 1, 'a'])].sort(), ['1', 'a'], 'normalizeAllowed stringifies + dedupes');
    const t = fakeTransport([[]]);
    const a = makeChannelAdapter({ transport: t, normalize, name: 'telegram', allowTrustOnFirstUse: true, maxMessageLength: 4096,
      onInbound: () => {}, clock: CLOCK, sleep: () => Promise.resolve() });
    A.eq(a.name, 'telegram', 'name exposed');
    A.eq(a.MAX_MESSAGE_LENGTH, 4096, 'MAX_MESSAGE_LENGTH exposed');
    A.eq(a._internals.admitted({ chatType: 'dm', chatId: 'x' }), true, 'admitted: dm always true');
    A.eq(a._internals.admitted({ chatType: 'group', chatId: 'x' }), false, 'admitted: unlisted group false');
    await a.disconnect();
    // bad construction throws
    A.throws(() => makeChannelAdapter({ normalize, clock: CLOCK }), 'missing transport throws');
    A.throws(() => makeChannelAdapter({ transport: t, clock: CLOCK }), 'missing normalize throws');
    A.throws(() => makeChannelAdapter({ transport: t, normalize }), 'missing clock throws');
  }

  /* ---- an unparseable update must not WEDGE the channel -------------------------------------------------
     dispatch() swallowed a normalize() throw and returned WITHOUT advancing the offset. getUpdates keeps
     returning everything at-or-after `offset` until a higher one confirms it, so the loop would re-fetch and
     re-throw on that same update forever — a hot spin against the Bot API with every message behind it
     permanently undelivered. One bad update must cost one dropped message, never the whole channel. */
  {
    let calls = 0;
    const boom = (u) => { calls++; if (u && u.update_id === 7) throw new Error('unparseable'); return { offset: u.update_id, message: null }; };
    const t = fakeTransport([[]]);
    const seen = [];
    const a = makeChannelAdapter({ transport: t, normalize: boom, name: 'telegram', maxMessageLength: 4096,
      onInbound: m => seen.push(m), clock: CLOCK, sleep: () => Promise.resolve() });
    const before = a._internals.offset;
    a._internals.dispatch({ update_id: 7, message: { text: 'x', chat: { id: 1, type: 'private' }, from: { id: 9 } } });
    A.ok(a._internals.offset > before, 'a normalize() throw still advances past the bad update');
    A.eq(a._internals.offset, 8, 'the offset lands exactly one past the unparseable update id');
    // and the NEXT, well-formed update is still processed normally — the channel is not deaf afterwards
    a._internals.dispatch({ update_id: 8, message: { text: 'y', chat: { id: 1, type: 'private' }, from: { id: 9 } } });
    A.eq(a._internals.offset, 9, 'the channel keeps moving after skipping the bad one');
    await a.disconnect();
  }

  A.report('channels.adapter.test');
}

run().catch(e => { console.log('FAIL: run() threw — ' + (e && e.stack || e)); process.exit(1); });
