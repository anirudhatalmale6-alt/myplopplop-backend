const mongoose = require('mongoose');

const featuredListingSchema = new mongoose.Schema({
  vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  store: { type: mongoose.Schema.Types.ObjectId, ref: 'Store' },
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
  type: {
    type: String,
    enum: ['product', 'shop', 'banner'],
    required: true
  },
  price: { type: Number, required: true }, // HTG paid
  startDate: { type: Date, default: Date.now },
  endDate: { type: Date, required: true },
  status: {
    type: String,
    enum: ['active', 'expired', 'cancelled'],
    default: 'active'
  },
  impressions: { type: Number, default: 0 },
  clicks: { type: Number, default: 0 }
}, { timestamps: true });

featuredListingSchema.index({ status: 1, endDate: 1 });
featuredListingSchema.index({ store: 1 });

module.exports = mongoose.model('FeaturedListing', featuredListingSchema);
