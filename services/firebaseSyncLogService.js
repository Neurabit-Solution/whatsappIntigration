const FirebaseSyncLog = require('../models/FirebaseSyncLog');

function trimOrNull(value) {
  const normalized = String(value ?? '').trim();
  return normalized ? normalized : null;
}

function compactError(err) {
  if (!err) return null;
  return {
    name: trimOrNull(err.name),
    message: trimOrNull(err.message) || String(err),
    code: trimOrNull(err.code),
    stack: trimOrNull(err.stack),
  };
}

async function recordFirebaseSyncLog(entry) {
  try {
    await FirebaseSyncLog.create({
      organizationId: entry.organizationId ?? null,
      apiKey: trimOrNull(entry.apiKey),
      operation: trimOrNull(entry.operation),
      ok: Boolean(entry.ok),
      reason: trimOrNull(entry.reason),
      phone: trimOrNull(entry.phone),
      messageType: trimOrNull(entry.messageType),
      metaMessageId: trimOrNull(entry.metaMessageId),
      status: trimOrNull(entry.status),
      details: entry.details ?? null,
    });
  } catch (err) {
    console.warn('Failed to record Firebase sync log:', err.message || err);
  }
}

function normalizeLimit(value, fallback = 100, max = 1000) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, Math.trunc(n)));
}

async function listFirebaseSyncLogs(query = {}) {
  const filter = {};
  const operation = trimOrNull(query.operation);
  const okRaw = trimOrNull(query.ok);
  const organizationId = trimOrNull(query.organizationId);
  const apiKey = trimOrNull(query.apiKey);
  const phone = trimOrNull(query.phone);
  const metaMessageId = trimOrNull(query.metaMessageId);

  if (operation) filter.operation = operation;
  if (okRaw === 'true' || okRaw === '1' || okRaw === 'yes') filter.ok = true;
  if (okRaw === 'false' || okRaw === '0' || okRaw === 'no') filter.ok = false;
  if (organizationId) filter.organizationId = organizationId;
  if (apiKey) filter.apiKey = apiKey;
  if (phone) filter.phone = phone.replace(/\D/g, '');
  if (metaMessageId) filter.metaMessageId = metaMessageId;

  const limit = normalizeLimit(query.limit, 100, 2000);
  const logs = await FirebaseSyncLog.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
  return {
    limitRequested: limit,
    returned: logs.length,
    filter: Object.keys(filter).length ? filter : null,
    logs,
  };
}

async function clearFirebaseSyncLogs() {
  const result = await FirebaseSyncLog.deleteMany({});
  return result?.deletedCount || 0;
}

module.exports = {
  recordFirebaseSyncLog,
  listFirebaseSyncLogs,
  clearFirebaseSyncLogs,
  compactError,
};
