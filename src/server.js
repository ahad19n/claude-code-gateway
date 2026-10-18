#!/usr/bin/env node
'use strict';
/*
 * Claude Code gateway — standalone proxy
 *
 * Workstations run Claude Code with:
 *   ANTHROPIC_BASE_URL=https://<gateway-domain>
 *   ANTHROPIC_AUTH_TOKEN=<workstation key from `gw add`>
 *
 * The proxy authenticates the workstation, applies its model block list,
 * swaps in the Max setup-token, streams the request/response through
 * unchanged, and records token usage per workstation in SQLite.
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const { join, extname } = require('path');
const crypto = require('crypto');
const { open, hashKey } = require('./db');
const { parsePatterns, blockingPattern } = require('./policy');
const { makeSseUsageParser, normalizeUsage } = require('./usage-parser');

// ---------- config ----------

const CONFIG = {
  port: Number(process.env.PORT) || 8443,
  host: process.env.HOST || '0.0.0.0',
  upstream: new URL(process.env.UPSTREAM_BASE_URL || 'https://api.anthropic.com'),
  addOauthBeta: process.env.ADD_OAUTH_BETA === '1',
  oauthBetaFlag: process.env.OAUTH_BETA_FLAG || 'oauth-2025-04-20',
  globalBlocked: parsePatterns(process.env.GLOBAL_BLOCKED_MODELS),
  strictPaths: process.env.STRICT_PATHS === '1',
  logHeaders: process.env.LOG_HEADERS === '1',
  maxBodyBytes: 32 * 1024 * 1024,
  tlsCertFile: process.env.TLS_CERT_FILE || '',
  tlsKeyFile: process.env.TLS_KEY_FILE || '',
  tlsReloadMinutes: Number(process.env.TLS_RELOAD_MINUTES) || 60,
  trustProxy: process.env.TRUST_PROXY === '1',
};

const KNOWN_PATHS = new Set(['/v1/messages', '/v1/messages/count_tokens']);
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);
const REDACT = new Set(['authorization', 'x-api-key', 'cookie']);
// Reverse-proxy headers (if any proxy is ever put in front, or a client sends them); never forwarded.
const PROXY_HEADERS = new Set(['x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host',
  'x-forwarded-port', 'x-real-ip', 'forwarded', 'via']);

// Public files (workstation setup scripts), served at /<name> without auth.
const PUBLIC_DIR = join(__dirname, '..', 'public');
const PUBLIC_TYPES = {
  '.ps1': 'text/plain; charset=utf-8', '.sh': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8',
  '.json': 'application/json', '.html': 'text/html; charset=utf-8',
};

function loadToken() {
  let value = '';
  if (process.env.TOKEN_FILE) value = fs.readFileSync(process.env.TOKEN_FILE, 'utf8');
  else if (process.env.CLAUDE_SETUP_TOKEN) value = process.env.CLAUDE_SETUP_TOKEN;
  value = value.trim();
  if (!value) {
    console.error('FATAL: setup-token missing. Set TOKEN_FILE or CLAUDE_SETUP_TOKEN.');
    process.exit(1);
  }
  if (!value.startsWith('sk-ant-oat')) {
    console.warn('WARN: setup-token does not start with sk-ant-oat — is this the right token?');
  }
  return value;
}

const UPSTREAM_TOKEN = loadToken();
const upstreamLib = CONFIG.upstream.protocol === 'http:' ? http : https;

// ---------- database ----------

const db = open();
const q = {
  findWs: db.prepare('SELECT name, enabled, blocked_models FROM workstations WHERE key_hash = ?'),
  touchWs: db.prepare('UPDATE workstations SET last_seen_at = ? WHERE name = ?'),
  insertUsage: db.prepare(`
    INSERT INTO usage (ts, workstation, session_id, method, path, model, status, outcome,
      input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, web_search_requests,
      duration_ms, request_id, error_type, util_5h, util_7d)
    VALUES (:ts, :workstation, :session_id, :method, :path, :model, :status, :outcome,
      :input_tokens, :output_tokens, :cache_write_tokens, :cache_read_tokens, :web_search_requests,
      :duration_ms, :request_id, :error_type, :util_5h, :util_7d)`),
  upsertPlan: db.prepare(`
    INSERT INTO plan_status (id, updated_at, headers) VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, headers = excluded.headers`),
  ping: db.prepare('SELECT 1 AS ok'),
  getPlan: db.prepare('SELECT updated_at, headers FROM plan_status WHERE id = 1'),
  wsUsageSince: db.prepare(`
    SELECT COUNT(*) AS requests,
      SUM(COALESCE(input_tokens,0) + COALESCE(cache_write_tokens,0) + COALESCE(output_tokens,0)) AS tokens
    FROM usage WHERE workstation = :ws AND ts >= :since AND outcome != 'blocked'`),
};

function safeDb(label, fn) {
  try { return fn(); } catch (err) { console.error(`DB error (${label}): ${err.message}`); return null; }
}

// ---------- helpers ----------

function log(id, msg, extra) {
  console.log(`${new Date().toISOString()} [${id}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`);
}

function sendError(res, status, type, message) {
  if (res.headersSent) { res.destroy(); return; }
  const body = JSON.stringify({ type: 'error', error: { type, message } });
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function presentedKey(req) {
  const auth = req.headers['authorization'];
  if (auth && /^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  return String(req.headers['x-api-key'] || '').trim();
}

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) out[k] = REDACT.has(k) ? '[redacted]' : v;
  return out;
}

// Client address for logs. X-Forwarded-For is only trusted with TRUST_PROXY=1
// (i.e. when a reverse proxy sits in front); otherwise clients could fake it.
function clientIp(req) {
  if (!CONFIG.trustProxy) return req.socket.remoteAddress;
  const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
  return xff.length ? xff[xff.length - 1] : req.socket.remoteAddress;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// ---------- plan status for workstations ----------

function windowInfo(h, name, now) {
  const util = num(h[`anthropic-ratelimit-unified-${name}-utilization`]);
  const reset = num(h[`anthropic-ratelimit-unified-${name}-reset`]);
  const resetMs = reset !== null ? reset * 1000 : null;
  // Utilization only refreshes when a request goes through. If the window has
  // already reset since the last request, the stored figure is out of date.
  const hasReset = resetMs !== null && resetMs <= now;
  return {
    utilization: hasReset ? 0 : util,
    status: hasReset ? null : h[`anthropic-ratelimit-unified-${name}-status`] || null,
    resets_at: resetMs !== null && !hasReset ? new Date(resetMs).toISOString() : null,
    resets_in_seconds: resetMs !== null && !hasReset ? Math.round((resetMs - now) / 1000) : null,
    reset_since_last_request: hasReset,
  };
}

function buildStatus(ws) {
  const now = Date.now();
  const plan = safeDb('plan read', () => q.getPlan.get());
  let h = {};
  if (plan) { try { h = JSON.parse(plan.headers); } catch { /* ignore */ } }
  const usage = safeDb('ws usage', () => q.wsUsageSince.get({ ws: ws.name, since: now - 86400e3 })) || {};
  return {
    workstation: ws.name,
    enabled: !!ws.enabled,
    plan_updated_at: plan ? new Date(plan.updated_at).toISOString() : null,
    overall_status: h['anthropic-ratelimit-unified-status'] || null,
    five_hour: windowInfo(h, '5h', now),
    seven_day: windowInfo(h, '7d', now),
    workstation_last_24h: { requests: usage.requests || 0, tokens: usage.tokens || 0 },
  };
}

