/* node test/channels.telegram.context.test.js — the two "the bot ignored me" gaps (2026-07-29).

   Both are cases where a member did something completely ordinary on their phone and got NOTHING useful back:

     1. SILENT DROPS. A location, a venue, a contact card, a poll, a dice roll or an ANIMATED sticker fell
        through normalize() to message:null. The offset advanced, no run started, and the member watched their
        message land in a chat that never answered — indistinguishable from a dead bot. They now arrive as a
        descriptor line. The boundary that must NOT move: a SERVICE message (joins, leaves, pins, title
        changes) stays silent, or the bot starts narrating the group's own housekeeping.

     2. REPLY CONTEXT. reply_to_message was never read, so the platform's most natural gesture — long-press a
        photo, hit Reply, type "what is this?" — reached the model as three words with the referent missing.
        The quoted text now rides as a fenced preamble and the quoted message's MEDIA is ingested with the turn.

   Pure + fake-driven: normalize() needs no transport, and the hub runs on fake runOnce/store/send/fetchMedia.
   Deterministic — no clock, no network. */
'use strict';
const A = require('./_assert.js');
const { normalize, describeOf, replyOf } = require('../sidecar/channels/telegram.js');
const { makeChannelAdapter } = require('../sidecar/channels/adapter.js');
const { makeChannelHub, replyPreamble } = require('../sidecar/channels/hub.js');

const chat = { id: 111, type: 'private' }, from = { id: 5, username: 'andro' };
const up = (id, extra) => normalize({ update_id: id, message: Object.assign({ message_id: id * 10, chat, from }, extra) });

function fakeStore() {
  const hist = new Map(), appends = [];
  return {
    hist, appends,
    loadHistory(a) { return (hist.get(a) || []).slice(); },
    appendTurn(a, role, content) { const arr = hist.get(a) || []; arr.push({ role, content }); hist.set(a, arr); appends.push({ a, role, content }); return arr; },
    getChatRecord() { return null; }
  };
}
const idGen = () => { let i = 0; return () => 'run' + (++i); };
const dm = (text, chatId) => ({ channel: 'telegram', chatId: chatId || '555', chatType: 'dm', userId: 'u1', text, messageId: '1', ts: 1 });

