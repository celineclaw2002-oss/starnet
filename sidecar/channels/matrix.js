/* sidecar/channels/matrix.js — the Matrix platform binding for the generic channel adapter.

   The analogue of telegram.js/discord.js: it supplies ONLY the wire translation (normalize) + the limit and
   hands the rest to the transport-agnostic adapter (owner/DM admission, resend, status). Inbound raw updates
   come from matrix.transport.js's /sync long-poll as { roomId, event, selfId }.

   Room typing: Matrix has no server-side "this is a DM" bit a bot can trust (m.direct lives in the INVITER's
   client account data), so a room is a DM surface (chatType 'dm') only when it holds exactly the bot and ONE
   other member (the transport harvests m.joined_member_count from every /sync summary). A room with more
   members is a GROUP: dropped unless the host allowlists it, exactly like a Telegram/Discord group. A DM is then
   guarded by the adapter's owner gate, which admits nobody until the host's /pair enrollment names the owner,
   so a stranger inviting the agent's account somewhere can never drive it. When a homeserver sends no summary
   at all (joinedMembers null) the room keeps the owner-gated 'dm' path rather than going silently deaf.

   normalize(raw) -> { message } | null
     - null                : not a message event (state/member/receipt/own echo) — deliver nothing
     - { message: {...} }  : a real other-user text message, in the adapter's neutral InboundMessage shape
   (Matrix's own `since` token is the offset and lives in the transport; normalize never returns a numeric
   offset, exactly like Discord's gateway path.) */
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./adapter.js'), require('./matrix.transport.js'));
  } else {
    root.SK = root.SK || {}; root.SK.channels = root.SK.channels || {};
    root.SK.channels.matrix = factory(root.SK.channels.adapter, root.SK.channels.matrixTransport);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (adapterMod, transportMod) {
  'use strict';
  const { makeChannelAdapter } = adapterMod;
  const { makeMatrixTransport } = transportMod;

  const MAX_MESSAGE_LENGTH = 4096;   // events cap far higher (~64KB), but chat-sized chunks read better

  function normalize(raw) {
    if (!raw || !raw.roomId || !raw.event) return null;
    const ev = raw.event;
    if (ev.type !== 'm.room.message') return null;                        // state/member/receipt -> nothing
    if (raw.selfId && ev.sender === raw.selfId) return null;              // never act on our own echo
    const c = ev.content || {};
    const text = (c.msgtype === 'm.text' || c.msgtype === 'm.notice') ? c.body : null;
    if (typeof text !== 'string' || !text) return null;                   // non-text -> deliver nothing
    const joined = Number(raw.joinedMembers);
    const shared = raw.joinedMembers != null && Number.isFinite(joined) && joined > 2;   // bot + 2 or more humans
    return {
      message: {
        chatId: String(raw.roomId),
        chatType: shared ? 'group' : 'dm',                                 // 1:1 rooms are owner-gated (see header)
        userId: String(ev.sender || ''),
        userName: String(ev.sender || ''),
        text: text,
        messageId: String(ev.event_id || '')     // the adapter stamps ts from its injected clock
      }
    };
  }

  function makeMatrixAdapter(opts) {
    const o = opts || {};
    const transport = o.transport || makeMatrixTransport({
      fetch: o.fetch, token: o.token, homeserver: o.homeserver, newId: o.newId
    });
    return makeChannelAdapter({
      transport,
      normalize,
      name: 'matrix',
      maxMessageLength: MAX_MESSAGE_LENGTH,
      allowedChats: o.allowedChats,
      ownerUserId: o.ownerUserId,
      onOwnerClaim: o.onOwnerClaim,
      ownerAdmission: o.ownerAdmission,           // the host's /pair enrollment hook (no trust-on-first-use)
      allowTrustOnFirstUse: o.allowTrustOnFirstUse,
      onInbound: o.onInbound,
      onCallback: o.onCallback,
      onStatus: o.onStatus,
      clock: o.clock,
      sleep: o.sleep,
      pollTimeoutSec: o.pollTimeoutSec != null ? o.pollTimeoutSec : 30,   // /sync long-poll window
      startOffset: o.startOffset
      // dropPendingOnConnect stays OFF: the transport's primed-first-sync already discards the backlog.
    });
  }

  return { makeMatrixAdapter, normalize, MAX_MESSAGE_LENGTH };
});
