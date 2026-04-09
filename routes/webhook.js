const express = require('express');
const webhookController = require('../controllers/webhookController');

const router = express.Router();

router.get('/:apiKey', webhookController.verifyWebhook);
router.post('/:apiKey', webhookController.receiveWebhook);

module.exports = router;
