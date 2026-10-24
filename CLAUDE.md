# Claude Code gateway

A small reverse proxy that lets Claude Code on 5 workstations share one Claude
Max subscription. The owner is the only user of all the machines. The
workstations are **untrusted**, so every credential and every rule lives on
the gateway.

What it does, and nothing more:

1. Authenticates each workstation by its own key.
2. Blocks models per workstation or globally (mainly to keep Fable off).
3. Swaps in the Max `claude setup-token` and forwards the request unchanged.
4. Records token usage per workstation in SQLite.
5. Serves Max 5h/7d utilization to workstation status lines.
6. Serves files in `public/` (workstation setup scripts) at `/<name>`, no auth.
7. Admin API at `/gateway/admin/*` for the owner's web portal (separate app
   with its own Postgres): workstation keys, usage sync, CSV export. Requested
   by the owner in October 2026.

## Hard rules

- **The setup-token never leaves the server.** Never log it, never put it in
  an error, never send it anywhere but the upstream base URL.
- **The admin token is handled like the setup-token:** never logged, never
  forwarded, never in an error. Only its sha256 is kept in memory, compared
  with `timingSafeEqual`. It is never looked up in `workstations`, and a
  workstation key never works on `/gateway/admin/*`. Admin responses carry
  keys, so they are `cache-control: no-store`, and admin logs never include
  headers or bodies.
- **`/gateway/admin/*` is never forwarded upstream**, matched or not, and
  never recorded in `usage`.
- **Usage rows are insert-only.** The portal syncs by `usage.id` (cursor
  `id > after_id`). Never UPDATE or DELETE usage rows and never reuse ids,
  or the portal's copy silently drifts.
- **Forward requests byte-for-byte.** Only these headers change: the
  workstation's `authorization`/`x-api-key` are removed, `authorization:
  Bearer <setup-token>` is set, `accept-encoding: identity` is forced, and
  hop-by-hop headers and any `X-Forwarded-*` / `Forwarded` / `Via` /
  `X-Real-IP` headers are dropped. Never rewrite the body, the system prompt or
  Claude Code's other headers: Anthropic only accepts the OAuth token for
  genuine Claude Code traffic, so any rewrite risks breaking everything.
- **Stream responses straight through** (`upRes.pipe(res)`); usage parsing
  happens on a side copy of the stream and must never delay or alter it.
- **Never store prompt or response content.** Usage rows hold counts and
  metadata only.
- **Enforce everything server-side.** Assume a workstation can read and change
  its own config, scripts and skills.
- **The database must never break a request.** All DB calls go through
  `safeDb()`, which logs and continues.
- **Errors the gateway creates use Anthropic's format**
  (`{"type":"error","error":{"type","message"}}`) so Claude Code shows them
  properly. Upstream errors pass through untouched.
- **Zero npm dependencies.** Node built-ins only, including `node:sqlite`
  (hence `node:24-alpine`). CommonJS, no build step.

## Decided out of scope

Don't add these unless the owner asks:

- Usage limits, budgets, concurrency caps (deliberately dropped).
- LiteLLM, in front or behind (deliberately dropped).
- MCP proxying or centralised MCP auth (the owner doesn't run the MCP servers).
- Skills distribution (done separately via a private git plugin marketplace).
- A separate reverse proxy (Caddy etc.): removed to fit the 512 MB instance.
  The gateway serves HTTPS itself (see Deployment).

## Layout

```
src/server.js         HTTP proxy: auth, model policy, forwarding, metering, /gateway/status
src/admin-http.js     admin API under /gateway/admin: token auth, IP allowlist, rate limit, routes, CSV streaming
src/admin.js          workstation/usage operations shared by cli.js and admin-http.js (add, list, rotate,
                      remove, --since parsing, CSV rows, sync query); expected failures throw err.kind
