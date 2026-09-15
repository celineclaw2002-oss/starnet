/* node test/channels.owner-pairing.e2e.test.js -- live proof that owner enrollment is one law for EVERY channel.

   Telegram already proves the /pair flow end-to-end (channels.telegram.connect-pairing.e2e.test.js). This boots
   the real sidecar against a fake signal-cli REST bridge — the one non-Telegram transport that needs no gateway
   or websocket — and proves through the generic channel routes that: connect returns the one-time code, an
   ordinary pre-pair DM is silently refused (no run, no reply), `/pair <code>` claims the owner over the real
   poll loop, status tells the truth at every step, and the shared owner pair/revoke routes work for a
   non-Telegram channel. Discord/Slack/Matrix share the exact same adapter + host wiring (channels.generic-wire,
   channels.adapter source-locks). */
'use strict';

const A = require('./_assert.js');
const http = require('node:http');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

const HOST = '127.0.0.1';
const ACCOUNT = '+15550001111';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function readJson(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch (_) { resolve({}); } });
  });
}

// A minimal signal-cli-rest-api: GET /v1/receive/<account> drains queued envelopes (parks briefly when empty),
// POST /v2/send records outbound messages. No real network anywhere.
async function startSignalBridge() {
  const sends = [];
  const queued = [];
  let ts = 1000;
  const server = http.createServer(async (req, res) => {
    const url = String(req.url || '');
    if (req.method === 'GET' && url.indexOf('/v1/receive/') === 0) {
      const reply = () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(queued.splice(0, queued.length))); };
      if (queued.length) return reply();
      setTimeout(reply, 40);
      return;
    }
    if (req.method === 'POST' && url === '/v2/send') {
      sends.push(await readJson(req));
      res.writeHead(201, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ timestamp: ++ts }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, HOST, resolve); });
  return {
    base: 'http://' + HOST + ':' + server.address().port,
    sends,
    push(from, text) { queued.push({ envelope: { sourceNumber: from, sourceName: 'someone', dataMessage: { message: text, timestamp: ++ts } } }); },
    close() { return new Promise(resolve => server.close(resolve)); }
  };
}

async function waitUntil(fn, timeoutMs, label) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(25);
  }
  throw new Error('timed out waiting for ' + label);
}

(async () => {
  const bridge = await startSignalBridge();
  const sidecar = SidecarFixture.create({ prefix: 'starnet-owner-pair-', timeoutMs: 20000 });
  try {
    await sidecar.start();
    const status = async () => (await sidecar.json('GET', '/api/channels/signal/status')).body;

    const connected = await sidecar.json('POST', '/api/channels/signal/connect', {
      endpoint: bridge.base, account: ACCOUNT, key: 'sk-or-v1-pairing-test', model: 'test/model', provider: 'openrouter',
      agentId: 'agent', agentName: 'ULTRON', system: 'test agent'
    });
    A.eq(connected.status, 200, 'authenticated Signal connect succeeds');
    A.eq(connected.body.pairingRequired, true, 'connect says owner pairing is required on a non-Telegram channel');
    A.ok(/^[-A-Z0-9]{11}$/.test(String(connected.body.pairingCode || '')), 'connect returns the one-time local pairing code');
    const code = connected.body.pairingCode;

    await waitUntil(async () => (await status()).connected, 5000, 'first successful signal-cli poll');
    let st = await status();
    A.eq(st.ownerLocked, false, 'no owner is trusted yet');
    A.eq(st.acceptingDms, false, 'an unpaired but polling channel honestly reports that it is not accepting DMs');
    A.eq(st.ownerPairingActive, true, 'the returned pairing challenge is active');
    const bulk = (await sidecar.json('GET', '/api/channels/status')).body;
    A.eq(bulk.signal && bulk.signal.acceptingDms, false, 'the bulk status poll carries the same truth');

    // the exact failure this guards: a stranger (or the Commander before pairing) DMs the bot. Nothing runs.
    bridge.push('+15550009999', 'hello before pairing');
    await sleep(400);
    A.eq(bridge.sends.length, 0, 'an ordinary DM before pairing gets no reply and runs nothing');
    A.eq((await status()).ownerLocked, false, 'the first DM did NOT claim ownership (no trust-on-first-use)');

    // a wrong code is refused just as silently
    bridge.push('+15550009999', '/pair AAAAA-AAAAA');
    await sleep(400);
    A.eq(bridge.sends.length, 0, 'a wrong pairing code is silently refused');
    A.eq((await status()).ownerLocked, false, 'a wrong code claims nothing');

    bridge.push('+15550001234', '/pair ' + code);
    await waitUntil(() => bridge.sends.some(s => /Owner paired/i.test(String(s.message || ''))), 5000, 'owner-pair acknowledgement');
    A.eq(bridge.sends[0].recipients, ['+15550001234'], 'the acknowledgement went back to the pairing DM');
    st = await status();
    A.eq(st.ownerLocked, true, 'the Signal number that redeemed the code is now the persisted owner');
    A.eq(st.acceptingDms, true, 'the same live poller now truthfully reports that it accepts DMs');
    A.eq(st.ownerPairingActive, false, 'the challenge is consumed on a successful claim');

    // the shared owner routes work for a non-Telegram channel
    const pairAgain = await sidecar.json('POST', '/api/channels/signal/owner/pair', {});
    A.eq(pairAgain.status, 409, 'pairing a second owner is refused while one is paired');
    const revoked = await sidecar.json('POST', '/api/channels/signal/owner/revoke', {});
    A.eq(revoked.status, 200, 'revoke succeeds');
    A.eq(revoked.body.revoked, true, 'revoke reports the proven state change');
    st = await status();
    A.eq(st.ownerLocked, false, 'the owner is gone after revoke');
    A.eq(st.acceptingDms, false, 'DMs are refused again after revoke');
    const reissued = await sidecar.json('POST', '/api/channels/signal/owner/pair', {});
    A.eq(reissued.status, 200, 'a fresh code can be issued after revoke');
    A.ok(/^[-A-Z0-9]{11}$/.test(String(reissued.body.code || '')) && reissued.body.code !== code, 'the reissued code is a new one-time code');
    A.eq((await status()).ownerPairingActive, true, 'the reissued challenge is active');
    // the old owner's closure died with the rebuild: an ordinary DM from the OLD owner no longer runs
    await waitUntil(async () => (await status()).connected, 5000, 'signal-cli poll after the post-revoke rebuild');
    const before = bridge.sends.length;
    bridge.push('+15550001234', 'still me?');
    await sleep(400);
    A.eq(bridge.sends.length, before, 'the revoked owner gets no reply');
  } finally {
    await sidecar.dispose();
    await bridge.close();
  }
  A.report('channels.owner-pairing.e2e.test');
})().catch(error => { console.error(error.stack || error); process.exit(1); });
