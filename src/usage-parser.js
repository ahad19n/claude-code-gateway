'use strict';
// Extracts token usage from Anthropic streaming (SSE) and JSON responses.

const { StringDecoder } = require('string_decoder');

function makeSseUsageParser() {
  const decoder = new StringDecoder('utf8');
  let buf = '';
  const state = { usage: {}, errorType: null, sawStop: false };
  return {
    state,
    push(chunk) {
      buf += decoder.write(chunk);
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data.startsWith('{')) continue;
        let evt;
        try { evt = JSON.parse(data); } catch { continue; }
        if (evt.type === 'message_start' && evt.message && evt.message.usage) {
          mergeUsage(state.usage, evt.message.usage);
        } else if (evt.type === 'message_delta' && evt.usage) {
          mergeUsage(state.usage, evt.usage);
        } else if (evt.type === 'message_stop') {
          state.sawStop = true;
        } else if (evt.type === 'error') {
          state.errorType = (evt.error && evt.error.type) || 'unknown';
        }
      }
    },
  };
}

// message_delta carries cumulative counts, so later values overwrite earlier ones.
function mergeUsage(target, u) {
  for (const [k, v] of Object.entries(u)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') target[k] = { ...(target[k] || {}), ...v };
    else target[k] = v;
  }
}

function normalizeUsage(u) {
  if (!u) return {};
  const server = u.server_tool_use || {};
  return {
    input_tokens: u.input_tokens ?? null,
    output_tokens: u.output_tokens ?? null,
    cache_write_tokens: u.cache_creation_input_tokens ?? null,
    cache_read_tokens: u.cache_read_input_tokens ?? null,
    web_search_requests: server.web_search_requests ?? null,
  };
}

module.exports = { makeSseUsageParser, normalizeUsage };
