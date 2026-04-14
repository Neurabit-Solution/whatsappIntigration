const crypto = require('crypto');
const whatsappService = require('../services/whatsappService');
const Message = require('../models/Message');

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function phoneVariants(value) {
  const digits = normalizePhone(value);
  if (!digits) return [];
  const variants = [digits];
  if (digits.length > 10) {
    variants.push(digits.slice(-10));
  }
  if (digits.length === 10) {
    variants.push(`91${digits}`);
    variants.push(`0${digits}`);
  }
  return unique(variants);
}

function phoneCanonicalKey(value) {
  const digits = normalizePhone(value);
  if (!digits) return '';
  return digits.length > 10 ? digits.slice(-10) : digits;
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

async function listOrderDetailsRecipients(req, res) {
  const templateNameRaw = String(req.query.templateName || 'order_details_info').trim();
  const filter = {
    organizationId: req.organization._id,
    direction: 'outbound',
  };
  if (templateNameRaw && templateNameRaw.toLowerCase() !== 'all') {
    filter.$or = [
      { templateName: templateNameRaw },
      { message: { $regex: `^\\[template\\]\\s*${escapeRegExp(templateNameRaw)}\\b`, $options: 'i' } },
    ];
  }

  const groupedOutbound = await Message.aggregate([
    { $match: filter },
    { $sort: { sentAt: -1 } },
    {
      $group: {
        _id: '$toPhone',
        totalSent: { $sum: 1 },
        latestStatus: { $first: '$status' },
        lastSentAt: { $first: '$sentAt' },
        templateName: { $first: '$templateName' },
        lastMetaMessageId: { $first: '$metaMessageId' },
      },
    },
    { $sort: { lastSentAt: -1 } },
  ]);

  const phones = groupedOutbound.map((item) => item._id).filter(Boolean);
  const phoneVariantSet = new Set();
  for (const phone of phones) {
    for (const variant of phoneVariants(phone)) {
      phoneVariantSet.add(variant);
    }
  }
  const allPhoneVariants = [...phoneVariantSet];
  let inboundByPhone = new Map();
  if (allPhoneVariants.length > 0) {
    const inboundGrouped = await Message.aggregate([
      {
        $match: {
          organizationId: req.organization._id,
          direction: 'inbound',
          toPhone: { $in: allPhoneVariants },
        },
      },
      { $sort: { sentAt: -1 } },
      {
        $group: {
          _id: '$toPhone',
          totalReplies: { $sum: 1 },
          lastReplyAt: { $first: '$sentAt' },
          lastReplyMessage: { $first: '$message' },
          customerName: { $first: '$customerName' },
        },
      },
    ]);
    const normalized = new Map();
    for (const item of inboundGrouped) {
      const key = phoneCanonicalKey(item._id);
      if (!key) continue;
      const existing = normalized.get(key);
      if (!existing) {
        normalized.set(key, item);
        continue;
      }
      normalized.set(key, {
        ...existing,
        totalReplies: (existing.totalReplies || 0) + (item.totalReplies || 0),
        lastReplyAt:
          new Date(item.lastReplyAt || 0) > new Date(existing.lastReplyAt || 0)
            ? item.lastReplyAt
            : existing.lastReplyAt,
        lastReplyMessage:
          new Date(item.lastReplyAt || 0) > new Date(existing.lastReplyAt || 0)
            ? item.lastReplyMessage
            : existing.lastReplyMessage,
        customerName:
          (new Date(item.lastReplyAt || 0) > new Date(existing.lastReplyAt || 0)
            ? item.customerName
            : existing.customerName) || null,
      });
    }
    inboundByPhone = normalized;
  }

  const recipients = groupedOutbound.map((item) => {
    const reply = inboundByPhone.get(phoneCanonicalKey(item._id));
    return {
      phoneNumber: item._id,
      totalSent: item.totalSent,
      latestStatus: item.latestStatus,
      lastSentAt: item.lastSentAt,
      templateName: item.templateName || null,
      lastMetaMessageId: item.lastMetaMessageId || null,
      totalReplies: reply?.totalReplies || 0,
      lastReplyAt: reply?.lastReplyAt || null,
      lastReplyMessage: reply?.lastReplyMessage || null,
      customerName: reply?.customerName || null,
    };
  });

  return res.json({
    organizationId: String(req.organization._id),
    templateName:
      templateNameRaw && templateNameRaw.toLowerCase() !== 'all' ? templateNameRaw : 'all',
    count: recipients.length,
    recipients,
  });
}

async function getConversationByPhone(req, res) {
  const phoneNumber = normalizePhone(req.params.phone || req.query.phone);
  if (!phoneNumber || phoneNumber.length < 8) {
    return res.status(400).json({ error: 'Valid phone number is required in /:phone' });
  }

  const limitRequested = Number(req.query.limit);
  const limit = Number.isFinite(limitRequested)
    ? Math.min(1000, Math.max(1, Math.floor(limitRequested)))
    : 500;

  const phoneMatchVariants = phoneVariants(phoneNumber);
  const messages = await Message.find({
    organizationId: req.organization._id,
    toPhone: { $in: phoneMatchVariants },
  })
    .sort({ sentAt: 1 })
    .limit(limit)
    .lean();

  return res.json({
    organizationId: String(req.organization._id),
    phoneNumber,
    count: messages.length,
    limitRequested: limit,
    messages,
  });
}

module.exports = {
  send,
  bulkSend,
  list,
  listOrderDetailsRecipients,
  getConversationByPhone,
};
