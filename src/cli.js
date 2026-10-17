#!/usr/bin/env node
'use strict';
/*
 * gw — admin CLI for the Claude Code gateway.
 * Run inside the container:  docker compose exec gateway gw <command>
 */

const { open, hashKey, newKey } = require('./db');
const { parsePatterns } = require('./policy');

const HELP = `gw — Claude Code gateway admin

Workstations
  gw add <name> [--block "<pattern>,..."]   Create a workstation; prints its key once
  gw list                                   List workstations
  gw rotate <name>                          Issue a new key (old key stops working)
  gw disable <name> | gw enable <name>      Turn a workstation off / on
  gw remove <name>                          Delete a workstation (usage history is kept)

Model blocking  (glob patterns, case-insensitive, e.g. "*fable*")
  gw block <name> <pattern> [...]           Block models for a workstation
  gw unblock <name> <pattern> [...]         Remove block patterns
  (GLOBAL_BLOCKED_MODELS in .env applies to every workstation)

Usage
  gw usage [--since 24h|7d|30d|all|YYYY-MM-DD] [--by workstation|model|day|session]
           [--ws <name>]
  gw recent [--ws <name>] [--limit 20]      Latest requests
  gw plan                                   Latest Max utilization reported by Anthropic
  gw export [--since ...] [--ws <name>]     CSV of usage rows to stdout
`;

function parseArgs(argv) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) { opts[k] = next; i++; } else opts[k] = true;
    } else pos.push(a);
  }
  return { pos, opts };
}

function die(msg) { console.error(`error: ${msg}`); process.exit(1); }

function sinceMs(value) {
  if (!value || value === 'all') return 0;
  const m = /^(\d+)([hd])$/.exec(value);
  if (m) return Date.now() - Number(m[1]) * (m[2] === 'h' ? 3600e3 : 86400e3);
  const d = Date.parse(value);
  if (Number.isNaN(d)) die(`can't parse --since "${value}"`);
  return d;
}

