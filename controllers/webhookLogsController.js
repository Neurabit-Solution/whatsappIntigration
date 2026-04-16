const webhookLogBuffer = require('../services/webhookLogBuffer');
const {
  listFirebaseSyncLogs,
  clearFirebaseSyncLogs,
} = require('../services/firebaseSyncLogService');

function hostnameOnly(hostHeader) {
  const h = String(hostHeader || '').trim();
  if (!h) return '';
  if (h.startsWith('[')) {
    const m = h.match(/^\[([^\]]+)\]/);
    return m ? m[1] : h;
  }
  const lastColon = h.lastIndexOf(':');
  if (lastColon > 0 && /^\d{1,5}$/.test(h.slice(lastColon + 1))) {
    return h.slice(0, lastColon);
  }
  return h;
}

function metaReachability(hostHeader, protocol) {
  const host = hostnameOnly(hostHeader).toLowerCase();
  const proto = String(protocol || 'http').toLowerCase();

  const isLocalOrPrivate =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.local') ||
    /^192\.168\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host);

  if (isLocalOrPrivate) {
    return {
      metaServersCanReachThisHost: false,
      summary:
        'This host is only reachable on your machine or LAN. Meta cannot POST webhooks to localhost/private IPs.',
      whatToDo: [
        'Webhook logs are stored in memory on the Node process that receives Meta. If Meta Callback URL is https://YOUR-DOMAIN/webhook/wk_..., you must call GET https://YOUR-DOMAIN/api/webhook-logs — not http://localhost. Those are two different servers.',
        'Put this app behind a public HTTPS URL and set Meta → Webhook → Callback URL to https://<public-host>/webhook/<apiKey>, or use a tunnel (ngrok, etc.) and use that https URL in both Meta and Postman.',
      ],
    };
  }

  const out = {
    metaServersCanReachThisHost: true,
    summary: 'Host looks public; Meta can reach it if Callback URL matches and uses HTTPS.',
  };
  if (proto === 'http') {
    out.httpsRecommended = true;
    out.summary +=
      ' Meta typically requires HTTPS for the callback URL — use https:// in Meta unless your provider documents otherwise.';
  }
  return out;
}

function diagnosticPayload(req) {
  const proto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim() || req.protocol || 'https';
  const host = String(req.get('x-forwarded-host') || req.get('host') || '').trim();
  const base = host ? `${proto}://${host}` : null;
  return {
    hostYouAreCalling: host || null,
    protocol: proto,
    metaCallbackUrlMustStartWith: base,
    callbackUrlPattern: base ? `${base}/webhook/<organizationApiKey>` : null,
    uptimeSeconds: Math.floor(process.uptime()),
    pid: process.pid,
    metaReachability: metaReachability(host, proto),
  };
}

const EMPTY_LOGS_CHECKLIST = [
  'Compare diagnostic.metaCallbackUrlMustStartWith to Meta → App → WhatsApp → Configuration → Webhook → Callback URL (same scheme, host, port).',
  'Callback path must be /webhook/<apiKey>, not only /webhook. apiKey is the organization key (wk_…), same as X-Api-Key.',
  'Under the same Webhook section, open Webhook fields (or Manage) and subscribe to the messages field — verification alone does not enable inbound message POSTs.',
  'If you call this API on localhost but Meta points to https://api.yourcompany.com, logs stay empty here; query the deployed baseUrl instead.',
  'Quick test: run Postman POST Webhook (sample inbound + status) against this same baseUrl. If a log appears, the server works and Meta is not hitting this host or messages is not subscribed.',
  'If WHATSAPP_APP_SECRET is set on the server, Meta signature must match; failed posts may still be logged with outcome invalid_signature.',
];

function listWebhookLogs(req, res) {
  const stats = webhookLogBuffer.stats();
  const allFlag = ['1', 'true', 'yes'].includes(String(req.query.all || '').toLowerCase());
  let limit = Math.min(
    2000,
    Math.max(1, parseInt(String(req.query.limit || '100'), 10) || 100)
  );
  if (allFlag) {
    limit = stats.max;
  }

  const filter = {};
  const oid = String(req.query.organizationId || '').trim();
  const ak = String(req.query.apiKey || '').trim();
  if (oid) filter.organizationId = oid;
  if (ak) filter.apiKey = ak;

  const logs = webhookLogBuffer.getAll(limit, Object.keys(filter).length ? filter : undefined);
  const diagnostic = diagnosticPayload(req);
  const unreachable = diagnostic.metaReachability?.metaServersCanReachThisHost === false;

  const emptyHint =
    logs.length === 0
      ? {
          notice: unreachable
            ? 'Logs are empty because you are querying localhost. Meta posts to the Callback URL in the Meta panel (your public https:// domain). Call GET /api/webhook-logs on that same origin (not localhost), using the server ADMIN_API_KEY. See diagnostic.metaReachability.whatToDo.'
            : 'No webhook events received by this Node process yet (after filters). Compare diagnostic.metaCallbackUrlMustStartWith to the Callback URL in Meta.',
          checklist: unreachable
            ? [...(diagnostic.metaReachability.whatToDo || []), ...EMPTY_LOGS_CHECKLIST]
            : EMPTY_LOGS_CHECKLIST,
        }
      : {};
  return res.json({
    ...stats,
    returned: logs.length,
    limitRequested: limit,
    filter: Object.keys(filter).length ? filter : null,
    logs,
    diagnostic,
    ...emptyHint,
  });
}

function clearWebhookLogs(req, res) {
  webhookLogBuffer.clear();
  return res.json({ ok: true, cleared: true });
}

async function listFirebaseLogs(req, res) {
  const data = await listFirebaseSyncLogs(req.query || {});
  return res.json(data);
}

async function clearFirebaseLogs(req, res) {
  const deletedCount = await clearFirebaseSyncLogs();
  return res.json({ ok: true, cleared: true, deletedCount });
}

module.exports = {
  listWebhookLogs,
  clearWebhookLogs,
  listFirebaseLogs,
  clearFirebaseLogs,
};
