'use strict';
// Admin API under /gateway/admin for the web portal's backend (server to
// server, so no CORS). Authenticated only by the admin token, never by a
// workstation key. Requests are never forwarded upstream and never recorded
// in usage. Without a valid token file every path returns 404.

const fs = require('fs');
const net = require('net');
const crypto = require('crypto');
const { openReadOnly } = require('./db');
const admin = require('./admin');

const PREFIX = '/gateway/admin';
const MIN_TOKEN_LENGTH = 32;
const MAX_BODY_BYTES = 16 * 1024;
const SYNC_LIMIT_DEFAULT = 1000;
const SYNC_LIMIT_MAX = 5000;          // one page stays well inside the 96 MB heap
const FAIL_LIMIT = 10;                // failed logins per IP per window, then 429
const FAIL_WINDOW_MS = 10 * 60e3;
const FAIL_MAX_IPS = 1000;            // cap on tracked IPs, so memory stays bounded
const EXPORT_CHUNK_BYTES = 64 * 1024;
const EXPORT_SLICE_MS = 20;           // most CPU time one export chunk may take
const EXPORT_STALL_MS = 60e3;         // drop an export whose client stops reading

const KIND_STATUS = {
  invalid: [400, 'invalid_request_error'],
  exists: [409, 'invalid_request_error'],
  not_found: [404, 'not_found_error'],
};

let deps = null;                      // { db, log, sendError, clientIp, windowInfo, globalBlocked }
let cfg = { reason: 'not initialised' };
const failures = new Map();           // ip -> { count, resetAt }; Maps keep insertion order

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

// Reads the token file and allowlist once at startup. Only the token's hash is
// kept. Anything wrong disables the API; a bad allowlist entry never means "any IP".
function loadConfig(env) {
  const file = env.ADMIN_TOKEN_FILE;
  if (!file) return { reason: 'ADMIN_TOKEN_FILE not set' };
  let token;
  try { token = fs.readFileSync(file, 'utf8').trim(); } catch { return { reason: `cannot read ${file}` }; }
  if (token.length < MIN_TOKEN_LENGTH) return { reason: `token in ${file} is empty or under ${MIN_TOKEN_LENGTH} characters` };
  const ips = String(env.ADMIN_ALLOWED_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);
  let allow = null;
  if (ips.length) {
    allow = new net.BlockList();
    for (const ip of ips) {
      const family = net.isIP(ip);
      if (!family) return { reason: `ADMIN_ALLOWED_IPS has an invalid address "${ip}"` };
      allow.addAddress(ip, family === 6 ? 'ipv6' : 'ipv4');
    }
  }
  return { tokenHash: sha256(token), allow, ips };
}

function init(d) {
  deps = d;
  cfg = loadConfig(process.env);
  if (!cfg.tokenHash) console.log(`admin API disabled: ${cfg.reason}`);
}

function describe() {
  if (!cfg.tokenHash) return 'disabled';
  return cfg.ips.length ? `enabled, from ${cfg.ips.join(', ')}` : 'enabled, from any address';
}

function isAdminPath(path) {
  return path === PREFIX || path.startsWith(PREFIX + '/');
}

// ---------- auth ----------

// Only `Authorization: Bearer <admin token>`, compared as sha256 digests in constant time.
function validToken(req) {
  const m = /^bearer\s+(.+)$/i.exec(String(req.headers['authorization'] || ''));
  return !!m && crypto.timingSafeEqual(sha256(m[1].trim()), cfg.tokenHash);
}

