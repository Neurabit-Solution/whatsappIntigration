require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');

const apiKeyMiddleware = require('./middlewares/apiKey');
const adminKeyMiddleware = require('./middlewares/adminKey');
const webhookRoutes = require('./routes/webhook');
const organizationsRoutes = require('./routes/organizations');
const organizationQrRoutes = require('./routes/organizationQr');
const messagesRoutes = require('./routes/messages');
const leadsRoutes = require('./routes/leads');
const statsRoutes = require('./routes/stats');
const templatesRoutes = require('./routes/templates');
const webhookLogsRoutes = require('./routes/webhookLogs');
const webhookLogBuffer = require('./services/webhookLogBuffer');

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI in environment');
  process.exit(1);
}

const app = express();

// Behind nginx / ALB, trust X-Forwarded-* so req.protocol and webhook-logs diagnostic match https://
app.set('trust proxy', 1);

app.use(helmet());
app.use(cors());
app.use(
  express.json({
    limit: '5mb',
    verify: (req, _res, buf) => {
      // Keep raw JSON for optional Meta webhook signature validation.
      req.rawBody = buf;
    },
  })
);

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

function webhookRawPayload(req) {
  if (Buffer.isBuffer(req.rawBody) && req.rawBody.length) {
    return req.rawBody.toString('utf8');
  }
  return JSON.stringify(req.body || {});
}

// Meta must call POST /webhook/<organizationApiKey>. POST /webhook alone hits this — log so it shows up in /api/webhook-logs.
app.post('/webhook', (req, res) => {
  webhookLogBuffer.push({
    kind: 'webhook_post',
    receivedAt: new Date().toISOString(),
    method: 'POST',
    path: req.originalUrl || req.url,
    organizationId: null,
    businessName: null,
    phoneNumberId: null,
    apiKey: null,
    outcome: 'missing_api_key_in_url',
    httpStatus: 404,
    hint: 'Set Callback URL to https://<host>/webhook/<apiKey> where apiKey is the org key from POST /api/organizations (same as X-Api-Key).',
    headers: {
      'content-type': req.header('content-type'),
      'x-hub-signature-256': req.header('x-hub-signature-256'),
    },
    raw: webhookRawPayload(req),
  });
  return res.status(404).json({
    error: 'Missing webhook path segment',
    hint: 'Use POST /webhook/<organizationApiKey>. Example: /webhook/wk_abc123...',
  });
});

app.use('/webhook', webhookRoutes);
app.use('/api/organizations/whatsapp', apiKeyMiddleware, organizationQrRoutes);
app.use('/api/organizations', adminKeyMiddleware, organizationsRoutes);
app.use('/api/webhook-logs', adminKeyMiddleware, webhookLogsRoutes);
app.use('/api/messages', apiKeyMiddleware, messagesRoutes);
app.use('/api/leads', apiKeyMiddleware, leadsRoutes);
app.use('/api/stats', apiKeyMiddleware, statsRoutes);
app.use('/api/templates', apiKeyMiddleware, templatesRoutes);

app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

async function start() {
  await mongoose.connect(MONGODB_URI);
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

start().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
