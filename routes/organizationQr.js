const express = require('express');
const organizationsController = require('../controllers/organizationsController');

const router = express.Router();

router.get('/qr', organizationsController.getWhatsAppQrCodeViaApiKey);

module.exports = router;