function ipAllowed(ip) {
  const family = net.isIP(String(ip || ''));
  return family !== 0 && cfg.allow.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

// Seconds until this IP may try again, or 0 if it isn't locked out.
function lockedFor(ip, now) {
  const f = failures.get(ip);
  if (!f) return 0;
  if (now >= f.resetAt) { failures.delete(ip); return 0; }
  return f.count >= FAIL_LIMIT ? Math.ceil((f.resetAt - now) / 1000) : 0;
}

function noteFailure(ip, now) {
  let f = failures.get(ip);
  if (!f || now >= f.resetAt) {
    failures.delete(ip);
    if (failures.size >= FAIL_MAX_IPS) {
      for (const [k, v] of failures) if (now >= v.resetAt) failures.delete(k);
      if (failures.size >= FAIL_MAX_IPS) failures.delete(failures.keys().next().value);   // oldest
    }
    f = { count: 0, resetAt: now + FAIL_WINDOW_MS };
    failures.set(ip, f);
  }
  f.count++;
}

// ---------- responses ----------

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function reply(ctx, action, status, body) {
  deps.log(ctx.id, `ADMIN ${action} from ${ctx.ip}`);
  sendJson(ctx.res, status, body);
}

// Never logs headers or bodies, so the admin token and workstation keys stay out of the log.
function reject(ctx, status, type, message, note) {
  deps.log(ctx.id, `ADMIN REJECT ${status} ${ctx.req.method} ${ctx.path} from ${ctx.ip}${note ? ` (${note})` : ''}`);
  ctx.req.resume();
  deps.sendError(ctx.res, status, type, message);
}

// Runs a database operation. Bad name / exists / not found become 400 / 409 /
// 404; anything else is a database error and becomes a 500. Returns null after
// answering an error.
function run(ctx, fn) {
  try { return fn(); } catch (err) {
    const [status, type] = KIND_STATUS[err.kind] || [];
    if (status) reject(ctx, status, type, err.message);
    else reject(ctx, 500, 'api_error', 'Gateway database error.', `database error: ${err.message}`);
    return null;
  }
}

// ---------- request handling ----------

function handle(id, req, res, path) {
  const ctx = { id, req, res, path, ip: deps.clientIp(req) };
  res.setHeader('cache-control', 'no-store');   // some responses carry keys
  try {
    if (!cfg.tokenHash) return reject(ctx, 404, 'not_found_error', `Path not handled by gateway: ${path}`, 'admin API disabled');
    if (cfg.allow && !ipAllowed(ctx.ip)) return reject(ctx, 403, 'permission_error', 'Admin API is not available from this address.');
    const now = Date.now();
    const wait = lockedFor(ctx.ip, now);
    if (wait) {
      res.setHeader('retry-after', String(wait));
      return reject(ctx, 429, 'rate_limit_error', 'Too many failed admin requests. Try again later.');
    }
    if (!validToken(req)) {
      noteFailure(ctx.ip, now);
      return reject(ctx, 401, 'authentication_error', 'Invalid admin token.');
    }
    route(ctx);
  } catch (err) {
    reject(ctx, 500, 'api_error', 'Gateway error.', `error: ${err.message}`);
  }
}

function route(ctx) {
  const { req } = ctx;
  const sub = ctx.path.slice(PREFIX.length);
  const params = new URL(req.url, 'http://local').searchParams;
  const named = /^\/workstations\/([^/]+)(\/rotate)?$/.exec(sub);
  if (sub === '/workstations' && req.method === 'GET') return listRoute(ctx);
  if (sub === '/workstations' && req.method === 'POST') return createRoute(ctx);
  if (named && named[2] && req.method === 'POST') return rotateRoute(ctx, named[1]);
  if (named && !named[2] && req.method === 'DELETE') return removeRoute(ctx, named[1]);
  if (sub === '/sync' && req.method === 'GET') return syncRoute(ctx, params);
  if (sub === '/export.csv' && req.method === 'GET') return exportRoute(ctx, params);
  reject(ctx, 404, 'not_found_error', `Path not handled by gateway: ${ctx.path}`);
}

// {name} from the path: percent-decoded, then checked like `gw add` names.
function pathName(ctx, raw) {
  let name = null;
  try { name = decodeURIComponent(raw); } catch { /* malformed escape */ }
  if (admin.validName(name)) return name;
  reject(ctx, 400, 'invalid_request_error', 'name may only contain letters, digits, . _ -');
  return null;
}

// Reads a JSON body of at most MAX_BODY_BYTES; answers 400 / 413 itself.
function readJson(ctx, cb) {
  const { req } = ctx;
  const tooBig = () => reject(ctx, 413, 'request_too_large', `Request body over ${MAX_BODY_BYTES / 1024} KB.`);
  if (Number(req.headers['content-length']) > MAX_BODY_BYTES) return tooBig();
  const chunks = [];
  let size = 0;
  let over = false;
  req.on('data', (c) => {
    if (over) return;
    size += c.length;
    if (size > MAX_BODY_BYTES) { over = true; chunks.length = 0; tooBig(); return; }
    chunks.push(c);
  });
  req.on('end', () => {
    if (over) return;
    let body;
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {
      return reject(ctx, 400, 'invalid_request_error', 'Body must be JSON.');
    }
    try { cb(body); } catch (err) { reject(ctx, 500, 'api_error', 'Gateway error.', `error: ${err.message}`); }
  });
  req.on('error', () => { /* client went away; nothing to answer */ });
}

// Query parameter as a whole number: `fallback` when absent, null when invalid.
function wholeNumber(value, fallback) {
  if (value === null || value === '') return fallback;
  return /^\d{1,15}$/.test(value) ? Number(value) : null;
}

// ---------- routes ----------

function listRoute(ctx) {
  ctx.req.resume();
  const list = run(ctx, () => admin.listWorkstations(deps.db));
  if (list) reply(ctx, 'list', 200, { global_blocked_models: deps.globalBlocked, workstations: list });
}

function createRoute(ctx) {
  readJson(ctx, (body) => {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return reject(ctx, 400, 'invalid_request_error', 'Body must be a JSON object.');
    }
    const { name, blocked_models: blocked } = body;
    if (typeof name !== 'string') return reject(ctx, 400, 'invalid_request_error', 'name is required.');
    if (blocked != null && !(Array.isArray(blocked) && blocked.every((p) => typeof p === 'string'))) {
      return reject(ctx, 400, 'invalid_request_error', 'blocked_models must be an array of strings.');
    }
    const ws = run(ctx, () => admin.createWorkstation(deps.db, name, blocked));
    if (ws) reply(ctx, `create ${ws.name}`, 201, ws);
  });
}

