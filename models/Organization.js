const mongoose = require('mongoose');

const organizationSchema = new mongoose.Schema(
  {
    businessName: { type: String, required: true, trim: true },
    businessType: { type: String, trim: true, default: '' },
    apiKey: { type: String, required: true, unique: true, index: true },
    whatsapp: {
      businessAccountId: { type: String, trim: true },
      phoneNumberId: { type: String, trim: true },
      accessToken: { type: String },
      verifyToken: { type: String, trim: true },
      number: { type: String, trim: true, default: '' },
      qr: {
        code: { type: String, trim: true, default: '' },
        deepLinkUrl: { type: String, trim: true, default: '' },
        qrImageUrl: { type: String, trim: true, default: '' },
        prefilledMessage: { type: String, trim: true, default: '' },
        imageFormat: { type: String, trim: true, default: '' },
        generatedAt: { type: Date },
        raw: { type: mongoose.Schema.Types.Mixed },
      },
    },
    isActive: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

module.exports = mongoose.model('Organization', organizationSchema);