function fmtDuration(sec) {
  if (sec === null) return null;
  const d = Math.floor(sec / 86400), hr = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d${hr}h`;
  if (hr) return `${hr}h${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

function fmtTokens(n) {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

function statusText(st, color) {
  const paint = (pct, text) => {
    if (!color || pct === null) return text;
    const code = pct >= 80 ? 31 : pct >= 50 ? 33 : 32;   // red / yellow / green
    return `\x1b[${code}m${text}\x1b[0m`;
  };
  const win = (label, w) => {
    if (w.utilization === null && !w.reset_since_last_request) return `${label} --`;
    const pct = Math.round((w.utilization || 0) * 100);
    const reset = fmtDuration(w.resets_in_seconds);
    return paint(pct, `${label} ${pct}%`) + (reset ? ` (${reset})` : '');
  };
  const parts = [];
  if (!st.enabled) parts.push(color ? '\x1b[31mDISABLED\x1b[0m' : 'DISABLED');
  parts.push(win('5h', st.five_hour), win('7d', st.seven_day));
  parts.push(`${st.workstation} 24h ${fmtTokens(st.workstation_last_24h.tokens)} tok`);
  return parts.join(' | ');
}

// ---------- public files ----------

// Serves public/<name> if it exists. Only plain files directly in public/:
// no subfolders, dotfiles or encoded characters, so a path can't reach
// outside it. Returns false to let the request go through the normal flow.
function servePublic(id, req, res, urlPath) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const name = urlPath.slice(1);
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(name)) return false;
  let data;
  try { data = fs.readFileSync(join(PUBLIC_DIR, name)); } catch { return false; }
  req.resume();
  res.writeHead(200, {
    'content-type': PUBLIC_TYPES[extname(name).toLowerCase()] || 'application/octet-stream',
    'content-length': data.length,
    'cache-control': 'no-cache',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
  log(id, `PUBLIC ${req.method} ${urlPath}`, { from: clientIp(req) });
  return true;
}

// ---------- request handling ----------

function handle(req, res) {
  const id = crypto.randomBytes(4).toString('hex');
  const started = Date.now();
  const path = new URL(req.url, 'http://local').pathname;

  // Claude Code's startup connectivity check; answered locally, never forwarded.
  if (path === '/api/hello' && (req.method === 'HEAD' || req.method === 'GET')) {
    res.writeHead(200, { 'content-length': 0 });
    res.end();
    return;
  }

  if (path === '/health' && req.method === 'GET') {
    const ok = safeDb('health', () => q.ping.get()) !== null;
    res.writeHead(ok ? 200 : 503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok }));
    return;
  }

  if (servePublic(id, req, res, path)) return;

  const key = presentedKey(req);
  const ws = key ? safeDb('auth', () => q.findWs.get(hashKey(key))) : null;
  if (!ws) {
    log(id, `REJECT 401 ${req.method} ${path}`, { from: clientIp(req) });
    req.resume();
    return sendError(res, 401, 'authentication_error', 'Invalid gateway key.');
  }

  // Plan status for the workstation's status line. Not forwarded, not recorded.
  if (path === '/gateway/status' && req.method === 'GET') {
    req.resume();
    const params = new URL(req.url, 'http://local').searchParams;
    const st = buildStatus(ws);
    if (params.get('format') === 'json') {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(st));
    } else {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(statusText(st, params.get('color') === '1') + '\n');
    }
    return;
  }

  const rec = {
    ts: started, workstation: ws.name,
    session_id: req.headers['x-claude-code-session-id'] || null,
    method: req.method, path, model: null, status: null, outcome: 'ok',
    input_tokens: null, output_tokens: null, cache_write_tokens: null, cache_read_tokens: null,
    web_search_requests: null, duration_ms: null, request_id: null, error_type: null,
    util_5h: null, util_7d: null,
  };
  let recorded = false;
  const record = () => {
    if (recorded) return;
    recorded = true;
    rec.duration_ms = Date.now() - started;
    safeDb('usage', () => q.insertUsage.run(rec));
    safeDb('touch', () => q.touchWs.run(Date.now(), ws.name));
    log(id, `${ws.name} ${rec.method} ${rec.path} -> ${rec.status} ${rec.outcome}`, {
      model: rec.model, ms: rec.duration_ms,
      in: rec.input_tokens, out: rec.output_tokens,
      cw: rec.cache_write_tokens, cr: rec.cache_read_tokens,
      ...(rec.web_search_requests ? { web: rec.web_search_requests } : {}),
      ...(rec.error_type ? { err: rec.error_type } : {}),
    });
  };

  if (!ws.enabled) {
    rec.status = 403; rec.outcome = 'blocked'; rec.error_type = 'workstation_disabled';
    req.resume();
    record();
    return sendError(res, 403, 'permission_error', `Workstation "${ws.name}" is disabled on the gateway.`);
  }

  if (!KNOWN_PATHS.has(path)) {
    log(id, `UNLISTED PATH ${req.method} ${path} from ${ws.name}${CONFIG.strictPaths ? ' (blocked)' : ' (forwarding)'}`);
    if (CONFIG.strictPaths) {
      rec.status = 404; rec.outcome = 'blocked'; rec.error_type = 'unlisted_path';
      req.resume();
      record();
      return sendError(res, 404, 'not_found_error', `Path not handled by gateway: ${path}`);
    }
  }

  const chunks = [];
  let size = 0;
  let tooBig = false;
  req.on('data', (c) => {
    if (tooBig) return;
    size += c.length;
    if (size > CONFIG.maxBodyBytes) {
      tooBig = true;
      rec.status = 413; rec.outcome = 'blocked'; rec.error_type = 'request_too_large';
      record();
      sendError(res, 413, 'request_too_large', 'Request body too large.');
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => {
    if (tooBig) return;
    forward(id, req, res, ws, rec, record, Buffer.concat(chunks));
  });
  req.on('error', (err) => log(id, 'client request error', { error: err.message }));
}

function forward(id, req, res, ws, rec, record, body) {
  if (body.length && String(req.headers['content-type'] || '').includes('application/json')) {
    try { rec.model = JSON.parse(body.toString('utf8')).model ?? null; } catch { /* forward as-is */ }
  }

  // Model policy: global list first, then the workstation's own list.
  let wsPatterns = [];
  try { wsPatterns = parsePatterns(JSON.parse(ws.blocked_models)); } catch { /* treat as none */ }
  const hit = blockingPattern(rec.model, CONFIG.globalBlocked) || blockingPattern(rec.model, wsPatterns);
  if (hit) {
    rec.status = 403; rec.outcome = 'blocked'; rec.error_type = `model_blocked:${hit}`;
    record();
    return sendError(res, 403, 'permission_error',
      `Model "${rec.model}" is not enabled for workstation "${ws.name}". Pick another model with /model.`);
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k)) continue;
    if (k === 'host' || k === 'authorization' || k === 'x-api-key') continue;
    if (k === 'content-length' || k === 'accept-encoding') continue;
    if (PROXY_HEADERS.has(k)) continue;
    headers[k] = v;
  }
  headers['authorization'] = `Bearer ${UPSTREAM_TOKEN}`;
  headers['accept-encoding'] = 'identity';
  if (body.length) headers['content-length'] = body.length;
  if (CONFIG.addOauthBeta) {
    const flags = String(headers['anthropic-beta'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!flags.includes(CONFIG.oauthBetaFlag)) flags.push(CONFIG.oauthBetaFlag);
    headers['anthropic-beta'] = flags.join(',');
  }

  if (CONFIG.logHeaders) log(id, 'request headers', redactHeaders(req.headers));

  const target = new URL(req.url, CONFIG.upstream);
  const upReq = upstreamLib.request(target, { method: req.method, headers }, (upRes) => {
    rec.status = upRes.statusCode;
    rec.request_id = upRes.headers['request-id'] || null;

    const rl = {};
    for (const [k, v] of Object.entries(upRes.headers)) if (k.startsWith('anthropic-ratelimit')) rl[k] = v;
    if (Object.keys(rl).length) {
      rec.util_5h = num(rl['anthropic-ratelimit-unified-5h-utilization']);
      rec.util_7d = num(rl['anthropic-ratelimit-unified-7d-utilization']);
      safeDb('plan', () => q.upsertPlan.run(Date.now(), JSON.stringify(rl)));
    }

    const out = {};
    for (const [k, v] of Object.entries(upRes.headers)) if (!HOP_BY_HOP.has(k)) out[k] = v;
    res.writeHead(upRes.statusCode, out);

    const isSse = String(upRes.headers['content-type'] || '').includes('text/event-stream');
    const parser = isSse ? makeSseUsageParser() : null;
    const jsonChunks = [];
    let jsonLen = 0;

    upRes.on('data', (c) => {
      if (parser) parser.push(c);
      else if (jsonLen < 1024 * 1024) { jsonChunks.push(c); jsonLen += c.length; }
    });
    upRes.pipe(res);

    let finalized = false;
    const finalize = (abortedBy) => {   // null | 'client' | 'upstream'
      if (finalized) return;
      finalized = true;
      let usage = {};
      if (parser) {
        usage = parser.state.usage;
        if (parser.state.errorType) rec.error_type = parser.state.errorType;
      } else if (jsonChunks.length) {
        try {
          const parsed = JSON.parse(Buffer.concat(jsonChunks).toString('utf8'));
          if (parsed.usage) usage = parsed.usage;
          if (parsed.type === 'error' && parsed.error) rec.error_type = parsed.error.type || 'unknown';
        } catch { /* non-JSON body */ }
      }
      Object.assign(rec, normalizeUsage(usage));
      if (abortedBy === 'client') rec.outcome = 'client_aborted';
      else if (abortedBy === 'upstream') {
        rec.outcome = 'upstream_error';
        rec.error_type = rec.error_type || 'upstream_aborted';
      } else if (rec.status >= 400 || rec.error_type) rec.outcome = 'upstream_error';
      record();
    };

    upRes.on('end', () => finalize(null));
    // Anthropic dropped the connection mid-response. Break ours too, so the
    // workstation sees a failed stream (and retries) instead of waiting forever.
    upRes.on('close', () => {
      if (upRes.complete) return;
      finalize('upstream');
      res.destroy();
    });
    res.on('close', () => { if (!res.writableFinished) finalize('client'); });
  });

  upReq.on('error', (err) => {
    if (rec.status === null) {
      rec.status = 502; rec.outcome = 'gateway_error'; rec.error_type = err.code || 'upstream_unreachable';
      record();
      sendError(res, 502, 'api_error', 'Gateway could not reach Anthropic.');
    } else {
      log(id, 'upstream stream error', { error: err.message });
    }
  });

  res.on('close', () => { if (!res.writableFinished) upReq.destroy(); });

  upReq.end(body);
}

// ---------- start ----------

// HTTPS when TLS_CERT_FILE and TLS_KEY_FILE are set (certificates renewed by
// certbot on the host and reloaded here without a restart); plain HTTP otherwise.
const useTls = !!(CONFIG.tlsCertFile && CONFIG.tlsKeyFile);

function readTls() {
  return { cert: fs.readFileSync(CONFIG.tlsCertFile), key: fs.readFileSync(CONFIG.tlsKeyFile) };
}

function tlsMtime() {
  try {
    return fs.statSync(CONFIG.tlsCertFile).mtimeMs + fs.statSync(CONFIG.tlsKeyFile).mtimeMs;
  } catch { return null; }
}

let server;
if (useTls) {
  let tls;
  try { tls = readTls(); } catch (err) {
    console.error(`FATAL: cannot read TLS certificate/key (${err.message}).`);
    console.error('Obtain the certificate first: sudo ./deploy/setup-cert.sh <domain> [email]');
    process.exit(1);
  }
  server = https.createServer({ ...tls, minVersion: 'TLSv1.2' }, handle);

  let lastMtime = tlsMtime();
  setInterval(() => {
    const m = tlsMtime();
    if (m === null || m === lastMtime) return;
    try {
      server.setSecureContext({ ...readTls(), minVersion: 'TLSv1.2' });
      lastMtime = m;
      console.log(`${new Date().toISOString()} TLS certificate reloaded`);
    } catch (err) {
      console.error(`TLS reload failed, keeping current certificate: ${err.message}`);
    }
  }, CONFIG.tlsReloadMinutes * 60e3).unref();
} else {
  server = http.createServer(handle);
}
server.requestTimeout = 0;
server.timeout = 0;

server.listen(CONFIG.port, CONFIG.host, () => {
  console.log(`Claude gateway listening on ${useTls ? 'https' : 'http'}://${CONFIG.host}:${CONFIG.port}`);
  console.log(`  upstream:          ${CONFIG.upstream.origin}`);
  console.log(`  global blocked:    ${CONFIG.globalBlocked.length ? CONFIG.globalBlocked.join(', ') : '(none)'}`);
  console.log(`  oauth beta flag:   ${CONFIG.addOauthBeta ? 'added if missing' : 'not added'}`);
  console.log(`  strict paths:      ${CONFIG.strictPaths}`);
  const count = safeDb('count', () => db.prepare('SELECT COUNT(*) AS n FROM workstations').get().n);
  console.log(`  workstations:      ${count ?? '?'}`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down`);
    server.close(() => { safeDb('close', () => db.close()); process.exit(0); });
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
