'use strict';
// Workstation and usage operations shared by the `gw` CLI and the admin API
// (admin-http.js). Expected failures throw an Error whose `kind` is 'invalid',
// 'exists' or 'not_found'; any other error is a database error.

const { hashKey, newKey } = require('./db');
const { parsePatterns } = require('./policy');

const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

// Usage columns in CSV and sync order.
const USAGE_COLUMNS = ['id', 'ts', 'workstation', 'session_id', 'method', 'path', 'model', 'status', 'outcome',
  'input_tokens', 'output_tokens', 'cache_write_tokens', 'cache_read_tokens', 'web_search_requests',
  'duration_ms', 'request_id', 'error_type', 'util_5h', 'util_7d'];

const CSV_HEADER = ['iso_time', ...USAGE_COLUMNS].join(',') + '\n';

function fail(kind, message) {
  const err = new Error(message);
  err.kind = kind;
  return err;
}

function validName(name) {
  return typeof name === 'string' && NAME_RE.test(name);
}

// A damaged stored list counts as no blocks, the same as in the proxy.
function blockedList(json) {
  try { return parsePatterns(JSON.parse(json)); } catch { return []; }
}

// ---------- workstations ----------

function getWorkstation(db, name) {
  const ws = db.prepare('SELECT * FROM workstations WHERE name = ?').get(name);
  if (!ws) throw fail('not_found', `no workstation named "${name}"`);
  return ws;
}

// Never includes key_hash.
function listWorkstations(db) {
  return db.prepare('SELECT name, enabled, blocked_models, created_at, last_seen_at FROM workstations ORDER BY name')
    .all().map((r) => ({
      name: r.name,
      enabled: !!r.enabled,
      blocked_models: blockedList(r.blocked_models),
      created_at: r.created_at,
      last_seen_at: r.last_seen_at,
    }));
}

// `blocked`: comma-separated string or array of patterns. The key is only returned here.
function createWorkstation(db, name, blocked) {
  if (!validName(name)) throw fail('invalid', 'name may only contain letters, digits, . _ -');
  if (db.prepare('SELECT 1 FROM workstations WHERE name = ?').get(name)) throw fail('exists', `"${name}" already exists`);
  const list = parsePatterns(blocked);
  const key = newKey(name);
  const createdAt = Date.now();
  db.prepare('INSERT INTO workstations (name, key_hash, blocked_models, created_at) VALUES (?, ?, ?, ?)')
    .run(name, hashKey(key), JSON.stringify(list), createdAt);
  return { name, key, enabled: true, blocked_models: list, created_at: createdAt };
}

function rotateKey(db, name) {
  const ws = getWorkstation(db, name);
  const key = newKey(ws.name);
  db.prepare('UPDATE workstations SET key_hash = ? WHERE name = ?').run(hashKey(key), ws.name);
  return { name: ws.name, key };
}

// Usage history is kept.
function removeWorkstation(db, name) {
  const ws = getWorkstation(db, name);
  db.prepare('DELETE FROM workstations WHERE name = ?').run(ws.name);
  return { name: ws.name, removed: true };
}

// ---------- usage ----------

// 24h, 7d, 30d (any number of h or d), all, or a date such as YYYY-MM-DD.
function sinceMs(value) {
  if (!value || value === 'all') return 0;
  const m = /^(\d+)([hd])$/.exec(value);
  if (m) return Date.now() - Number(m[1]) * (m[2] === 'h' ? 3600e3 : 86400e3);
  const d = Date.parse(value);
  if (Number.isNaN(d)) throw fail('invalid', `can't parse --since "${value}"`);
  return d;
}

// Rows for `gw export` and export.csv, oldest first, as a lazy iterator. The
// scan reads the table in id order (the `+` keeps SQLite off the indexes, which
// would mean sorting everything before the first row, in temp files that the
// read-only container can't create), so each step only reads up to the next
// matching row. With a filter, the matching id range comes from the indexes
// first, so the scan skips the rest of the history.
function exportRows(db, since, ws) {
  const params = { since };
  let where = 'ts >= :since';
  let scan = '+ts >= :since';
  if (typeof ws === 'string') { where += ' AND workstation = :ws'; scan += ' AND +workstation = :ws'; params.ws = ws; }
  let range = { lo: 0, hi: Number.MAX_SAFE_INTEGER };
  if (since > 0 || params.ws !== undefined) {
    range = db.prepare(`SELECT MIN(id) AS lo, MAX(id) AS hi FROM usage WHERE ${where}`).get(params);
  }
  return db.prepare(`SELECT ${USAGE_COLUMNS.join(', ')} FROM usage WHERE id BETWEEN :lo AND :hi AND ${scan} ORDER BY id`)
    .iterate({ ...params, lo: range.lo ?? 1, hi: range.hi ?? 0 });
}

function csvField(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvLine(r) {
  return [new Date(r.ts).toISOString(), ...USAGE_COLUMNS.map((c) => csvField(r[c]))].join(',') + '\n';
}

// Rows are only ever inserted (record() in server.js), never updated, and ids
// only grow, so id is a safe sync cursor. ts is not: it is the request start.
function usageAfter(db, afterId, limit) {
  return db.prepare(`SELECT ${USAGE_COLUMNS.join(', ')} FROM usage WHERE id > ? ORDER BY id LIMIT ?`)
    .all(afterId, limit);
}

function readPlan(db) {
  return db.prepare('SELECT updated_at, headers FROM plan_status WHERE id = 1').get() || null;
}

module.exports = {
  validName, getWorkstation, listWorkstations, createWorkstation, rotateKey, removeWorkstation,
  sinceMs, exportRows, CSV_HEADER, csvLine, usageAfter, readPlan,
};
