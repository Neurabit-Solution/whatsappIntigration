const crypto = require('crypto');
const mongoose = require('mongoose');
const Organization = require('../models/Organization');
const { createMessageQrCode } = require('../services/whatsappService');

function generateApiKey() {
  return `wk_${crypto.randomBytes(24).toString('hex')}`;
}

async function createOrganization(req, res) {
  const { businessName, businessType } = req.body || {};
  if (!businessName || typeof businessName !== 'string' || !businessName.trim()) {
    return res.status(400).json({ error: 'businessName is required' });
  }

  const organization = await Organization.create({
    businessName: businessName.trim(),
    businessType: typeof businessType === 'string' ? businessType.trim() : '',
    apiKey: generateApiKey(),
  });

  return res.status(201).json({
    id: organization._id,
    businessName: organization.businessName,
    businessType: organization.businessType,
    apiKey: organization.apiKey,
    message: 'Store apiKey securely; use it as X-Api-Key for this organization.',
    createdAt: organization.createdAt,
  });
}

async function updateWhatsAppConfig(req, res) {
  if (!mongoose.isValidObjectId(req.params.id)) {
    return res.status(400).json({
      error: 'Invalid organizationId. Use the id returned by POST /api/organizations.',
    });
  }

  const { businessAccountId, phoneNumberId, accessToken, verifyToken, number } = req.body || {};
  if (!businessAccountId || !phoneNumberId || !accessToken || !verifyToken) {
    return res.status(400).json({
      error: 'businessAccountId, phoneNumberId, accessToken, and verifyToken are required',
    });
  }

  const normalizedBusinessAccountId = String(businessAccountId).trim();
  const normalizedPhoneNumberId = String(phoneNumberId).trim();
  const currentOrganization = await Organization.findById(req.params.id)
    .select({ _id: 1, whatsapp: 1 })
    .lean();
  if (!currentOrganization) {
    return res.status(404).json({ error: 'Organization not found' });
  }

  const duplicateOrg = await Organization.findOne({
    _id: { $ne: req.params.id },
    isActive: true,
    'whatsapp.businessAccountId': normalizedBusinessAccountId,
    'whatsapp.phoneNumberId': normalizedPhoneNumberId,
  })
    .select({ _id: 1, businessName: 1 })
    .lean();
  if (duplicateOrg) {
    return res.status(409).json({
      error:
        'This WhatsApp businessAccountId + phoneNumberId is already linked to another active organization',
      existingOrganizationId: duplicateOrg._id,
      existingBusinessName: duplicateOrg.businessName,
      hint: 'Use the same organization API key for messaging/webhook, or disable the old org first.',
    });
  }

  const update = {
    $set: {
      'whatsapp.businessAccountId': normalizedBusinessAccountId,
      'whatsapp.phoneNumberId': normalizedPhoneNumberId,
      'whatsapp.accessToken': String(accessToken).trim(),
      'whatsapp.verifyToken': String(verifyToken).trim(),
      'whatsapp.number': typeof number === 'string' ? number.trim() : '',
    },
  };
  if (
    String(currentOrganization?.whatsapp?.phoneNumberId || '').trim() &&
    String(currentOrganization?.whatsapp?.phoneNumberId || '').trim() !== normalizedPhoneNumberId
  ) {
    update.$unset = { 'whatsapp.qr': 1 };
  }

  const organization = await Organization.findByIdAndUpdate(
    req.params.id,
    update,
    { new: true, runValidators: true }
  ).lean();

  return res.json({
    id: organization._id,
    businessName: organization.businessName,
    whatsapp: {
      businessAccountId: organization.whatsapp.businessAccountId,
      phoneNumberId: organization.whatsapp.phoneNumberId,
      number: organization.whatsapp.number,
    },
  });
}

function isTruthy(value) {
  const v = String(value || '')
    .trim()
    .toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

function resolveOrganizationId(req) {
  return String(
    req.params.id ||
      req.header('x-organization-id') ||
      req.header('x-org-id') ||
      req.header('organization-id') ||
      req.query.organizationId ||
      ''
  ).trim();
}

function resolveOrganizationIdFromHeaders(req) {
  return String(
    req.header('x-organization-id') ||
      req.header('x-org-id') ||
      req.header('organization-id') ||
      req.query.organizationId ||
      ''
  ).trim();
}

async function getWhatsAppQrCodeByOrganizationDoc(req, res, organization) {
  if (!organization) {
    return res.status(404).json({ error: 'Organization not found' });
  }

  const forceRefresh = isTruthy(req.query.forceRefresh);
  const existingQr = organization?.whatsapp?.qr;
  if (!forceRefresh && existingQr?.code) {
    return res.json({
      organizationId: organization._id,
      businessName: organization.businessName,
      source: 'database',
      qr: existingQr,
    });
  }

  const metaResult = await createMessageQrCode(organization, {
    prefilledMessage: req.query.prefilledMessage,
    imageFormat: req.query.imageFormat,
  });

  if (!metaResult.ok) {
    return res.status(metaResult.status || 502).json({
      error: 'Failed to generate WhatsApp QR from Meta',
      message: metaResult.message,
      metaError: metaResult.metaError || null,
      source: 'meta',
    });
  }

  organization.whatsapp = organization.whatsapp || {};
  organization.whatsapp.qr = {
    ...metaResult.qr,
    generatedAt: new Date(),
    raw: metaResult.data,
  };
  await organization.save();

  return res.json({
    organizationId: organization._id,
    businessName: organization.businessName,
    source: 'meta',
    qr: organization.whatsapp.qr,
  });
}

async function getWhatsAppQrCode(req, res) {
  const organizationId = resolveOrganizationId(req);
  if (!mongoose.isValidObjectId(organizationId)) {
    return res.status(400).json({
      error:
        'Invalid organizationId. Pass valid Mongo id in URL /api/organizations/:id/whatsapp/qr or header x-organization-id.',
    });
  }

  const organization = await Organization.findById(organizationId);
  return getWhatsAppQrCodeByOrganizationDoc(req, res, organization);
}

async function getWhatsAppQrCodeViaApiKey(req, res) {
  const headerOrganizationId = resolveOrganizationIdFromHeaders(req);
  const apiKeyOrganizationId = String(req.organization?._id || '').trim();
  const organizationId = headerOrganizationId || apiKeyOrganizationId;

  if (headerOrganizationId && !mongoose.isValidObjectId(headerOrganizationId)) {
    return res.status(400).json({
      error:
        'Invalid organizationId. Pass valid Mongo id in header x-organization-id (or x-org-id).',
    });
  }
  if (
    headerOrganizationId &&
    req.organization?._id &&
    String(req.organization._id) !== String(headerOrganizationId)
  ) {
    return res.status(403).json({
      error: 'organizationId does not match API key organization',
      hint: 'Use the same organization id and x-api-key pair.',
    });
  }

  const organization = await Organization.findById(organizationId);
  return getWhatsAppQrCodeByOrganizationDoc(req, res, organization);
}

module.exports = {
  createOrganization,
  updateWhatsAppConfig,
  getWhatsAppQrCode,
  getWhatsAppQrCodeViaApiKey,
};
