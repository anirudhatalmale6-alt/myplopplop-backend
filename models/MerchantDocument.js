/* 4 Nov 2026 (Jeffery): "The business information, storefront photo, and owner's identification document
   must be securely uploaded to the server ... Keep merchant identification documents private, accessible
   only to authorized staff. They must never appear on public storefronts."
   Kept in their OWN collection, never referenced by the Store document, so no store/product route can
   return them by accident. Read only by routes/merchantVerification.js (internal key = Jennifer's console). */
const mongoose = require('mongoose');

const merchantDocumentSchema = new mongoose.Schema({
  store: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true },
  type: { type: String, enum: ['storefront', 'owner_id'], required: true },
  mime: { type: String, default: 'image/jpeg' },
  data: { type: String, required: true },          // base64, no data: prefix
  size: Number,
  by: String                                       // 'merchant', 'ajan:LMA-…', 'console:Jennifer'
}, { timestamps: true });

merchantDocumentSchema.index({ store: 1, type: 1 }, { unique: true });

module.exports = mongoose.model('MerchantDocument', merchantDocumentSchema);
