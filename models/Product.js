const mongoose = require('mongoose');

const productSchema = new mongoose.Schema({
  store: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Store',
    required: true
  },
  name: {
    type: String,
    required: [true, 'Product name is required'],
    trim: true,
    maxlength: 200
  },
  description: {
    type: String,
    maxlength: 1000
  },
  price: {
    type: Number,
    required: [true, 'Price is required'],
    min: 0
  },
  currency: {
    type: String,
    default: 'HTG'
  },
  comparePrice: Number, // original price for showing discount
  category: {
    type: String,
    trim: true
  },
  images: [String],
  inStock: {
    type: Boolean,
    default: true
  },
  stockQuantity: {
    type: Number,
    default: -1 // -1 = unlimited
  },
  unit: {
    type: String,
    default: 'piece' // piece, kg, lb, dozen, pack, etc.
  },
  isActive: {
    type: Boolean,
    default: true
  },
  isFeatured: {
    type: Boolean,
    default: false
  },
  rating: {
    average: { type: Number, default: 0 },
    count: { type: Number, default: 0 }
  },
  orderCount: { type: Number, default: 0 },

  // ─── Catalogue source ───
  // Products can arrive by hand, by CSV, or straight out of a merchant's own
  // system (Odoo). The last case needs a stable key back to their record so a
  // price change updates the row instead of creating a second one.
  sku: { type: String, trim: true, default: '' },
  externalId: { type: String, trim: true, default: '' },
  source: {
    type: String,
    enum: ['manual', 'csv', 'odoo'],
    default: 'manual'
  },
  lastSyncedAt: Date
}, {
  timestamps: true
});

productSchema.index({ store: 1, source: 1, externalId: 1 });
productSchema.index({ store: 1, sku: 1 });
productSchema.index({ store: 1, isActive: 1 });
productSchema.index({ category: 1 });
productSchema.index({ name: 'text', description: 'text' });

module.exports = mongoose.model('Product', productSchema);
