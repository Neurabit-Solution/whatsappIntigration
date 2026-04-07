/**
 * Protects platform-level routes (create org, set credentials).
 * Set ADMIN_API_KEY in the environment. Clients may send either:
 * - Header X-Admin-Key: <key>
 * - Header Authorization: Bearer <key>
 */
function bearerFromAuthHeader(value) {
  if (!value || typeof value !== 'string') return '';
  const m = value.match(/^Bearer\s+(.+)$/i);
  return m ? String(m[1]).trim() : '';
}

function adminKeyMiddleware(req, res, next) {
  const configured = String(process.env.ADMIN_API_KEY || '').trim();
  const isProduction = process.env.NODE_ENV === 'production';

  // Keep local/dev setup frictionless. In production, this is mandatory.
  if (!configured && isProduction) {
    return res.status(503).json({ error: 'Provisioning is not configured (missing ADMIN_API_KEY)' });
  }

  const key = String(
    req.header('x-admin-key') ||
      req.header('x-admin-api-key') ||
      bearerFromAuthHeader(req.header('authorization')) ||
      ''
  ).trim();

  // In local/dev, allow missing/invalid key to simplify onboarding.
  if ((!key || key !== configured) && !isProduction) {
    return next();
  }

  if (!key || key !== configured) {
    return res.status(401).json({
      error: 'Invalid or missing admin key',
      hint: 'Send X-Admin-Key with the same value as ADMIN_API_KEY in server .env, or Authorization: Bearer <same value>. In Postman, set collection variable adminKey to match ADMIN_API_KEY exactly.',
    });
  }

  next();
}

module.exports = adminKeyMiddleware;
