const express = require('express');
const webhookLogsController = require('../controllers/webhookLogsController');

const router = express.Router();

router.get('/', webhookLogsController.listWebhookLogs);
router.delete('/', webhookLogsController.clearWebhookLogs);

module.exports = router;
