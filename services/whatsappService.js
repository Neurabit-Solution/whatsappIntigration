const axios = require('axios');
const Message = require('../models/Message');

const GRAPH_API_VERSION = 'v19.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

function buildUrl(phoneNumberId) {
  return `${GRAPH_BASE}/${phoneNumberId}/messages`;
}

/**
 * @param {object} organization - Organization document (needs whatsapp.phoneNumberId, whatsapp.accessToken)
 * @param {string} to - E.164 or digits-only recipient
 * @param {string} text - Message body
 * @param {{ jobId?: string }} [options]
 */
async function sendMessage(organization, to, text, options = {}) {
  const { phoneNumberId, accessToken } = organization.whatsapp;
  const toDigits = String(to).replace(/\D/g, '');
  const bodyText = String(text || '').trim();

  const payload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: toDigits,
    type: 'text',
    text: { preview_url: false, body: bodyText },
  };

  let metaMessageId = null;
  let status = 'sent';
  let failureReason = null;
  let metaError = null;

  try {
    const response = await axios.post(buildUrl(phoneNumberId), payload, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      validateStatus: () => true,
    });

    const data = response.data;
    if (response.status >= 400 || data?.error) {
      status = 'failed';
      failureReason = data?.error?.message || `Meta API error (${response.status})`;
      metaError = data?.error || null;
    } else if (data?.messages?.[0]?.id) {
      metaMessageId = data.messages[0].id;
    }
  } catch (err) {
    status = 'failed';
    failureReason = err?.message || 'Network error while sending message';
  }

  const doc = await Message.create({
    organizationId: organization._id,
    toPhone: toDigits,
    message: bodyText,
    status,
    metaMessageId,
    sentAt: new Date(),
    jobId: options.jobId ?? null,
  });

  return {
    doc,
    status,
    metaMessageId,
    failureReason,
    metaError,
  };
}

module.exports = {
  sendMessage,
  GRAPH_API_VERSION,
};
