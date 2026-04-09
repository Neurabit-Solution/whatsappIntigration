const express = require('express');
const messagesController = require('../controllers/messagesController');

const router = express.Router();

router.post('/send', messagesController.send);
router.post('/bulk-send', messagesController.bulkSend);
router.get('/', messagesController.list);

module.exports = router;
