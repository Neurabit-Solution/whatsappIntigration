const mongoose = require('mongoose');

const firebaseSyncLogSchema = new mongoose.Schema(
  {
    organizationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Organization',
      required: false,
      index: true,
      default: null,
    },
    apiKey: { type: String, default: null, index: true },
    operation: {
      type: String,
      enum: ['status_sync', 'inbound_sync'],
      required: true,
      index: true,
    },
    ok: { type: Boolean, required: true, index: true },
    reason: { type: String, default: null, index: true },
    phone: { type: String, default: null, index: true },
    messageType: { type: String, default: null },
    metaMessageId: { type: String, default: null, index: true },
    status: { type: String, default: null },
    details: { type: mongoose.Schema.Types.Mixed, default: null },
    createdAt: { type: Date, default: Date.now, index: true },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      index: { expires: 0 },
    },
  },
  { versionKey: false }
);

module.exports = mongoose.model('FirebaseSyncLog', firebaseSyncLogSchema);
