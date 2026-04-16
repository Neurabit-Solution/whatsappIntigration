const express = require('express');
const webhookLogsController = require('../controllers/webhookLogsController');

const router = express.Router();

router.get('/', webhookLogsController.listWebhookLogs);
router.delete('/', webhookLogsController.clearWebhookLogs);
router.get('/firebase-sync', webhookLogsController.listFirebaseLogs);
router.delete('/firebase-sync', webhookLogsController.clearFirebaseLogs);

module.exports = router;