src/db.js             SQLite schema (created on open), read-only connection, key generation and hashing
src/policy.js         glob model patterns ("*fable*"), case-insensitive
src/usage-parser.js   SSE + JSON usage extraction
src/cli.js            `gw` admin CLI (workstations, blocks, reports, CSV export)
src/healthcheck.js    Docker HEALTHCHECK (HTTP or HTTPS to 127.0.0.1, cert not verified)
public/               served at /<name> without auth (bind-mounted read-only); public, so never put keys here
  setup.ps1, setup.sh            workstation setup: key check via /gateway/status, settings.json, status line
  gateway-statusline.{ps1,sh}    status-line scripts, downloaded by the setup scripts
test/fake-upstream.js fake Anthropic API for local testing
deploy/setup-cert.sh  one-time certbot setup (standalone, port 80) + renewal deploy hook
Dockerfile, docker-compose.yml, .env.example, README.md
```

## Request flow (server.js `handle` → `forward`)

1. `HEAD|GET /api/hello` → 200 locally, no auth (Claude Code startup check).
2. `GET /health` → DB ping, no auth.
3. `/gateway/admin` or `/gateway/admin/...` → admin router (`admin-http.js`),
   **before** any workstation-key lookup, and it always answers (never falls
   through, never forwarded, never recorded). In order: API disabled (no
   valid `ADMIN_TOKEN_FILE`) → 404; `ADMIN_ALLOWED_IPS` set and `clientIp()`
   not in it → 403; IP locked out (10 failed logins / 10 min, max 1,000 IPs
   tracked) → 429; `Authorization: Bearer` ≠ admin token → 401 (counts as a
   failure); no route → 404. Logged as `ADMIN <action> from <ip>` or
   `ADMIN REJECT <status> ...`.
4. `GET|HEAD /<name>` where `public/<name>` is a file → served, no auth,
   logged as `PUBLIC`. Single path segment only, no dotfiles; anything else
   falls through to the steps below.
5. Key from `Authorization: Bearer` or `x-api-key` → sha256 → workstation row.
   Unknown → 401 (logged, not recorded).
6. `GET /gateway/status` → plan status for this workstation, text or
   `?format=json`, `?color=1` for ANSI. Not forwarded, not recorded, not logged
   (status lines poll it constantly).
7. Disabled workstation → 403, recorded as `blocked`.
8. Paths other than `/v1/messages` and `/v1/messages/count_tokens` are
   forwarded and logged as `UNLISTED PATH` (or 404 with `STRICT_PATHS=1`).
9. Body buffered (32 MB cap); `model` read for policy; global then
   per-workstation block patterns → 403 `permission_error`, recorded.
10. Forward, stream back, parse usage, store `anthropic-ratelimit-*` headers in
    `plan_status`, write one `usage` row via `record()` (guarded to run once).

Outcomes: `ok`, `blocked`, `upstream_error` (incl. `upstream_aborted` when
Anthropic drops mid-stream; the client connection is then destroyed too),
`client_aborted` (partial usage kept), `gateway_error`.

## Data

`DB_PATH` (default `/data/gateway.db`, a Docker volume). WAL mode, so the CLI
and the server can use it at the same time; CLI changes apply on the next
request without a restart.

- `workstations(name, key_hash, enabled, blocked_models JSON, created_at, last_seen_at)`
- `usage(...)`: one row per request; tokens split into input / output /
  cache_write / cache_read, plus web_search_requests, session_id (from
  `x-claude-code-session-id`), and util_5h / util_7d at that moment.
- `plan_status`: single row with the latest `anthropic-ratelimit-*` headers.

Admin DB work goes through `admin.js`, not `safeDb()`: expected failures
throw with `err.kind` (`invalid` / `exists` / `not_found` → 400 / 409 / 404)
and anything else becomes a 500, so "not found" never looks like a DB error.
The CSV export streams with `iterate()` on its **own read-only connection**
(`openReadOnly()`). A statement left open on the server's connection makes its
usage inserts fail with `SQLITE_BUSY_SNAPSHOT` as soon as `gw` writes. The
export scans in id order with `+ts` / `+workstation`, because the indexed plan
sorts in a temp B-tree before the first row. That blocks the event loop, and
large sorts need temp files that the read-only container can't create. Keep
both properties.

Schema changes: tables are created with `CREATE TABLE IF NOT EXISTS`, so
existing databases are never migrated automatically. Add new columns with a
guarded `ALTER TABLE ... ADD COLUMN` in `db.js` (check `PRAGMA table_info`
first). Never drop or rename columns; the owner keeps the history.

## Verified behaviour (Phase 0, Claude Code 2.1.302 on Windows, Oct 2026)

- The setup-token (`sk-ant-oat01-…`) works as `Authorization: Bearer` when
  real Claude Code requests are forwarded unchanged.
- The `oauth-2025-04-20` beta flag is **not** needed (`ADD_OAUTH_BETA=0` is
  the default; the option stays in case Anthropic changes this).
- Claude Code sends `HEAD /api/hello` without a key before each session.
- Prompt caching works through the proxy.
- Haiku is used for background work (titles, WebFetch summaries). Those
  requests lack the `claude-code-20250219` beta. Blocking Haiku on a
  workstation means setting `ANTHROPIC_DEFAULT_HAIKU_MODEL` there.
- Web search runs server-side: a tiny request can report tens of thousands of
  input tokens, plus `usage.server_tool_use.web_search_requests`.
- Claude Code sends several requests at once (main + background, search +
  fetch).
- Response headers include `anthropic-ratelimit-unified-{5h,7d}-utilization`
  (0–1), `-reset` (unix seconds), `-status`, and overall `-unified-status`.
- On workstations, `/usage` and claude.ai connectors don't work (Claude Code
  sees API-style auth). The status-line script replaces `/usage`.

## Testing

No real token needed. In two terminals (Node 22+ works locally):

```
node test/fake-upstream.js 9999
DB_PATH=/tmp/gw.db UPSTREAM_BASE_URL=http://127.0.0.1:9999 \
  CLAUDE_SETUP_TOKEN=sk-ant-oat01-test PORT=8601 \
  NODE_OPTIONS=--disable-warning=ExperimentalWarning node src/server.js