function fmtTime(ms) {
  if (!ms) return '-';
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

function fmtNum(n) {
  if (n === null || n === undefined) return '-';
  return Number(n).toLocaleString('en-US');
}

function table(rows, columns) {
  if (!rows.length) { console.log('(no rows)'); return; }
  const cells = rows.map((r) => columns.map((c) => String(c.fmt ? c.fmt(r[c.key], r) : (r[c.key] ?? '-'))));
  const widths = columns.map((c, i) => Math.max(c.label.length, ...cells.map((row) => row[i].length)));
  const line = (vals) => vals.map((v, i) => (columns[i].right ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join('  ');
  console.log(line(columns.map((c) => c.label)));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const row of cells) console.log(line(row));
}

function getWs(db, name) {
  const ws = db.prepare('SELECT * FROM workstations WHERE name = ?').get(name);
  if (!ws) die(`no workstation named "${name}"`);
  return ws;
}

function setBlocked(db, name, list) {
  db.prepare('UPDATE workstations SET blocked_models = ? WHERE name = ?').run(JSON.stringify(list), name);
}

function printKey(name, key) {
  console.log(`Key for "${name}" (shown once — store it now):\n\n  ${key}\n`);
  console.log('On the workstation:');
  console.log('  ANTHROPIC_BASE_URL=https://<gateway-domain>');
  console.log(`  ANTHROPIC_AUTH_TOKEN=${key}`);
}

// ---------- commands ----------

const commands = {
  add(db, { pos, opts }) {
    const name = pos[0];
    if (!name) die('usage: gw add <name> [--block "<pattern>,..."]');
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) die('name may only contain letters, digits, . _ -');
    if (db.prepare('SELECT 1 FROM workstations WHERE name = ?').get(name)) die(`"${name}" already exists`);
    const blocked = parsePatterns(typeof opts.block === 'string' ? opts.block : '');
    const key = newKey(name);
    db.prepare('INSERT INTO workstations (name, key_hash, blocked_models, created_at) VALUES (?, ?, ?, ?)')
      .run(name, hashKey(key), JSON.stringify(blocked), Date.now());
    console.log(`Added "${name}"${blocked.length ? `, blocked: ${blocked.join(', ')}` : ''}.`);
    printKey(name, key);
  },

  list(db) {
    const global = parsePatterns(process.env.GLOBAL_BLOCKED_MODELS);
    if (global.length) console.log(`Global block list: ${global.join(', ')}\n`);
    const rows = db.prepare('SELECT * FROM workstations ORDER BY name').all();
    table(rows, [
      { key: 'name', label: 'WORKSTATION' },
      { key: 'enabled', label: 'STATUS', fmt: (v) => (v ? 'enabled' : 'DISABLED') },
      { key: 'blocked_models', label: 'BLOCKED MODELS', fmt: (v) => JSON.parse(v).join(', ') || '-' },
      { key: 'last_seen_at', label: 'LAST SEEN (UTC)', fmt: fmtTime },
      { key: 'created_at', label: 'CREATED (UTC)', fmt: fmtTime },
    ]);
  },

  rotate(db, { pos }) {
    const ws = getWs(db, pos[0] || die('usage: gw rotate <name>'));
    const key = newKey(ws.name);
    db.prepare('UPDATE workstations SET key_hash = ? WHERE name = ?').run(hashKey(key), ws.name);
    console.log(`Rotated "${ws.name}". The old key no longer works.`);
    printKey(ws.name, key);
  },

  disable(db, { pos }) {
    const ws = getWs(db, pos[0] || die('usage: gw disable <name>'));
    db.prepare('UPDATE workstations SET enabled = 0 WHERE name = ?').run(ws.name);
    console.log(`Disabled "${ws.name}".`);
  },

  enable(db, { pos }) {
    const ws = getWs(db, pos[0] || die('usage: gw enable <name>'));
    db.prepare('UPDATE workstations SET enabled = 1 WHERE name = ?').run(ws.name);
    console.log(`Enabled "${ws.name}".`);
  },

  remove(db, { pos }) {
    const ws = getWs(db, pos[0] || die('usage: gw remove <name>'));
    db.prepare('DELETE FROM workstations WHERE name = ?').run(ws.name);
    console.log(`Removed "${ws.name}". Its usage history is kept.`);
  },

  block(db, { pos }) {
    const [name, ...patterns] = pos;
    if (!name || !patterns.length) die('usage: gw block <name> <pattern> [...]');
    const ws = getWs(db, name);
    const list = parsePatterns(JSON.parse(ws.blocked_models));
    for (const p of parsePatterns(patterns.join(','))) if (!list.includes(p)) list.push(p);
    setBlocked(db, ws.name, list);
    console.log(`"${ws.name}" blocked models: ${list.join(', ')}`);
  },

  unblock(db, { pos }) {
    const [name, ...patterns] = pos;
    if (!name || !patterns.length) die('usage: gw unblock <name> <pattern> [...]');
    const ws = getWs(db, name);
    const remove = new Set(parsePatterns(patterns.join(',')));
    const list = parsePatterns(JSON.parse(ws.blocked_models)).filter((p) => !remove.has(p));
    setBlocked(db, ws.name, list);
    console.log(`"${ws.name}" blocked models: ${list.join(', ') || '(none)'}`);
  },

  usage(db, { opts }) {
    const by = opts.by || 'workstation';
    const groupExpr = {
      workstation: 'workstation',
      model: "COALESCE(model, '(none)')",
      day: "strftime('%Y-%m-%d', ts / 1000, 'unixepoch')",
      session: "COALESCE(session_id, '(none)')",
    }[by];
    if (!groupExpr) die('--by must be workstation, model, day or session');
    const params = { since: sinceMs(opts.since || '7d') };
    let where = 'ts >= :since';
    if (typeof opts.ws === 'string') { where += ' AND workstation = :ws'; params.ws = opts.ws; }
    const extraCols = by === 'session' ? ', workstation AS ws_name, MIN(ts) AS first_ts' : '';
    const groupBy = by === 'session' ? 'grp, workstation' : 'grp';
    const rows = db.prepare(`
      SELECT ${groupExpr} AS grp,
        COUNT(*) AS requests,
        SUM(outcome = 'blocked') AS blocked,
        SUM(outcome IN ('upstream_error','gateway_error')) AS errors,
        SUM(COALESCE(input_tokens,0)) AS input,
        SUM(COALESCE(output_tokens,0)) AS output,
        SUM(COALESCE(cache_write_tokens,0)) AS cache_write,
        SUM(COALESCE(cache_read_tokens,0)) AS cache_read,
        SUM(COALESCE(web_search_requests,0)) AS web
        ${extraCols}
      FROM usage WHERE ${where}
      GROUP BY ${groupBy} ORDER BY ${by === 'day' ? 'grp' : 'output DESC'}`).all(params);
    console.log(`Usage since ${opts.since || '7d'}${params.ws ? ` for ${params.ws}` : ''}, by ${by}\n`);
    const cols = [{ key: 'grp', label: by.toUpperCase() }];
    if (by === 'session') {
      cols.push({ key: 'ws_name', label: 'WORKSTATION' }, { key: 'first_ts', label: 'STARTED (UTC)', fmt: fmtTime });
    }
    cols.push(
      { key: 'requests', label: 'REQUESTS', right: true, fmt: fmtNum },
      { key: 'input', label: 'INPUT', right: true, fmt: fmtNum },
      { key: 'output', label: 'OUTPUT', right: true, fmt: fmtNum },
      { key: 'cache_write', label: 'CACHE WRITE', right: true, fmt: fmtNum },
      { key: 'cache_read', label: 'CACHE READ', right: true, fmt: fmtNum },
      { key: 'web', label: 'WEB SEARCH', right: true, fmt: fmtNum },
      { key: 'blocked', label: 'BLOCKED', right: true, fmt: fmtNum },
      { key: 'errors', label: 'ERRORS', right: true, fmt: fmtNum },
    );
    table(rows, cols);
  },

  recent(db, { opts }) {
    const params = { limit: Number(opts.limit) || 20 };
    let where = '1=1';
    if (typeof opts.ws === 'string') { where = 'workstation = :ws'; params.ws = opts.ws; }
    const rows = db.prepare(`SELECT * FROM usage WHERE ${where} ORDER BY id DESC LIMIT :limit`).all(params);
    table(rows.reverse(), [
      { key: 'ts', label: 'TIME (UTC)', fmt: (v) => new Date(v).toISOString().replace('T', ' ').slice(0, 19) },
      { key: 'workstation', label: 'WORKSTATION' },
      { key: 'model', label: 'MODEL' },
      { key: 'status', label: 'STATUS' },
      { key: 'outcome', label: 'OUTCOME' },
      { key: 'input_tokens', label: 'IN', right: true, fmt: fmtNum },
      { key: 'output_tokens', label: 'OUT', right: true, fmt: fmtNum },
      { key: 'cache_read_tokens', label: 'CACHE R', right: true, fmt: fmtNum },
      { key: 'duration_ms', label: 'MS', right: true, fmt: fmtNum },
      { key: 'error_type', label: 'ERROR' },
    ]);
  },

  plan(db) {
    const row = db.prepare('SELECT * FROM plan_status WHERE id = 1').get();
    if (!row) { console.log('No data yet — it is recorded from the next proxied request.'); return; }
    const h = JSON.parse(row.headers);
    const pct = (v) => (v === undefined ? '-' : `${Math.round(Number(v) * 100)}%`);
    const at = (v) => (v ? new Date(Number(v) * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '-');
    console.log(`As of ${fmtTime(row.updated_at)} UTC\n`);
    console.log(`  5-hour window:  ${pct(h['anthropic-ratelimit-unified-5h-utilization'])} used, ${h['anthropic-ratelimit-unified-5h-status'] || '-'}, resets ${at(h['anthropic-ratelimit-unified-5h-reset'])}`);
    console.log(`  7-day window:   ${pct(h['anthropic-ratelimit-unified-7d-utilization'])} used, ${h['anthropic-ratelimit-unified-7d-status'] || '-'}, resets ${at(h['anthropic-ratelimit-unified-7d-reset'])}`);
    console.log(`  overall status: ${h['anthropic-ratelimit-unified-status'] || '-'}`);
  },

  export(db, { opts }) {
    const params = { since: sinceMs(opts.since || 'all') };
    let where = 'ts >= :since';
    if (typeof opts.ws === 'string') { where += ' AND workstation = :ws'; params.ws = opts.ws; }
    const rows = db.prepare(`SELECT * FROM usage WHERE ${where} ORDER BY id`).all(params);
    const cols = ['id', 'ts', 'workstation', 'session_id', 'method', 'path', 'model', 'status', 'outcome',
      'input_tokens', 'output_tokens', 'cache_write_tokens', 'cache_read_tokens', 'web_search_requests',
      'duration_ms', 'request_id', 'error_type', 'util_5h', 'util_7d'];
    const esc = (v) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    process.stdout.write(['iso_time', ...cols].join(',') + '\n');
    for (const r of rows) {
      process.stdout.write([new Date(r.ts).toISOString(), ...cols.map((c) => esc(r[c]))].join(',') + '\n');
    }
  },
};

// ---------- main ----------

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { console.log(HELP); process.exit(0); }
if (!commands[cmd]) { console.error(`unknown command "${cmd}"\n`); console.log(HELP); process.exit(1); }

// Quietly stop when output is piped into something like `head`.
process.stdout.on('error', (err) => { if (err.code === 'EPIPE') process.exit(0); throw err; });

const db = open();
try { commands[cmd](db, parseArgs(rest)); } finally { db.close(); }
