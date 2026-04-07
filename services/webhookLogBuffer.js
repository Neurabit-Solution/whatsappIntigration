/**
 * In-memory ring buffer of recent webhook traffic for debugging without cloud log access.
 * Bounded by WEBHOOK_LOG_MAX (default 500).
 */

const MAX = Math.min(
  20000,
  Math.max(10, parseInt(String(process.env.WEBHOOK_LOG_MAX || '500'), 10) || 500)
);

let seq = 0;
const entries = [];

function push(entry) {
  seq += 1;
  entries.push({ id: seq, ...entry });
  while (entries.length > MAX) {
    entries.shift();
  }
}

function entryMatchesFilter(entry, filter) {
  if (!filter || typeof filter !== 'object') return true;
  const { organizationId, apiKey } = filter;
  if (organizationId !== undefined && organizationId !== null && String(organizationId).trim() !== '') {
    if (String(entry.organizationId || '') !== String(organizationId).trim()) return false;
  }
  if (apiKey !== undefined && apiKey !== null && String(apiKey).trim() !== '') {
    if (String(entry.apiKey || '') !== String(apiKey).trim()) return false;
  }
  return true;
}

/** Newest first, up to `limit` matching items (scan full buffer when filtering). */
function getAll(limit = 100, filter) {
  const cap = Math.min(MAX, Math.max(1, limit));
  const out = [];
  for (let i = entries.length - 1; i >= 0 && out.length < cap; i -= 1) {
    if (entryMatchesFilter(entries[i], filter)) {
      out.push(entries[i]);
    }
  }
  return out;
}

function clear() {
  entries.length = 0;
}

function stats() {
  return { count: entries.length, max: MAX };
}

module.exports = { push, getAll, clear, stats };