function rotateRoute(ctx, raw) {
  ctx.req.resume();
  const name = pathName(ctx, raw);
  const out = name && run(ctx, () => admin.rotateKey(deps.db, name));
  if (out) reply(ctx, `rotate ${out.name}`, 200, out);
}

function removeRoute(ctx, raw) {
  ctx.req.resume();
  const name = pathName(ctx, raw);
  const out = name && run(ctx, () => admin.removeWorkstation(deps.db, name));
  if (out) reply(ctx, `remove ${out.name}`, 200, out);
}

function planJson(row, now) {
  if (!row) return null;
  let h = {};
  try { h = JSON.parse(row.headers); } catch { /* treat as empty */ }
  return {
    updated_at: row.updated_at,
    overall_status: h['anthropic-ratelimit-unified-status'] || null,
    five_hour: deps.windowInfo(h, '5h', now),
    seven_day: deps.windowInfo(h, '7d', now),
    raw_headers: h,
  };
}

// Incremental sync for the portal: usage rows after `after_id` (id is the
// cursor), plus the full workstation list and the latest plan status.
function syncRoute(ctx, params) {
  ctx.req.resume();
  const afterId = wholeNumber(params.get('after_id'), 0);
  const limit = wholeNumber(params.get('limit'), SYNC_LIMIT_DEFAULT);
  if (afterId === null || limit === null || limit < 1) {
    return reject(ctx, 400, 'invalid_request_error', 'after_id must be a whole number, and limit a whole number of at least 1.');
  }
  const pageSize = Math.min(limit, SYNC_LIMIT_MAX);
  const now = Date.now();
  const data = run(ctx, () => ({
    rows: admin.usageAfter(deps.db, afterId, pageSize),
    workstations: admin.listWorkstations(deps.db),
    plan: admin.readPlan(deps.db),
  }));
  if (!data) return;
  const { rows } = data;
  reply(ctx, `sync after_id=${afterId} rows=${rows.length}`, 200, {
    generated_at: now,
    global_blocked_models: deps.globalBlocked,
    workstations: data.workstations,
    plan: planJson(data.plan, now),
    usage: {
      rows,
      next_after_id: rows.length ? rows[rows.length - 1].id : afterId,
      has_more: rows.length === pageSize,
    },
  });
}

