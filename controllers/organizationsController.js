const crypto = require('crypto');
const mongoose = require('mongoose');
const Organization = require('../models/Organization');

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

  const organization = await Organization.findByIdAndUpdate(
    req.params.id,
    {
      $set: {
        whatsapp: {
          businessAccountId: normalizedBusinessAccountId,
          phoneNumberId: normalizedPhoneNumberId,
          accessToken: String(accessToken).trim(),
          verifyToken: String(verifyToken).trim(),
          number: typeof number === 'string' ? number.trim() : '',
        },
      },
    },
    { new: true, runValidators: true }
  ).lean();

  if (!organization) {
    return res.status(404).json({ error: 'Organization not found' });
  }

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

module.exports = {
  createOrganization,
  updateWhatsAppConfig,
};
