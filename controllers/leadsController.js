const Lead = require('../models/Lead');

async function list(req, res) {
  const { status, phone } = req.query;
  const filter = { organizationId: req.organization._id };

  if (status) {
    filter.status = status;
  }
  if (phone) {
    filter.phone = String(phone).replace(/\D/g, '');
  }

  const leads = await Lead.find(filter).sort({ lastMessageAt: -1 }).lean();
  return res.json({ leads });
}

async function updateStatus(req, res) {
  const { status } = req.body || {};
  const allowed = ['new', 'contacted', 'converted', 'lost'];
  if (!status || !allowed.includes(status)) {
    return res.status(400).json({ error: 'valid status is required' });
  }

  const lead = await Lead.findOneAndUpdate(
    { _id: req.params.id, organizationId: req.organization._id },
    { $set: { status } },
    { new: true }
  ).lean();

  if (!lead) {
    return res.status(404).json({ error: 'Lead not found' });
  }

  return res.json({ lead });
}

module.exports = {
  list,
  updateStatus,
};
