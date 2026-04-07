require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const mongoose = require('mongoose');

const apiKeyMiddleware = require('./middlewares/apiKey');
const adminKeyMiddleware = require('./middlewares/adminKey');
const webhookRoutes = require('./routes/webhook');
const organizationsRoutes = require('./routes/organizations');
const messagesRoutes = require('./routes/messages');
const leadsRoutes = require('./routes/leads');
const statsRoutes = require('./routes/stats');

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error('Missing MONGODB_URI in environment');
  process.exit(1);
}

const app = express();

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

app.use('/webhook', webhookRoutes);
app.use('/api/organizations', adminKeyMiddleware, organizationsRoutes);
app.use('/api/messages', apiKeyMiddleware, messagesRoutes);
app.use('/api/leads', apiKeyMiddleware, leadsRoutes);
app.use('/api/stats', apiKeyMiddleware, statsRoutes);

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
