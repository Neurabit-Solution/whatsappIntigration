const axios = require('axios');
const Message = require('../models/Message');

const GRAPH_API_VERSION = 'v19.0';
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

function buildUrl(phoneNumberId) {
  return `${GRAPH_BASE}/${phoneNumberId}/messages`;
}

function messageTemplatesUrl(businessAccountId) {
  return `${GRAPH_BASE}/${encodeURIComponent(String(businessAccountId).trim())}/message_templates`;
}

/**
 * Lists WhatsApp message templates for the WABA (Meta Graph API).
 * @param {object} organization - needs whatsapp.businessAccountId, whatsapp.accessToken
 * @param {Record<string, string|number>} [query] - limit, after, before, name, status, fields (Meta query params)
 * @returns {Promise<{ ok: true, data: object } | { ok: false, status?: number, message: string, metaError?: object }>}
 */
async function listMessageTemplates(organization, query = {}) {
  const w = organization.whatsapp || {};
  const { businessAccountId, accessToken } = w;
  if (!businessAccountId || !accessToken) {
    return {
      ok: false,
      message: 'WhatsApp business account or access token is missing',
    };
  }

  const params = {};
  const passthrough = ['after', 'before', 'name', 'status', 'fields'];
  for (const key of passthrough) {
    const v = query[key];
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      params[key] = v;
    }
  }
  if (query.limit !== undefined && query.limit !== null && String(query.limit).trim() !== '') {
    const n = Number(query.limit);
    if (Number.isFinite(n)) {
      params.limit = Math.min(1000, Math.max(1, Math.floor(n)));
    }
  }

  try {
    const response = await axios.get(messageTemplatesUrl(businessAccountId), {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
      params,
      validateStatus: () => true,
    });

    const data = response.data;
    if (response.status >= 400 || data?.error) {
      return {
        ok: false,
        status: response.status,
        message: data?.error?.message || `Meta API error (${response.status})`,
        metaError: data?.error || null,
      };
    }

    return { ok: true, data };
  } catch (err) {
    return {
      ok: false,
      message: err?.message || 'Network error while listing templates',
    };
  }
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

function stringsToTextParameters(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return [];
  }
  return values.map((v) => ({ type: 'text', text: String(v) }));
}

/**
 * Builds Meta Cloud API `template.components` from simple string arrays (POSITIONAL text variables).
 * @param {string[]} [headerParameters]
 * @param {string[]} [bodyParameters]
 * @returns {object[]}
 */
function buildTemplateComponentsFromParameters(headerParameters, bodyParameters) {
  const components = [];
  const hp = stringsToTextParameters(headerParameters);
  const bp = stringsToTextParameters(bodyParameters);
  if (hp.length) {
    components.push({ type: 'header', parameters: hp });
  }
  if (bp.length) {
    components.push({ type: 'body', parameters: bp });
  }
  return components;
}

/**
 * Builds the exact JSON body for Meta `POST /{phone-number-id}/messages` (template message).
 * @param {string} toDigits - recipient digits only
 * @param {{ name: string, language: { code: string }, components?: object[] }} template
 */
function buildTemplateMessagePayload(toDigits, template) {
  const name = String(template?.name || '').trim();
  const langCode = String(template?.language?.code || '').trim();
  const components = Array.isArray(template?.components) ? template.components : [];

  const templateBody = {
    name,
    language: { code: langCode },
  };
  if (components.length > 0) {
    templateBody.components = components;
  }

  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: String(toDigits).replace(/\D/g, ''),
    type: 'template',
    template: templateBody,
  };
}

/**
 * Sends a WhatsApp template message (Meta Graph POST /{phone-number-id}/messages, type: template).
 * @param {object} organization
 * @param {string} to - E.164 or digits-only recipient
 * @param {{ name: string, language: { code: string }, components?: object[] }} template - Meta `template` object
 * @param {{ jobId?: string }} [options]
 */
async function sendTemplateMessage(organization, to, template, options = {}) {
  const { phoneNumberId, accessToken } = organization.whatsapp;
  const toDigits = String(to).replace(/\D/g, '');
  const payload = buildTemplateMessagePayload(toDigits, template);
  const name = String(template?.name || '').trim();
  const langCode = String(template?.language?.code || '').trim();

  let metaMessageId = null;
  let status = 'sent';
  let failureReason = null;
  let metaError = null;

  const messageSummary = `[template] ${name} (${langCode})`;

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
    failureReason = err?.message || 'Network error while sending template message';
  }

  const doc = await Message.create({
    organizationId: organization._id,
    toPhone: toDigits,
    message: messageSummary,
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
  sendTemplateMessage,
  buildTemplateMessagePayload,
  listMessageTemplates,
  buildTemplateComponentsFromParameters,
  GRAPH_API_VERSION,
};
