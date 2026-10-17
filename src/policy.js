'use strict';
// Model blocking with simple case-insensitive glob patterns: `*` matches anything.

function globToRegex(pattern) {
  const escaped = pattern.trim().replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

function parsePatterns(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean);
  return String(value).split(',').map((s) => s.trim()).filter(Boolean);
}

// Returns the first pattern that blocks `model`, or null if allowed.
function blockingPattern(model, patterns) {
  if (!model) return null;
  for (const p of patterns) if (globToRegex(p).test(model)) return p;
  return null;
}

module.exports = { parsePatterns, blockingPattern };
