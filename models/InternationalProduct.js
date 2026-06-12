const mongoose = require('mongoose');

const internationalProductSchema = new mongoose.Schema({
  store: { type: mongoose.Schema.Types.ObjectId, ref: 'InternationalStore', required: true },
  name: { type: String, required: [true, 'Product name required'], trim: true },
  description: { type: String, default: '' },
  category: { type: String, default: 'General' },
  subcategory: { type: String, default: '' },
  categoryRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Category' },
  sku: { type: String, default: '' },
  externalId: { type: String, default: '' },
  supplierType: { type: String, default: 'MANUAL' },
  images: [{ type: String }],
  variants: [{
    name: { type: String },
    options: [{ type: String }],
    priceModifier: { type: Number, default: 0 }
  }],
  weight: { type: Number, default: 0 },
  warehouse: { type: String, default: '' },
  sourcePrice: { type: Number, required: true },
  sourceCurrency: { type: String, required: true, enum: ['USD', 'DOP', 'PAB', 'HTG'] },
  markupPercent: { type: Number, default: 0 },
  shippingCostUSD: { type: Number, default: 0 },
  exchangeRate: { type: Number, required: true },
  serviceFee: { type: Number, default: 0 },
  logisticsFee: { type: Number, default: 0 },
  customsDuty: { type: Number, default: 0 },
  finalPriceHTG: { type: Number, required: true },
  inventory: { type: Number, default: -1 },
  inStock: { type: Boolean, default: true },
  isActive: { type: Boolean, default: true },
  estimatedDeliveryDays: { type: Number, default: 7 },
  orderCount: { type: Number, default: 0 },
  lastSyncedAt: { type: Date }
}, { timestamps: true });

internationalProductSchema.index({ store: 1, isActive: 1 });
internationalProductSchema.index({ name: 'text', description: 'text' });

module.exports = mongoose.model('InternationalProduct', internationalProductSchema);
