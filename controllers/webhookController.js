const crypto = require('crypto');
const Organization = require('../models/Organization');
const Message = require('../models/Message');
const Lead = require('../models/Lead');
const webhookLogBuffer = require('../services/webhookLogBuffer');

const STATUS_MAP = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
};

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

async function loadOrganizationByApiKey(apiKey) {
  return Organization.findOne({ apiKey, isActive: true });
}

function rawRequestPayload(req) {
  if (req.method === 'POST') {
    if (Buffer.isBuffer(req.rawBody) && req.rawBody.length) {
      return req.rawBody.toString('utf8');
    }
    return JSON.stringify(req.body || {});
  }
  const q = req.query || {};
  return `?${new URLSearchParams(q).toString()}`;
}

function organizationSnapshot(org) {
  if (!org || !org._id) {
    return { organizationId: null, businessName: null, phoneNumberId: null };
  }
  return {
    organizationId: String(org._id),
    businessName: org.businessName ?? null,
    phoneNumberId: org.whatsapp?.phoneNumberId ?? null,
  };
}

function recordWebhook(req, extra) {
  const apiKey = req.params.apiKey != null ? String(req.params.apiKey) : null;
  webhookLogBuffer.push({
    receivedAt: new Date().toISOString(),
    method: req.method,
    path: req.originalUrl || req.url,
    apiKey,
    headers: {
      'content-type': req.header('content-type'),
      'x-hub-signature-256': req.header('x-hub-signature-256'),
    },
    raw: rawRequestPayload(req),
    ...extra,
  });
}

function isMetaSignatureValid(req) {
  const appSecret = String(process.env.WHATSAPP_APP_SECRET || '').trim();
  if (!appSecret) return true;

  const headerSignature = String(req.header('x-hub-signature-256') || '').trim();
  if (!headerSignature) return false;

  const raw = Buffer.isBuffer(req.rawBody)
    ? req.rawBody
    : Buffer.from(JSON.stringify(req.body || {}), 'utf8');

  const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(raw).digest('hex')}`;
  if (expected.length !== headerSignature.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(headerSignature));
}

async function verifyWebhook(req, res) {
  let organization = null;
  try {
    organization = await loadOrganizationByApiKey(req.params.apiKey);
    if (!organization) {
      recordWebhook(req, {
        kind: 'webhook_get',
        outcome: 'unknown_org',
        httpStatus: 403,
        ...organizationSnapshot(null),
      });
      return res.sendStatus(403);
    }

    const verifyToken = String(organization.whatsapp?.verifyToken || '').trim();
    if (!verifyToken) {
      recordWebhook(req, {
        kind: 'webhook_get',
        outcome: 'missing_verify_token',
        httpStatus: 403,
        ...organizationSnapshot(organization),
      });
      return res.sendStatus(403);
    }

    const mode = req.query['hub.mode'];
    const token = String(req.query['hub.verify_token'] || '').trim();
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === verifyToken && challenge !== undefined) {
      recordWebhook(req, {
        kind: 'webhook_get',
        outcome: 'verified',
        httpStatus: 200,
        hubChallengeLength: String(challenge).length,
        ...organizationSnapshot(organization),
      });
      return res.status(200).type('text/plain').send(String(challenge));
    }

    recordWebhook(req, {
      kind: 'webhook_get',
      outcome: 'verify_failed',
      httpStatus: 403,
      ...organizationSnapshot(organization),
    });
    return res.sendStatus(403);
  } catch (err) {
    console.error('Webhook GET verification error:', err);
    recordWebhook(req, {
      kind: 'webhook_get',
      outcome: 'error',
      httpStatus: 500,
      error: String(err.message || err),
      ...organizationSnapshot(organization),
    });
    return res.sendStatus(500);
  }
}

async function receiveWebhook(req, res) {
  let outcome = 'unknown';
  let httpStatus = 500;
  let error;
  let organization = null;

  try {
    organization = await loadOrganizationByApiKey(req.params.apiKey);
    if (!organization) {
      outcome = 'unknown_org';
      httpStatus = 403;
      return res.sendStatus(403);
    }

    if (!isMetaSignatureValid(req)) {
      outcome = 'invalid_signature';
      httpStatus = 403;
      return res.sendStatus(403);
    }

    const body = req.body || {};
    const entries = Array.isArray(body.entry) ? body.entry : [];

    for (const entry of entries) {
      const changes = Array.isArray(entry.changes) ? entry.changes : [];
      for (const change of changes) {
        const value = change.value || {};
        const metadata = value.metadata || {};
        const phoneNumberId = metadata.phone_number_id;
        const expectedPid = organization.whatsapp?.phoneNumberId;

        if (!expectedPid) {
          continue;
        }
        if (phoneNumberId && phoneNumberId !== expectedPid) {
          continue;
        }

        const statuses = Array.isArray(value.statuses) ? value.statuses : [];
        for (const st of statuses) {
          const metaId = st.id;
          const raw = String(st.status || '').toLowerCase();
          const mapped = STATUS_MAP[raw];
          if (!metaId || !mapped) continue;

          await Message.findOneAndUpdate(
            { organizationId: organization._id, metaMessageId: metaId },
            { status: mapped }
          );
        }

        const messages = Array.isArray(value.messages) ? value.messages : [];
        for (const msg of messages) {
          const from = normalizePhone(msg.from);
          if (!from) continue;

          const now = new Date();
          await Lead.findOneAndUpdate(
            { organizationId: organization._id, phone: from },
            {
              $set: { lastMessageAt: now },
              $setOnInsert: {
                firstMessageAt: now,
                status: 'new',
              },
              $inc: { totalMessages: 1 },
            },
            { upsert: true, new: true }
          );
        }
      }
    }

    outcome = 'ok';
    httpStatus = 200;
    return res.sendStatus(200);
  } catch (err) {
    console.error('Webhook POST error:', err);
    outcome = 'error';
    httpStatus = 500;
    error = String(err.message || err);
    return res.sendStatus(500);
  } finally {
    recordWebhook(req, {
      kind: 'webhook_post',
      outcome,
      httpStatus,
      ...(error ? { error } : {}),
      ...organizationSnapshot(organization),
    });
  }
}

module.exports = {
  verifyWebhook,
  receiveWebhook,
};