// Same bytes as `gw export`, streamed from a separate read-only connection in
// chunks, waiting for 'drain' when the client is slow. Each chunk is capped in
// size and time, and the next one starts from setImmediate, so proxy traffic
// gets a turn in between even during a large export.
function exportRoute(ctx, params) {
  const { id, req, res, ip } = ctx;
  req.resume();
  const sinceArg = params.get('since') || 'all';
  const ws = params.get('ws') || undefined;
  let since;
  try { since = admin.sinceMs(sinceArg); } catch {
    return reject(ctx, 400, 'invalid_request_error', 'since must be like 24h, 7d, 30d, all or YYYY-MM-DD.');
  }
  if (ws !== undefined && !admin.validName(ws)) {
    return reject(ctx, 400, 'invalid_request_error', 'ws is not a valid workstation name.');
  }

  let ro = null;
  let rows;
  let next;
  try {
    ro = openReadOnly();
    rows = admin.exportRows(ro, since, ws);
    next = rows.next();
  } catch (err) {
    if (ro) try { ro.close(); } catch { /* already closed */ }
    return reject(ctx, 500, 'api_error', 'Gateway database error.', `database error: ${err.message}`);
  }

  let count = 0;
  let timer = null;
  let endNote = 'aborted';
  const release = () => {
    clearTimeout(timer);
    if (!ro) return;
    try { rows.return(); } catch { /* already finished */ }
    try { ro.close(); } catch { /* already closed */ }
    ro = null;
  };
  res.on('close', () => {
    release();
    deps.log(id, `ADMIN export ${res.writableFinished ? 'done' : endNote} from ${ip}`,
      { since: sinceArg, ...(ws ? { ws } : {}), rows: count });
  });

  const pump = () => {
    clearTimeout(timer);
    if (!ro || res.destroyed) return;
    let chunk = '';
    const until = Date.now() + EXPORT_SLICE_MS;
    try {
      while (!next.done && chunk.length < EXPORT_CHUNK_BYTES && Date.now() < until) {
        chunk += admin.csvLine(next.value);
        count++;
        next = rows.next();
      }
    } catch (err) {
      endNote = `failed (database error: ${err.message})`;
      res.destroy();   // the client sees a broken transfer, not a short CSV
      return;
    }
    if (next.done) { release(); res.end(chunk); return; }
    if (!chunk || res.write(chunk)) { setImmediate(pump); return; }
    // 'drain' can fire from process.nextTick when the socket took the data at
    // once; calling pump straight from it would never yield to other requests.
    res.once('drain', () => { clearTimeout(timer); setImmediate(pump); });
    timer = setTimeout(() => { endNote = 'stalled'; res.destroy(); }, EXPORT_STALL_MS);
  };

  res.writeHead(200, {
    'content-type': 'text/csv; charset=utf-8',
    'content-disposition': `attachment; filename="usage-${new Date().toISOString().slice(0, 10)}.csv"`,
  });
  res.write(admin.CSV_HEADER);
  pump();
}

module.exports = { init, describe, isAdminPath, handle };
