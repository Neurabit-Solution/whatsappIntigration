const mongoose = require('mongoose');

const leadSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    phone: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ['new', 'contacted', 'converted', 'lost'],
      default: 'new',
      index: true,
    },
    firstMessageAt: { type: Date, default: Date.now },
    lastMessageAt: { type: Date, default: Date.now },
    totalMessages: { type: Number, default: 0 },
  },
  { versionKey: false }
);

leadSchema.index({ organizationId: 1, phone: 1 }, { unique: true });

module.exports = mongoose.model('Lead', leadSchema);
