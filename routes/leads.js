const express = require('express');
const leadsController = require('../controllers/leadsController');

const router = express.Router();

router.get('/', leadsController.list);
router.patch('/:id', leadsController.updateStatus);

module.exports = router;
