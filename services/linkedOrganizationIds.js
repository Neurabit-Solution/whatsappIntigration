const Organization = require('../models/Organization');

function parseOrgIdListEnv(value) {
  return String(value || '')
    .split(/[,;\s]+/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isTruthyEnv(value) {
  const v = String(value || '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function credentialOrConditions(organization) {
  const token = String(organization?.whatsapp?.accessToken || '').trim();
  const ba = String(organization?.whatsapp?.businessAccountId || '').trim();
  const out = [];
  if (token && ba) {
    out.push({
      'whatsapp.accessToken': token,
      'whatsapp.businessAccountId': ba,
    });
  } else if (token) {
    out.push({ 'whatsapp.accessToken': token });
  }
  return out;
}

/**
 * All Mongo organization _id strings tied to the same WhatsApp line as this org (active only):
 * same stored `phoneNumberId`, or same Meta credentials (`accessToken` + optional `businessAccountId`).
 * Lets Firestore routing work when two Mongo orgs reuse the same WhatsApp app credentials.
 */
async function getMongoOrganizationIdsSharingWhatsApp(organization) {
  const ids = new Set();
  if (organization?._id) {
    ids.add(String(organization._id));
  }
  const pid = String(organization?.whatsapp?.phoneNumberId || '').trim();
  const orConditions = [];
  if (pid) {
    orConditions.push({ 'whatsapp.phoneNumberId': pid });
  }
  const cred = credentialOrConditions(organization);
  for (const c of cred) {
    orConditions.push(c);
  }

  if (!orConditions.length) {
    return [...ids];
  }

  const rows = await Organization.find({
    isActive: { $ne: false },
    $or: orConditions,
  })
    .select('_id')
    .lean()
    .limit(50);

  for (const row of rows || []) {
    if (row?._id) {
      ids.add(String(row._id));
    }
  }
  return [...ids];
}

/**
 * Accept webhook payloads for this org even when `metadata.phone_number_id` does not match the
 * org document, if another active org stores that id and shares the same Meta token (same line).
 * `WHATSAPP_WEBHOOK_RELAXED_PHONE_VALIDATION=true` skips the phone_number_id check entirely
 * (signature + apiKey still apply).
 */
async function isIncomingPhoneNumberIdAllowedForWebhook(organization, incomingPhoneNumberId) {
  if (isTruthyEnv(process.env.WHATSAPP_WEBHOOK_RELAXED_PHONE_VALIDATION)) {
    return true;
  }

  const incoming = String(incomingPhoneNumberId || '').trim();
  if (!incoming) {
    return true;
  }

  const expected = String(organization?.whatsapp?.phoneNumberId || '').trim();
  if (incoming === expected) {
    return true;
  }

  const credOr = credentialOrConditions(organization);
  if (!credOr.length) {
    return false;
  }

  const peer = await Organization.findOne({
    isActive: { $ne: false },
    'whatsapp.phoneNumberId': incoming,
    $or: credOr,
  })
    .select('_id')
    .lean();

  return !!peer;
}

/**
 * Org ids to try for Firestore `whatsappCrmInboundRouting/{mongoOrgId}` lookup on webhook.
 */
async function resolveRoutingOrganizationIdsForWebhook(organization) {
  const fromDb = await getMongoOrganizationIdsSharingWhatsApp(organization);
  const fromEnv = parseOrgIdListEnv(
    process.env.FIREBASE_ROUTING_ORGANIZATION_IDS || process.env.WHATSAPP_ROUTING_EXTRA_ORG_IDS || ''
  );
  return [...new Set([...fromDb, ...fromEnv])];
}

module.exports = {
  getMongoOrganizationIdsSharingWhatsApp,
  resolveRoutingOrganizationIdsForWebhook,
  isIncomingPhoneNumberIdAllowedForWebhook,
  parseOrgIdListEnv,
};
