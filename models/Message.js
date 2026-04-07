const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: true,
      index: true,
    },
    toPhone: { type: String, required: true, index: true },
    message: { type: String, required: true },
    status: {
      type: String,
      enum: ['sent', 'delivered', 'read', 'failed'],
      default: 'sent',
      index: true,
    },
    metaMessageId: { type: String, default: null, index: true },
    sentAt: { type: Date, default: Date.now },
    jobId: { type: String, default: null, index: true },
  },
  { versionKey: false }
);

messageSchema.index({ organizationId: 1, toPhone: 1, sentAt: -1 });

module.exports = mongoose.model('Message', messageSchema);
