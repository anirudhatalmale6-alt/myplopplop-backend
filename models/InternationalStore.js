const mongoose = require('mongoose');

const internationalStoreSchema = new mongoose.Schema({
  name: { type: String, required: [true, 'Store name required'], trim: true },
  slug: { type: String, unique: true, lowercase: true },
  country: { type: String, required: true, enum: ['DO', 'PA', 'US'] },
  description: { type: String, default: '' },
  logo: { type: String, default: '' },
  coverImage: { type: String, default: '' },
  category: { type: String, default: 'general', enum: ['general', 'electronics', 'clothing', 'home', 'food', 'health', 'auto', 'other'] },
  address: { type: String, default: '' },
  city: { type: String, default: '' },
  website: { type: String, default: '' },
  isActive: { type: Boolean, default: true },
  serviceFeePercent: { type: Number, default: 10 },
  logisticsFeeHTG: { type: Number, default: 0 },
  customsDutyPercent: { type: Number, default: 5 },
  estimatedDeliveryDays: { type: Number, default: 7 },
  stats: {
    totalProducts: { type: Number, default: 0 },
    totalOrders: { type: Number, default: 0 },
    totalRevenue: { type: Number, default: 0 }
  }
}, { timestamps: true });

internationalStoreSchema.pre('save', function(next) {
  if (this.isNew || this.isModified('name')) {
    this.slug = this.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }
  next();
});

internationalStoreSchema.index({ country: 1, isActive: 1 });
internationalStoreSchema.index({ slug: 1 });

module.exports = mongoose.model('InternationalStore', internationalStoreSchema);