```

Then `DB_PATH=/tmp/gw.db node src/cli.js add ws1 --block "*fable*"` and drive
it with curl. Before handing over any change, check at least: streaming body
arrives intact, the upstream sees `Bearer <setup-token>` and not the
workstation key, usage row has the right counts, blocked model → 403 and a
`blocked` row, bad key → 401, a request line of `//other-host/v1/messages`,
`http://other-host/v1/messages` or `/.//other-host/...` still goes to the
upstream (never to other-host), `/gateway/status` works and isn't recorded, a
client abort mid-stream records `client_aborted`, an upstream drop (model
`drop`) closes the client connection and records `upstream_error` /
`upstream_aborted`, and every `gw` command runs.
`node test/fake-upstream.js 9998 700` gives a slow stream for abort tests.

Admin API: add `ADMIN_TOKEN_FILE=<file with 32+ chars>` to the server command
and check at least: without the file every `/gateway/admin/*` path is 404;
wrong token, no token, the token in `x-api-key`, or a workstation key → 401
and the fake upstream receives nothing; unmatched `/gateway/admin/foo` → 404;
the 11th failure from one IP → 429; `ADMIN_ALLOWED_IPS` set to another IP →
403; create → 201 and the key works, duplicate → 409, bad name → 400, body
over 16 KB → 413; rotate → the old key gets 401; delete → the key gets 401
and its usage rows stay; sync paging with a small `limit` returns every id
exactly once and contains no `key_hash`; `export.csv` is byte-identical to
`gw export` for the same `since`/`ws`; a large export doesn't hold up other
requests (poll `/health` during it); aborting exports doesn't crash; and the
log never contains the admin token or a workstation key.

Final check is always a real Claude Code session against the real gateway.
Docker isn't available in every dev environment; say so when the image build
wasn't tested.

## Deployment

