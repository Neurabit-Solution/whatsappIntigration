const express = require('express');
const organizationsController = require('../controllers/organizationsController');

const router = express.Router();

router.post('/', organizationsController.createOrganization);
router.patch('/:id/whatsapp', organizationsController.updateWhatsAppConfig);

module.exports = router;
