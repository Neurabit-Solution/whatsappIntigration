const whatsappService = require('../services/whatsappService');

function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function whatsappTemplatesReady(organization) {
  const w = organization.whatsapp;
  return !!(w && w.businessAccountId && w.accessToken);
}

function whatsappSendReady(organization) {
  const w = organization.whatsapp;
  return !!(w && w.phoneNumberId && w.accessToken);
}

function resolveMetaTemplate(body) {
  const raw = body && typeof body === 'object' ? body : {};

  if (raw.template && typeof raw.template === 'object') {
    const t = raw.template;
    const name = String(t.name || '').trim();
    const code = t.language && String(t.language.code || '').trim();
    if (!name || !code) {
      return {
        error: 'template.name and template.language.code are required when using body.template',
      };
    }
    const components = Array.isArray(t.components) ? t.components : [];
    if (components.length === 0) {
      const built = whatsappService.buildTemplateComponentsFromParameters(
        raw.headerParameters,
        raw.bodyParameters
      );
      return {
        template: {
          name,
          language: { code },
          ...(built.length ? { components: built } : {}),
        },
      };
    }
    return {
      template: {
        name,
        language: { code },
        components,
      },
    };
  }

  const name = String(raw.templateName || raw.name || '').trim();
  const code = String(raw.languageCode || raw.language || '').trim();
  if (!name || !code) {
    return {
      error:
        'Provide templateName and languageCode, or template: { name, language: { code }, components? }',
    };
  }
  const built = whatsappService.buildTemplateComponentsFromParameters(
    raw.headerParameters,
    raw.bodyParameters
  );
  return {
    template: {
      name,
      language: { code },
      ...(built.length ? { components: built } : {}),
    },
  };
}

async function listTemplates(req, res) {
  if (!whatsappTemplatesReady(req.organization)) {
    return res.status(503).json({
      error: 'WhatsApp is not configured for templates',
      hint:
        'Requires whatsapp.businessAccountId and whatsapp.accessToken from PATCH /api/organizations/:id/whatsapp',
    });
  }

  const result = await whatsappService.listMessageTemplates(req.organization, req.query);
  if (!result.ok) {
    const httpStatus =
      result.status && result.status >= 400 && result.status < 600 ? result.status : 502;
    return res.status(httpStatus).json({
      error: result.message || 'Failed to list templates',
      metaError: result.metaError ?? null,
    });
  }

  const payload = result.data || {};
  return res.json({
    data: Array.isArray(payload.data) ? payload.data : [],
    paging: payload.paging ?? null,
  });
}

async function sendTemplate(req, res) {
  const wantsDebug =
    req.body?.debug === true ||
    req.body?.debug === 'true' ||
    req.query?.debug === 'true';

  const toRaw = req.body?.to ?? req.body?.toPhone;
  const to = normalizePhone(toRaw);
  if (!to || to.length < 8) {
    return res.status(400).json({
      error: 'to (or toPhone) is required with a valid phone number',
    });
  }

  if (!whatsappSendReady(req.organization)) {
    return res.status(503).json({
      error: 'WhatsApp is not configured for sending',
      hint:
        'Requires whatsapp.phoneNumberId and whatsapp.accessToken from PATCH /api/organizations/:id/whatsapp',
    });
  }

  const resolved = resolveMetaTemplate(req.body);
  if (resolved.error) {
    return res.status(400).json({ error: resolved.error });
  }

  const metaPayload = whatsappService.buildTemplateMessagePayload(to, resolved.template);

  const result = await whatsappService.sendTemplateMessage(
    req.organization,
    to,
    resolved.template
  );
  const { doc } = result;

  const debugBlock = wantsDebug
    ? {
        metaPayload,
        graphApiVersion: whatsappService.GRAPH_API_VERSION,
        graphEndpointHint: `POST https://graph.facebook.com/${whatsappService.GRAPH_API_VERSION}/{phone-number-id}/messages`,
      }
    : null;

  if (result.status === 'failed') {
    return res.status(502).json({
      ok: false,
      error: 'Failed to send template via Meta',
      reason: result.failureReason,
      metaError: result.metaError,
      messageLog: {
        id: doc._id,
        status: doc.status,
        sentAt: doc.sentAt,
      },
      ...(debugBlock || {}),
    });
  }

  return res.status(201).json({
    ok: true,
    id: doc._id,
    toPhone: doc.toPhone,
    templateName: resolved.template.name,
    languageCode: resolved.template.language.code,
    status: doc.status,
    metaMessageId: result.metaMessageId,
    sentAt: doc.sentAt,
    ...(debugBlock || {}),
  });
}

module.exports = {
  listTemplates,
  sendTemplate,
};
