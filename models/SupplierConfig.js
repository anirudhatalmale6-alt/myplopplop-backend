const mongoose = require('mongoose');

const supplierConfigSchema = new mongoose.Schema({
  supplierType: {
    type: String,
    required: true,
    unique: true,
    enum: ['CJ_USA', 'WALMART_USA', 'SHEIN_USA', 'ALIBABA', 'CUSTOM_USA', 'CUSTOM_DR', 'CUSTOM_PA', 'HAITI_MERCHANT']
  },
  name: { type: String, required: true },
  isActive: { type: Boolean, default: false },
  credentials: {
    apiKey: { type: String, default: '' },
    apiSecret: { type: String, default: '' },
    accessToken: { type: String, default: '' },
    refreshToken: { type: String, default: '' },
    tokenExpiresAt: { type: Date },
    extra: { type: mongoose.Schema.Types.Mixed, default: {} }
  },
  settings: {
    markupPercent: { type: Number, default: 30 },
    exchangeRateHTG: { type: Number, default: 135 },
    syncIntervalMinutes: { type: Number, default: 60 },
    autoCreateOrders: { type: Boolean, default: true },
    defaultWarehouse: { type: String, default: '' },
    estimatedDeliveryDays: { type: Number, default: 21 }
  },
  lastSync: {
    products: { type: Date },
    inventory: { type: Date },
    orders: { type: Date },
    tracking: { type: Date }
  },
  stats: {
    totalProducts: { type: Number, default: 0 },
    totalOrders: { type: Number, default: 0 },
    totalRevenue: { type: Number, default: 0 },
    totalSupplierCost: { type: Number, default: 0 }
  }
}, { timestamps: true });

module.exports = mongoose.model('SupplierConfig', supplierConfigSchema);