async function run() {
  // ---- A. SILENT DROPS: every non-file user payload is now describable, and says something USEFUL ----
  {
    const loc = up(1, { location: { latitude: 37.7749, longitude: -122.4194 } });
    A.ok(loc.message, 'a shared location is admitted, not dropped');
    A.ok(/37\.7749/.test(loc.message.text) && /-122\.4194/.test(loc.message.text), 'the coordinates reach the model');

    A.ok(/live location/.test(up(2, { location: { latitude: 1, longitude: 2, live_period: 900 } }).message.text), 'a LIVE location says it is live');

    const ven = up(3, { venue: { title: 'Blue Bottle', address: '1 Ferry Bldg', location: { latitude: 37.79, longitude: -122.39 } } });
    A.ok(/Blue Bottle/.test(ven.message.text) && /1 Ferry Bldg/.test(ven.message.text), 'a venue carries its name AND address');

    const con = up(4, { contact: { first_name: 'Ana', last_name: 'Diaz', phone_number: '+15551234' } });
    A.ok(/Ana Diaz/.test(con.message.text) && /\+15551234/.test(con.message.text), 'a contact card carries the name and number');

    const poll = up(5, { poll: { question: 'ship it?', options: [{ text: 'yes' }, { text: 'not yet' }] } });
    A.ok(/ship it\?/.test(poll.message.text) && /yes/.test(poll.message.text) && /not yet/.test(poll.message.text), 'a poll carries its question and options');

    A.ok(/\b4\b/.test(up(6, { dice: { emoji: '🎲', value: 4 } }).message.text), 'a dice roll carries its value');

    const anim = up(7, { sticker: { file_id: 's1', is_animated: true, emoji: '🔥', set_name: 'Flames' } });
    A.ok(/animated sticker/.test(anim.message.text) && /🔥/.test(anim.message.text), 'an animated sticker carries its emoji instead of vanishing');
    A.eq('media' in anim.message, false, 'an animated sticker still offers no ingestible bytes (honest, not invented)');

    // a STATIC sticker keeps its webp pixels AND gains the label — the model sees the image and knows what it is
    const stat = up(8, { sticker: { file_id: 's2', emoji: '👍' } });
    A.eq(stat.message.media[0].mime, 'image/webp', 'a static sticker still rides as a viewable webp');
    A.ok(/👍/.test(stat.message.text), 'a static sticker is labelled with its emoji');

    // degrade, never throw: every field on the wire is optional
    A.ok(up(9, { location: {} }).message.text.length > 0, 'a location with no coordinates still describes itself');
    A.ok(up(10, { sticker: {} }).message.text.length > 0, 'a sticker with no emoji/file still describes itself');
  }

  // ---- A2. THE BOUNDARY: service messages stay silent (the bot must not narrate group housekeeping) ----
  {
    for (const svc of [{ new_chat_members: [{ id: 3 }] }, { left_chat_member: { id: 3 } },
                       { pinned_message: { message_id: 1, text: 'x' } }, { new_chat_title: 'Ops' },
                       { group_chat_created: true }, { delete_chat_photo: true }]) {
      const n = normalize({ update_id: 99, message: Object.assign({ message_id: 1, chat, from }, svc) });
      A.eq(n, { offset: 99, message: null }, 'service message ' + Object.keys(svc)[0] + ' -> message:null (silent, offset advances)');
    }
    A.eq(describeOf({ pinned_message: {} }), '', 'describeOf is an ALLOWLIST — an unlisted payload describes nothing');
    A.eq(describeOf(null), '', 'describeOf(null) degrades to empty, never throws');
  }

  // ---- B. REPLY CONTEXT: the quoted message rides on msg.replyTo ----
  {
    const r = up(20, { text: 'what is this?', reply_to_message: { message_id: 4, from: { id: 9, first_name: 'Ana' }, photo: [{ file_id: 'p1', file_size: 10 }] } });
    A.eq(r.message.text, 'what is this?', 'the member\'s own words are untouched');
    A.eq(r.message.replyTo.userName, 'Ana', 'the quoted message is attributed');
    A.eq(r.message.replyTo.media[0].fileId, 'p1', 'the quoted PHOTO rides through — this is the whole "reply to a photo" case');

    const q = up(21, { text: 'do it', reply_to_message: { message_id: 5, from: { id: 5, username: 'andro' }, text: 'write the summary' } });
    A.eq(q.message.replyTo.text, 'write the summary', 'quoted TEXT rides through');

    const b = up(22, { text: 'expand on that', reply_to_message: { message_id: 6, from: { id: 42, is_bot: true, first_name: 'StarNet' }, text: 'Here is the plan.' } });
    A.eq(b.message.replyTo.fromBot, true, 'a reply to the BOT\'s own message is marked as such');

    // a reply whose target is itself a non-file payload still quotes something meaningful
    const l = up(23, { text: 'how far is that?', reply_to_message: { message_id: 7, from: { id: 9 }, location: { latitude: 1, longitude: 2 } } });
    A.ok(/location/.test(l.message.replyTo.text), 'a reply to a location quotes the location descriptor');

    A.eq('replyTo' in up(24, { text: 'plain' }).message, false, 'a NON-reply keeps the exact old shape (additive only)');
    A.eq(replyOf({ text: 'x', reply_to_message: { message_id: 8, from: { id: 1 } } }), null, 'a reply to a message with no readable content quotes nothing');
  }

  // ---- B2. THE FORUM TRAP: inside a topic, Telegram sets reply_to_message on EVERY message ----
  {
    // Every message in a forum topic carries reply_to_message = the topic's own creation message. Quoting it
    // would staple a phantom "in reply to" onto every single group turn in every forum.
    const t = normalize({ update_id: 30, message: { message_id: 40, chat: { id: -100, type: 'supergroup' }, from,
      text: 'status?', is_topic_message: true, message_thread_id: 77,
      reply_to_message: { message_id: 77, text: 'Ops', forum_topic_created: { name: 'Ops' } } } });
    A.eq('replyTo' in t.message, false, 'the topic ROOT is not quoted as a reply');

    // ...but a REAL reply inside that same topic still works
    const t2 = normalize({ update_id: 31, message: { message_id: 41, chat: { id: -100, type: 'supergroup' }, from,
      text: 'which one?', is_topic_message: true, message_thread_id: 77,
      reply_to_message: { message_id: 90, from: { id: 9, first_name: 'Ana' }, text: 'both are done' } } });
    A.eq(t2.message.replyTo.text, 'both are done', 'a genuine reply inside a forum topic is still quoted');
  }

  // ---- C. the generic adapter passes replyTo through untouched (and only when present) ----
  {
    const got = [];
    const ad = makeChannelAdapter({
      transport: { getUpdates: async () => [], send: async () => ({ ok: true }) },
      normalize: (r) => r, name: 'telegram', clock: { now: () => 1 }, ownerUserId: 'u',
      onInbound: (im) => got.push(im)
    });
    ad._internals.dispatch({ offset: 1, message: { chatId: 1, chatType: 'dm', userId: 'u', text: 'hi', messageId: '1', replyTo: { text: 'earlier', userName: 'Ana' } } });
    A.eq(got[0].replyTo, { text: 'earlier', userName: 'Ana' }, 'replyTo reaches the hub intact');
    ad._internals.dispatch({ offset: 2, message: { chatId: 1, chatType: 'dm', userId: 'u', text: 'yo', messageId: '2' } });
    A.eq('replyTo' in got[1], false, 'a message without a reply carries no replyTo key (byte-identical for the other four platforms)');
  }

  // ---- D. replyPreamble: bounded, attributed, and it does NOT tell the model to refuse the quote ----
  {
    A.eq(replyPreamble(null), '', 'no replyTo -> no preamble');
    A.eq(replyPreamble({ text: '', media: [] }), '', 'an empty quote produces nothing rather than an empty fence');

    const p = replyPreamble({ text: 'write the summary', userName: 'Ana' });
    A.ok(/Ana/.test(p), 'the preamble names who wrote the quoted message');
    A.ok(/write the summary/.test(p), 'the quoted text is in the preamble');
    A.ok(/--- quoted message ---/.test(p) && /--- end quoted message ---/.test(p), 'the quote is fenced by explicit markers');
    // The fence ATTRIBUTES, it must never forbid: a member replying to their own "write the summary" with
    // "do it now" means exactly that, and a preamble that told the model to ignore the quote would be its own bug.
    A.eq(/ignore|do not follow|must not be followed|disregard/i.test(p), false, 'the fence attributes the quote — it never instructs the model to refuse it');

    const long = replyPreamble({ text: 'x'.repeat(4000), userName: 'Ana' });
    A.ok(long.length < 900, 'a 4000-char quote is bounded so it cannot crowd out the actual request');
    A.ok(/truncated/.test(long), 'and the truncation is stated, not silent');

    A.ok(/2 file\(s\)/.test(replyPreamble({ text: 'see these', media: [{ kind: 'photo' }, { kind: 'photo' }] })), 'attached quoted files are announced');
    A.ok(replyPreamble({ text: '', media: [{ kind: 'photo' }] }).length > 0, 'a quoted message with ONLY media still produces a preamble');
  }

  // ---- E. END TO END through the hub: "what is this?" replying to a photo gets the pixels + the quote ----
  {
    const store = fakeStore(); const fetched = [], saved = []; let lastRun = null;
    const runOnce = async (o) => { lastRun = o; o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'a cat' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); };
    const hub = makeChannelHub({
      runOnce, store, send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(),
      fetchMedia: (it) => { fetched.push(it.fileId); return Promise.resolve({ ok: true, buffer: Buffer.from('BYTES') }); },
      saveAttachment: (agentId, name, dataUrl) => { saved.push({ agentId, name }); return Promise.resolve({ ok: true, id: 'id-' + name, name, path: '.attachments/' + name, mediaType: 'image/jpeg', kind: 'image' }); },
      expandAttachments: (messages) => Promise.resolve(messages)
    });
    const msg = dm('what is this?', '61');
    msg.replyTo = { text: 'look at this one', userName: 'Ana', media: [{ kind: 'photo', fileId: 'p1', name: 'photo.jpg', mime: 'image/jpeg', size: 50 }] };
    await hub.onInbound(msg);

    A.eq(fetched, ['p1'], 'the QUOTED photo was downloaded — the referent reaches the model as pixels');
    A.eq(saved[0].agentId, 'tg_61', 'stored in the resolved agent\'s workspace, same jail as any other attachment');
    const turn = store.appends.find(x => x.role === 'user');
    A.ok(/look at this one/.test(turn.content), 'the quoted text is in the persisted turn');
    A.ok(/what is this\?/.test(turn.content), 'the member\'s actual question is in the persisted turn');
    A.ok(turn.content.indexOf('look at this one') < turn.content.indexOf('what is this?'), 'the quote comes FIRST — the request is what the model reads last');
    A.ok(/quoted message they replied to/.test(turn.content), 'the attached file is attributed to the quoted message, not to this one');
    A.eq(lastRun.messages[lastRun.messages.length - 1].attachments.length, 1, 'the quoted photo rides as a real attachment on the run');
  }

  // ---- E2. the reply preamble must NOT reach routing, commands, or classification ----
  {
    const store = fakeStore(); let lastRun = null, classified = null, resolvedText = null;
    const runOnce = async (o) => { lastRun = o; o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'ok' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); };
    const hub = makeChannelHub({
      runOnce, store, send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }), newId: idGen(),
      classify: (t) => { classified = t; return false; },
      onResolved: (r) => { resolvedText = r.text; }
    });
    const msg = dm('go on', '62');
    msg.replyTo = { text: 'the quoted thing', userName: 'Ana' };
    await hub.onInbound(msg);
    A.eq(classified, 'go on', 'the task classifier sees the RAW message, never the quote');
    A.eq(resolvedText, 'go on', 'routing sees the RAW message, never the quote');
    A.ok(/the quoted thing/.test(String(lastRun.messages[lastRun.messages.length - 1].content)), 'but the model DOES see the quote');
  }

  // ---- E3. a quoted album cannot crowd out what the member actually sent (MAX_REPLY_MEDIA) ----
  {
    const store = fakeStore(); const fetched = [];
    const runOnce = async (o) => { o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'ok' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); };
    const hub = makeChannelHub({
      runOnce, store, send: () => Promise.resolve({ ok: true }), secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen(),
      fetchMedia: (it) => { fetched.push(it.fileId); return Promise.resolve({ ok: true, buffer: Buffer.from('B') }); },
      saveAttachment: (a, name) => Promise.resolve({ ok: true, id: name, name, path: '.attachments/' + name, mediaType: 'image/jpeg', kind: 'image' }),
      expandAttachments: (m) => Promise.resolve(m)
    });
    const msg = dm('and this one', '63');
    msg.media = [{ kind: 'photo', fileId: 'own', name: 'own.jpg', mime: 'image/jpeg', size: 10 }];
    msg.replyTo = { text: 'the batch', userName: 'Ana', media: Array.from({ length: 9 }, (_, i) => ({ kind: 'photo', fileId: 'q' + i, name: 'q' + i + '.jpg', mime: 'image/jpeg', size: 10 })) };
    await hub.onInbound(msg);
    A.eq(fetched[0], 'own', 'the member\'s OWN media is ingested first');
    A.eq(fetched.length, 5, 'own (1) + a bounded 4 from the quoted message');
  }

  // ---- F. a shared location runs a real turn end-to-end (the silent drop is gone at the hub too) ----
  {
    const store = fakeStore(); const sends = []; let lastRun = null;
    const runOnce = async (o) => { lastRun = o; o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model }); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'That is the Ferry Building.' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); };
    const hub = makeChannelHub({ runOnce, store, send: (c, t) => { sends.push(t); return Promise.resolve({ ok: true }); }, secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: idGen() });
    await hub.onInbound(dm(normalize({ update_id: 50, message: { message_id: 51, chat, from, location: { latitude: 37.79, longitude: -122.39 } } }).message.text, '64'));
    A.eq(sends.length, 1, 'a shared location now gets an answer instead of silence');
    A.ok(/37\.79/.test(String(lastRun.messages[lastRun.messages.length - 1].content)), 'and the model was told where');
  }

  A.report('channels.telegram.context');
}

run().catch(e => { console.log('FAIL: run() threw — ' + (e && e.stack || e)); process.exit(1); });