AWS Lightsail, $5/month plan (512 MB, 447 MB usable), Debian, public IPv4 and
a static IP. 1 GB swap file with `vm.swappiness=10`; unattended-upgrades for
security updates. Docker from Docker's official apt repo (Compose plugin).
Project lives in `/opt/claude-code-gateway`, owned by the `admin` user. The
certbot deploy hook hard-codes that folder's `certs/` path; if the folder moves,
rerun `deploy/setup-cert.sh` from the new location.
`deploy/setup-cert.sh` assumes apt (Debian/Ubuntu). The README has every
setup command in order; keep it in sync when deployment changes.

Measured on the instance: Debian idle ~80 MB used, ~120 MB after Docker
(~330 MB available). The gateway adds ~50–80 MB normally.

Route 53 A record `claude.semafore.co` → static IP. Lightsail firewall:
22, 80, 443 only. Memory is the tight constraint; that's why there is no
reverse proxy and no extra containers.

```
sudo ./deploy/setup-cert.sh claude.semafore.co [email]   # once
docker compose up -d --build
docker compose exec gateway gw <command>
```

- One container, published as host 443 → container 8443 (non-root, no
  capabilities needed).
- HTTPS is native Node (`https.createServer`, TLS 1.2+) when `TLS_CERT_FILE`
  and `TLS_KEY_FILE` are set; plain HTTP otherwise (local testing). The server
  checks the files' mtimes every `TLS_RELOAD_MINUTES` (60) and calls
  `setSecureContext` on change, so renewals need no restart. A bad renewed
  file keeps the old certificate.
- Certificates: certbot (apt package, standalone HTTP-01 on port 80) on the
  host. `deploy/setup-cert.sh` installs a deploy hook in
  `/etc/letsencrypt/renewal-hooks/deploy/` that copies `fullchain.pem` and
  `privkey.pem` into `./certs` owned by uid 1000, mounted read-only at
  `/certs`. certbot.timer handles renewal. Don't add an ACME client in Node:
  CSR generation isn't possible with Node built-ins, and the zero-dependency
  rule stands.
- `TRUST_PROXY=1` makes logs use `X-Forwarded-For`; off by default because
  there is no proxy and clients could spoof it.
- `GLOBAL_BLOCKED_MODELS=*fable*` is set in `.env` on the server. `.env`
  changes need `docker compose up -d` (recreates the container); `restart`
  doesn't re-read `.env`. Global blocks can't be overridden per workstation.
- Memory limit 192 MB with `--max-old-space-size=96` (set in compose, which
  overrides the Dockerfile's `NODE_OPTIONS`).
- Secret: `secrets/setup-token`, mounted at `/run/secrets/setup_token`.
  The container runs as uid 1000; the file must be readable by it.
- Secret: `secrets/admin-token`, mounted at `/run/secrets/admin_token`
  (`ADMIN_TOKEN_FILE`). It must exist: depending on the Compose version, a
  missing file either stops `up` or makes Docker create an empty directory at
  `secrets/admin-token` (seen with Compose v5.5.1; the gateway then logs
  `admin API disabled: cannot read ...`). An empty file keeps the admin API
  off. Read once at startup, so restart after changing it.
  `ADMIN_ALLOWED_IPS` comes from `.env` (listed in compose).
- Container is read-only with all capabilities dropped; only `/data` is
  writable.
- Workstations set `ANTHROPIC_BASE_URL=https://claude.semafore.co` and
  `ANTHROPIC_AUTH_TOKEN`, with `ANTHROPIC_API_KEY` and
  `CLAUDE_CODE_OAUTH_TOKEN` unset, and never run `claude login`.

## Things to keep in mind

- The setup-token was created in October 2026 and is valid for about a year.
  Regenerate with `claude setup-token`, replace the secret file, restart.
- Anthropic may change what it accepts for OAuth traffic. If 401/400s appear
  after a Claude Code or API change, set `LOG_HEADERS=1` and compare against
  the verified behaviour above before changing anything.
- New Claude Code versions may call new endpoints; watch the logs for
  `UNLISTED PATH`.
- Usage terms: Max is a personal subscription. This setup is only appropriate
  because one person uses all the workstations. Don't add features aimed at
  sharing it with other people.
