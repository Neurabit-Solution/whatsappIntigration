const Organization = require('../models/Organization');

async function apiKeyMiddleware(req, res, next) {
  const apiKey = String(
    req.header('x-api-key') || req.header('x-org-api-key') || ''
  ).trim();
  if (!apiKey) {
    return res.status(401).json({
      error: 'Missing API key header',
      hint: 'Send x-api-key with the organization apiKey returned by POST /api/organizations',
    });
  }

  const organization = await Organization.findOne({ apiKey, isActive: true }).lean();
  if (!organization) {
    return res.status(401).json({
      error: 'Invalid or inactive API key',
      hint: 'Use the exact apiKey returned at organization creation and set Postman variable apiKey/webhookApiKey correctly.',
    });
  }

  req.organization = organization;
  next();
}

module.exports = apiKeyMiddleware;
