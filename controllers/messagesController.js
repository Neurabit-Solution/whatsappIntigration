const crypto = require('crypto');
const whatsappService = require('../services/whatsappService');
const Message = require('../models/Message');

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function whatsappConfigured(organization) {
  const w = organization.whatsapp;
  return !!(w && w.phoneNumberId && w.accessToken);
}

function parseSingleMessageBody(body) {
  const toRaw = body?.to ?? body?.toPhone;
  const textRaw = body?.text ?? body?.message;
  const to = normalizePhone(toRaw);
  const text = String(textRaw || '').trim();
  return { to, text };
}

async function send(req, res) {
  const { to, text } = parseSingleMessageBody(req.body);
  if (!to || !text) {
    return res.status(400).json({
      error: 'to and text are required',
      acceptedFields: {
        to: ['to', 'toPhone'],
        text: ['text', 'message'],
      },
    });
  }

  if (to.length < 8) {
    return res.status(400).json({ error: 'Invalid phone number in "to"' });
  }

  if (!whatsappConfigured(req.organization)) {
    return res.status(503).json({ error: 'WhatsApp is not configured for this organization' });
  }

  const result = await whatsappService.sendMessage(req.organization, to, text);
  const { doc } = result;

  if (result.status === 'failed') {
    return res.status(502).json({
      ok: false,
      error: 'Failed to send message via Meta',
      reason: result.failureReason,
      metaError: result.metaError,
      messageLog: {
        id: doc._id,
        status: doc.status,
        sentAt: doc.sentAt,
      },
    });
  }

  return res.status(201).json({
    ok: true,
    id: doc._id,
    toPhone: doc.toPhone,
    message: doc.message,
    status: doc.status,
    metaMessageId: doc.metaMessageId,
    sentAt: doc.sentAt,
  });
}

async function bulkSend(req, res) {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages must be a non-empty array' });
  }

  const jobId = crypto.randomUUID();
  const results = [];

  if (!whatsappConfigured(req.organization)) {
    return res.status(503).json({ error: 'WhatsApp is not configured for this organization' });
  }

  for (const item of messages) {
    const { to, text } = parseSingleMessageBody(item);
    if (!to || !text) {
      results.push({ ok: false, error: 'missing to or message' });
      continue;
    }
    if (to.length < 8) {
      results.push({ ok: false, error: 'invalid to phone number' });
      continue;
    }

    const result = await whatsappService.sendMessage(req.organization, to, text, { jobId });
    const { doc } = result;
    results.push({
      ok: doc.status !== 'failed',
      id: doc._id,
      toPhone: doc.toPhone,
      status: doc.status,
      metaMessageId: doc.metaMessageId,
      reason: result.failureReason,
    });
  }

  return res.status(202).json({ jobId, results });
}

async function list(req, res) {
  const { phone } = req.query;
  const filter = { organizationId: req.organization._id };
  if (phone) {
    filter.toPhone = String(phone).replace(/\D/g, '');
  }

  const items = await Message.find(filter).sort({ sentAt: -1 }).limit(200).lean();
  return res.json({ messages: items });
}

module.exports = {
  send,
  bulkSend,
  list,
};
