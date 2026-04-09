const express = require('express');
const templatesController = require('../controllers/templatesController');

const router = express.Router();

router.get('/', templatesController.listTemplates);
router.post('/send', templatesController.sendTemplate);

module.exports = router;
