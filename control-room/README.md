# StarNet control room

A second, deliberately boxed-in StarNet station: the sidecar in **browser mode**, on a fixed loopback port,
with its own data root, metered spend, a small fan-out ceiling and no host stdio MCP. It is the station you
keep open next to a business runtime and steer by hand; it is not the desktop app's station and never shares
its data.

```sh
./control-room/start-control-room.sh        # then open http://127.0.0.1:8787
```

Stop it with Ctrl-C. The script `exec`s `node sidecar/index.js`, so the process you see is the sidecar itself.

## What the script sets

The sidecar reads every knob as `STARNET_<NAME>` (a legacy `SKYNET_<NAME>` is accepted when the `STARNET_`
name is absent, which is why the script unsets both spellings of the two it pins empty). Environment values win
over anything saved in the UI's Settings, so the rails below cannot be loosened from the page.

| Variable | Value | What it does |
| --- | --- | --- |
| `STARNET_WORKSPACES` | `$HOME/.starnet-control-room/workspaces` | The data root. Each agent's fs jail is `<root>/<agentId>/`; the same directory also holds the channel and connector secret stores, the OAuth token stores (`codex/`, `grok/`, `kimi/`), transcripts, the roster, budgets and cron state. Override the parent with `STARNET_CONTROL_ROOM_HOME`. Created `chmod 700`: browser mode has no keychain, so secrets are plain files here. |
| `STARNET_PORT` | `8787` (pinned) | The sidecar listens on `127.0.0.1:8787` only. It never binds another interface. |
| `STARNET_BUDGET_PER_RUN` | `5` | USD ceiling for one run. A run that would cross it stops with a budget error. |
| `STARNET_BUDGET_PER_DAY` | `50` | USD pool for the whole station per calendar day, across every agent, channel and routine. `0` would disable the pool — do not. |
| `STARNET_BUDGET_PER_WORKER` | `2` | USD ceiling for each delegated sub-run (a lead agent fanning work out to workers). |
| `STARNET_MAX_CONCURRENT_AGENTS` | `4` | Fan-out ceiling: at most four agent runs in flight at once; further runs queue. |
| `STARNET_MCP_STDIO` | `0` (pinned) | Refuses stdio MCP connectors outright. A stdio connector is a host process spawned with the sidecar's user; this station only talks to MCP servers over HTTP. |
| `STARNET_API_TOKEN` | *unset* (pinned) | The sidecar mints a random token per launch and hands it only to the page it serves on `127.0.0.1:8787`; every `/api/*` call must carry it as `x-starnet-token`. Nothing else on the machine learns it. |
| `STARNET_DESKTOP_SHELL` | *unset* (pinned) | Browser mode. No Tauri shell, no keychain, no desktop restarts. |

Budgets and the fan-out ceiling may be lowered (or raised, deliberately) by exporting the variable before
running the script; the pinned ones are set unconditionally.

## Do not place the workbench (terminal) object

The **workbench** is the station object that exposes `shell.exec` and `verify.run` — a terminal on this host,
running as your user, outside every jail. The fs jail bounds what an agent can read and write; the budget rails
bound what it can spend; the taint gate revokes browser mutations and memory writes after untrusted content.
None of that bounds a shell: one command reaches every file, credential and network your account can.

This station exists to ingest untrusted material — paired channel messages, web pages, MCP tool results from
the business runtime. Keep the workbench out of it:

- Never drag the workbench object into the control-room station layout, and never send `workbench: true` on
  `/api/run`. Either placement exposes `shell.exec` to every run in the room.
- Do not tick "may use the terminal" (the unattended `workbench` grant) on any routine here. Routine scripts are
  the only thing that needs it, and this station runs no routine scripts.
- Know that an **owner-trusted** run — a DM from the paired owner of a channel — receives the workbench object
  automatically; that is the owner's own voice, deliberately exempt. The taint gate still withdraws the terminal
  the moment such a run reads untrusted content, but the exemption is exactly why the next section matters.

If you need a terminal, use the desktop station, not this one.

## Connect only paired channels

Every channel now requires `/pair` owner enrollment before it accepts DMs: the transport can be up while the
channel refuses everyone but the paired owner. Connect a channel to this station only after you have paired it
with **your own** account, because a paired owner's DMs are owner-trusted (see above). Never pair a shared,
group or bot-operated account; never connect a channel "to see if it works" before pairing. `GET
/api/channels/status` shows `pairing` and `acceptingDms` per channel — an unpaired connected channel is a
mistake to fix, not a state to leave.

## Attach the business runtime as an HTTP MCP connector

The business runtime serves MCP at `http://127.0.0.1:3112/mcp`. Plain `http://` is accepted only because the
host is loopback — the same law applies to provider base URLs: `https://` anywhere, `http://` only for
`127.0.0.1`, `localhost` or `[::1]`, never `user:pass@`. Anything else is refused with a 400.

Through the UI: Settings → Connectors → add, transport **HTTP**, URL `http://127.0.0.1:3112/mcp`, and paste the
runtime's bearer token into the token field. Or through the API from a shell on the same machine — the
`x-starnet-token` value is this launch's page token (`window.__STARNET_API_TOKEN__` in the page's devtools
console; start with an explicit `STARNET_API_TOKEN` only when you deliberately script the station):

```sh
curl -sS http://127.0.0.1:8787/api/connectors \
  -H 'content-type: application/json' \
  -H "x-starnet-token: $PAGE_TOKEN" \
  -d '{
        "id": "business",
        "label": "Business runtime",
        "transport": "http",
        "url": "http://127.0.0.1:3112/mcp",
        "token": "<runtime bearer token>",
        "enabled": true
      }'
```

The token is stored in the connector secret store under the data root and sent as `Authorization: Bearer …`
on every MCP request; it is never echoed back by `GET /api/connectors`. Tool results from the runtime are
untrusted content like any other: a run that reads them is tainted, which revokes mutating browser verbs and
memory writes for the rest of that run.

## Test status of the `control-room/hardening` branch

`npm run test:fast` (774 steps) was run on this branch on 2026-09-16 on a Mac mini with Node 24. Every
step passes except the following, none of which is a defect introduced here:

| Test | Why it fails here |
| --- | --- |
| `crt-context-loss.e2e`, `world-sharpen`, `worldlight-receiver`, `stationbake.connections` | need a Chrome binary (`SKYNET_CHROME`); visual tests, also skipped/failed on trunk in this environment |
| `value-loop-replay` | macOS `/tmp` is a symlink; the test refuses linked replay folders; same on trunk |
| `ledger-reconcile`, `pathtrust`, `project-discovery`, `discovery-documents` | fail identically on the upstream base commit (6e076c5) in this clone; environment, not this branch |
| `qa-product-perfect-claims` | upstream's release-governance audit: the advertised-claims ledger (`qa/product-perfect/claims.json`) must be re-audited whenever a "release surface" file changes, and the `/pair` enrollment UI changed `frontend/app/windows/messaging.js`. The fork ships no release, so the ledger is left untouched rather than re-stamped. |

Everything the hardening commits touch (channels, taint, memory, Host pin, agent ids, base URLs, sharp,
settings locks) is covered by the suites that pass: `channels.adapter`, `channels.telegram`,
`channels.commands`, `untrusted-taint`, `settings-p1-backend`, `agentid`, `boot-security`, and the rest
of the fast list.
