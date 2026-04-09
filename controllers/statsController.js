const Message = require('../models/Message');
const Lead = require('../models/Lead');

async function getStats(req, res) {
  const organizationId = req.organization._id;

  const [messageAgg, totalLeads] = await Promise.all([
    Message.aggregate([
      { $match: { organizationId } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Lead.countDocuments({ organizationId }),
  ]);

  const counts = {
    sent: 0,
    delivered: 0,
    read: 0,
    failed: 0,
  };
  for (const row of messageAgg) {
    if (row._id && Object.prototype.hasOwnProperty.call(counts, row._id)) {
      counts[row._id] = row.count;
    }
  }

  return res.json({
    messages: counts,
    totalLeads,
  });
}

module.exports = {
  getStats,
};
