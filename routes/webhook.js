const express = require('express');
const crypto = require('crypto');
const Organization = require('../models/Organization');
const Message = require('../models/Message');
const Lead = require('../models/Lead');

const router = express.Router();

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

router.get('/:apiKey', async (req, res) => {
  try {
    const organization = await loadOrganizationByApiKey(req.params.apiKey);
    if (!organization) {
      return res.sendStatus(403);
    }

    const verifyToken = String(organization.whatsapp?.verifyToken || '').trim();
    if (!verifyToken) {
      return res.sendStatus(403);
    }

    const mode = req.query['hub.mode'];
    const token = String(req.query['hub.verify_token'] || '').trim();
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === verifyToken && challenge !== undefined) {
      return res.status(200).type('text/plain').send(String(challenge));
    }

    return res.sendStatus(403);
  } catch (err) {
    console.error('Webhook GET verification error:', err);
    return res.sendStatus(500);
  }
});

router.post('/:apiKey', async (req, res) => {
  const organization = await loadOrganizationByApiKey(req.params.apiKey);
  if (!organization) {
    return res.sendStatus(403);
  }

  try {
    if (!isMetaSignatureValid(req)) {
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

    return res.sendStatus(200);
  } catch (err) {
    console.error('Webhook POST error:', err);
    return res.sendStatus(500);
  }
});

module.exports = router;
