/* node test/channels.generic-wire.test.js — the HOST wiring for the GENERIC channels (slack/matrix/signal).
   The three adapters + transports ship fully-tested (channels.slack/matrix/signal.test.js) and the registry
   knows them (channels.registry.test.js); this guards the seam that historically went missing (Discord shipped
   dead for weeks because the host never started it):
   1) BACKEND source-guard over sidecar/index.js — the generic route family + handlers exist, start/stop through
      startGenericChannel/stopGenericChannel, auto-start on boot, notify fan-out includes the generic map, and
      the status payload NEVER echoes a token/key/endpoint secret.
   2) BEHAVIOUR — each real registry descriptor wires through wireChannel into a startable adapter driving the
      SAME hub/runOnce path (fake transports, no network). */
'use strict';
const fs = require('fs');
const path = require('path');
const A = require('./_assert.js');
const { makeChannelRegistry, wireChannel } = require('../sidecar/channels/registry.js');

function fakeStore() {
  const hist = new Map();
  return { loadHistory(a) { return (hist.get(a) || []).slice(); },
           appendTurn(a, r, c) { const arr = hist.get(a) || []; arr.push({ role: r, content: c }); hist.set(a, arr); return arr; },
           getChatRecord() { return null; } };
}
const ids = () => { let i = 0; return () => 'r' + (++i); };

