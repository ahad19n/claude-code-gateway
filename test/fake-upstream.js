#!/usr/bin/env node
'use strict';
/*
 * Fake Anthropic API for local testing. Never needs the real setup-token.
 *
 *   node test/fake-upstream.js [port=9999] [chunkDelayMs=10]
 *
 * Point the gateway at it with UPSTREAM_BASE_URL=http://127.0.0.1:9999.
 * Model "err" returns a 429; count_tokens returns JSON; everything else streams
 * SSE with usage (incl. cache and web search) and rate-limit headers.
 */
const http = require('http');
const port = Number(process.argv[2]) || 9999;
const delay = Number(process.argv[3]) || 10;

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    console.log('UPSTREAM', req.method, req.url, 'auth=' + req.headers.authorization,
      'beta=' + (req.headers['anthropic-beta'] || '-'));
    const now = Math.floor(Date.now() / 1000);
    const rl = {
      'request-id': 'req_fake',
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.21',
      'anthropic-ratelimit-unified-5h-reset': String(now + 2 * 3600),
      'anthropic-ratelimit-unified-7d-status': 'allowed',
      'anthropic-ratelimit-unified-7d-utilization': '0.25',
      'anthropic-ratelimit-unified-7d-reset': String(now + 3 * 86400),
    };
    if (req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json', ...rl });
      return res.end('{"input_tokens":42}');
    }
    let model = null;
    try { model = JSON.parse(body).model; } catch { /* ignore */ }
    if (model === 'err') {
      res.writeHead(429, { 'content-type': 'application/json', ...rl });
      return res.end('{"type":"error","error":{"type":"rate_limit_error","message":"fake limit"}}');
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', ...rl });
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 1 } } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'héllo' } },
      { type: 'message_delta', usage: { output_tokens: 77, server_tool_use: { web_search_requests: 2 } } },
      { type: 'message_stop' },
    ];
    let i = 0;
    const t = setInterval(() => {
      if (i < events.length) { res.write(`event: ${events[i].type}\ndata: ${JSON.stringify(events[i])}\n\n`); i++; }
      else { clearInterval(t); res.end(); }
    }, delay);
    res.on('close', () => clearInterval(t));
  });
}).listen(port, () => console.log(`fake upstream on :${port}`));