(async () => {
  // ---------- 1. BACKEND source-guard over sidecar/index.js ----------
  const idx = fs.readFileSync(path.join(__dirname, '..', 'sidecar', 'index.js'), 'utf8');

  // telegram/discord bespoke paths untouched — additive-only guarantee.
  A.ok(/function startTelegram/.test(idx) && /function startDiscord/.test(idx), 'telegram/discord starters preserved (not regressed)');

  // the generic route family is wired into the dispatcher and covers exactly the three new channels.
  A.ok(['connect', 'sync', 'disconnect', 'status'].every(v => idx.indexOf('(slack|matrix|signal)\\/' + v) >= 0), 'generic route matcher covers slack|matrix|signal × the four verbs');
  A.ok(/handleGenericChannelConnect/.test(idx) && /handleGenericChannelSync/.test(idx) && /handleGenericChannelDisconnect/.test(idx) && /handleGenericChannelStatus/.test(idx), 'the four generic handlers exist and are routed');
  A.ok(/exact: '\/api\/channels\/status'/.test(idx) && /function handleChannelsStatusAll/.test(idx), 'bulk GET /api/channels/status exists (one poll paints the panel)');

  // lifecycle: connect starts through the ONE generic path; disconnect stops it; boot auto-starts saved configs.
  A.ok(/function startGenericChannel/.test(idx) && /function stopGenericChannel/.test(idx), 'generic start/stop lifecycle present');
  const connBody = (idx.split('async function handleGenericChannelConnect')[1] || '').split('async function ')[0];
  A.ok(/startGenericChannel\(id, token/.test(connBody), 'generic connect starts the adapter via startGenericChannel');
  A.ok(/parseSlackTokens/.test(connBody), 'slack connect validates BOTH tokens (xoxb + xapp) before starting');
  A.ok(/homeserver URL/.test(connBody) && /signal-cli REST API URL/.test(connBody), 'matrix/signal connect validate their endpoint config with actionable errors');
  A.ok(/GENERIC_CHANNEL_IDS\)/.test(idx) && /auto-started from saved config/.test(idx), 'boot auto-start loops the generic channels');

  // notify fan-out reaches the generic map (autonomous pings work on every connected channel).
  A.ok(/genericChannels\[channel\]/.test(idx), 'autoNotifier fan-out resolves generic channels by name');

  // SECRET-SAFETY: the shared status payload reports booleans/state only — never token/key values.
  const statusBody = (idx.split('function channelStatusPayload')[1] || '').split('function ')[0];
  A.ok(/configured/.test(statusBody) && /channelRecordConfigured\(id, rec\)/.test(statusBody) && /function channelRecordConfigured[\s\S]{0,400}?channelToken\(id, '', r\)/.test(idx), 'status derives boolean "configured" from the resolved token, not the token itself');

  // OWNER ENROLLMENT, every channel: no trust-on-first-use anywhere. The host passes the /pair admission hook to
  // discord and the generic adapters, connect returns the one-time code, and pair/revoke routes exist for all.
  const discordBody = (idx.split('function startDiscord')[1] || '').split('\nfunction ')[0];
  const genericBody = (idx.split('function startGenericChannel')[1] || '').split('\nfunction ')[0];
  A.ok(/ownerAdmission: \(message\) => channelOwnerAdmission\(\(channelSecrets && channelSecrets\.discord\) \|\| \{\}, message\)/.test(discordBody), 'discord wiring passes the /pair owner-admission hook');
  A.ok(/ownerAdmission: \(message\) => channelOwnerAdmission\(\(channelSecrets && channelSecrets\[id\]\) \|\| \{\}, message\)/.test(genericBody), 'slack/matrix/signal wiring passes the /pair owner-admission hook');
  A.ok(!/allowTrustOnFirstUse/.test(idx), 'the host never opts a channel into trust-on-first-use');
  A.ok(/ownerPairingOnConnect\('discord', started\)/.test(idx) && /ownerPairingOnConnect\(id, started\)/.test(connBody), 'discord + generic connect return the one-time pairing code like telegram');
  A.ok(/CHANNEL_OWNER_RX = \/\^\\\/api\\\/channels\\\/\(discord\|slack\|matrix\|signal\)\\\/owner\\\/\(pair\|revoke\)\$\//.test(idx) && /rx: CHANNEL_OWNER_RX/.test(idx), 'owner pair/revoke routes exist for every non-telegram channel');
  A.ok(/const acceptingDms = !!st\.connected && ownerLocked;/.test(statusBody), 'status reports acceptingDms:false for an unpaired channel on EVERY platform');
  A.ok(/function restartChannelAfterOwnerRevoke/.test(idx) && /restartChannelAfterOwnerRevoke\(id, next\)/.test(idx), 'a revoke rebuilds the live adapter so the old owner closure dies');
  A.ok(!/token:\s*rec\.token/.test(statusBody), 'status payload never carries the raw token');
  A.ok(!/\bkey:\s*rec\.key/.test(statusBody), 'status payload never carries the raw key');
  A.ok(/notifyAutonomous/.test(statusBody), 'status surfaces the shared autonomous-ping opt-in');

  // ---------- 1b. FRONTEND source-guard: the CHANNELS panel renders all five platforms from ONE catalog ----------
  const station = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'app', 'windows', 'messaging.js'), 'utf8');
  A.ok(/CHANNEL_CATALOG/.test(station), 'the panel is catalog-driven (adding a platform is a catalog row)');
  for (const t of ['TELEGRAM', 'DISCORD', 'SLACK', 'MATRIX', 'SIGNAL']) A.ok(new RegExp("title: '" + t + "'").test(station), t + ' card present in the catalog');
  // masked secrets: slack's two tokens + matrix's access token are password inputs; endpoints/account are plain text.
  A.ok(/id="sl-bot-token"[^>]*type="password"/.test(station) && /id="sl-app-token"[^>]*type="password"/.test(station), 'both Slack tokens are masked inputs');
  A.ok(/id="mx-token"[^>]*type="password"/.test(station), 'the Matrix access token is a masked input');
  A.ok(/id="mx-endpoint"[^>]*type="text"/.test(station) && /id="sg-endpoint"[^>]*type="text"/.test(station), 'endpoints are plain-text config fields (non-secret)');
  // honest setup guidance for each new platform
  A.ok(/Socket Mode/.test(station) && /connections:write/.test(station), 'Slack setup guide covers Socket Mode + the app-level token scope');
  A.ok(/Access Token/.test(station) && /homeserver/i.test(station), 'Matrix setup guide covers homeserver + access token');
  A.ok(/signal-cli-rest-api/.test(station), 'Signal setup guide points at the signal-cli REST bridge');
  // the panel paints all cards from the one bulk poll and the shared notify opt-in exists exactly once
  A.ok(/fetch\('\/api\/channels\/status'\)/.test(station), 'the panel paints from GET /api/channels/status');
  A.eq((station.match(/id="ch-notify"/g) || []).length, 1, 'exactly ONE shared autonomous-ping opt-in');

  // ---------- 2. BEHAVIOUR: each descriptor wires into a startable adapter on the SAME hub/runOnce path ----------
  const CASES = [
    { id: 'slack', owner: 'OWNER', inboundRaw: [{ type: 'message', channel: 'D1', channel_type: 'im', user: 'OWNER', text: 'hi slack', ts: '1.1' }], chatId: 'D1' },
    { id: 'matrix', owner: '@owner:hs', inboundRaw: [{ roomId: '!r:hs', event: { type: 'm.room.message', sender: '@owner:hs', event_id: '$1', content: { msgtype: 'm.text', body: 'hi matrix' } }, selfId: '@bot:hs' }], chatId: '!r:hs' },
    { id: 'signal', owner: '+1555', inboundRaw: [{ envelope: { sourceNumber: '+1555', sourceName: 'O', dataMessage: { message: 'hi signal', timestamp: 2 } } }], chatId: '+1555' }
  ];
  // 2a. an UNPAIRED channel runs nothing: the same inbound with no owner and no admission hook never reaches runOnce
  for (const c of CASES) {
    const reg = makeChannelRegistry();
    const ran = [], sent = [];
    const seq = [c.inboundRaw];
    const transport = {
      getUpdates: async () => seq.length ? seq.shift() : (await new Promise(r => setTimeout(() => r([]), 1))),
      send: async (chatId, text) => { sent.push({ chatId, text }); return { ok: true, messageId: 'm' }; }
    };
    const { adapter } = wireChannel(reg.get(c.id), {
      hub: { runOnce: async (o) => { ran.push(o); }, store: fakeStore(), secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: ids() },
      adapter: { transport, clock: { now: () => 1 }, sleep: () => Promise.resolve() }
    });
    await adapter.connect();
    for (let i = 0; i < 20; i++) await new Promise(r => setTimeout(r, 0));
    await adapter.disconnect();
    A.eq(ran.length, 0, c.id + ': an unpaired channel never runs a DM (no trust-on-first-use)');
    A.eq(sent.length, 0, c.id + ': and answers nothing');
    A.eq(adapter._internals.owner, '', c.id + ': the stranger did not become the owner');
  }
  // 2b. the /pair enrollment hook claims the owner through the SAME wiring, acknowledges via the hub, never runs the model
  {
    const reg = makeChannelRegistry();
    const ran = [], sent = [], claims = [];
    const seq = [[
      { type: 'message', channel: 'D1', channel_type: 'im', user: 'OWNER', text: '/pair ABCDE-FGHIJ', ts: '1.1' },
      { type: 'message', channel: 'D1', channel_type: 'im', user: 'OWNER', text: 'hi slack', ts: '1.2' }
    ]];
    const transport = {
      getUpdates: async () => seq.length ? seq.shift() : (await new Promise(r => setTimeout(() => r([]), 1))),
      send: async (chatId, text) => { sent.push({ chatId, text }); return { ok: true, messageId: 'm' }; }
    };
    const { adapter } = wireChannel(reg.get('slack'), {
      hub: { runOnce: async (o) => { ran.push(o); o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'ok' }); o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 }); },
        store: fakeStore(), secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: ids() },
      adapter: { transport, clock: { now: () => 1 }, sleep: () => Promise.resolve(), onOwnerClaim: u => claims.push(u),
        ownerAdmission: (m, uid) => (m.text === '/pair ABCDE-FGHIJ') ? { allow: true, consume: true, reply: 'Owner paired.' } : false }
    });
    await adapter.connect();
    for (let i = 0; i < 40 && sent.length < 2; i++) await new Promise(r => setTimeout(r, 0));
    await adapter.disconnect();
    A.eq(claims, ['OWNER'], 'slack: /pair with the right code claims the owner');
    A.eq(ran.length, 1, 'slack: only the message AFTER pairing ran the agent (the /pair exchange never reaches the model)');
    A.ok(sent.some(s => /Owner paired/.test(s.text)), 'slack: the pairing acknowledgement went back through the hub/outbox');
  }
  for (const c of CASES) {
    const reg = makeChannelRegistry();
    A.ok(reg.has(c.id), 'registry exposes ' + c.id);
    const ran = [], sent = [];
    const runOnce = async (o) => {
      ran.push(o);
      o.emit('agent.run.start', { agentId: o.agentId, runId: o.runId, trigger: 'event', model: o.model });
      o.emit('agent.token', { agentId: o.agentId, runId: o.runId, delta: 'reply for ' + c.id });
      o.emit('agent.run.end', { agentId: o.agentId, runId: o.runId, reason: 'done', turns: 1, usd: 0 });
    };
    const seq = [c.inboundRaw];
    const transport = {
      getUpdates: async () => seq.length ? seq.shift() : (await new Promise(r => setTimeout(() => r([]), 1))),
      send: async (chatId, text) => { sent.push({ chatId, text }); return { ok: true, messageId: 'm' }; }
    };
    const { hub, adapter } = wireChannel(reg.get(c.id), {
      hub: { runOnce, store: fakeStore(), secrets: () => ({ key: 'k', model: 'm' }), classify: () => false, newId: ids() },
      adapter: { transport, clock: { now: () => 1 }, sleep: () => Promise.resolve(), ownerUserId: c.owner }   // a PAIRED owner (saved record)
    });
    A.ok(hub && typeof hub.onInbound === 'function', c.id + ': a real makeChannelHub backs the channel');
    await adapter.connect();
    for (let i = 0; i < 40 && sent.length < 1; i++) await new Promise(r => setTimeout(r, 0));
    await adapter.disconnect();
    A.eq(ran.length, 1, c.id + ': the inbound drove the SAME runOnce');
    A.eq(sent.length, 1, c.id + ': the reply went back out through the wired adapter.send');
    A.eq(sent[0].chatId, c.chatId, c.id + ': reply targeted the source chat');
    A.ok(new RegExp('reply for ' + c.id).test(sent[0].text), c.id + ': reply text assembled from runOnce tokens');
  }

  A.report('channels.generic-wire');
})().catch(e => { console.log('FAIL: threw ' + (e && e.stack || e)); process.exit(1); });
