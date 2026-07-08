const mongoose = require('mongoose');

// Singleton settings document for the Global Product Search Engine.
// Holds affiliate IDs (Module 1) and the landed-price fee model (Module 2).
// One document only — always loaded via AffiliateConfig.getSingleton().

const retailerSchema = new mongoose.Schema({
  key: { type: String, required: true },        // 'amazon', 'walmart', 'ebay', 'aliexpress', 'temu', 'cj'
  name: { type: String, required: true },        // display name
  affiliateId: { type: String, default: '' },    // Associate ID / Publisher ID / Campaign ID
  affiliateEnabled: { type: Boolean, default: true },   // show "Buy on X" (Module 1)
  orderThroughEnabled: { type: Boolean, default: true } // show "Order Through MyPlopPlop" (Module 2)
}, { _id: false });

const affiliateConfigSchema = new mongoose.Schema({
  singleton: { type: String, default: 'GLOBAL', unique: true },

  retailers: { type: [retailerSchema], default: [] },

  // Module 2 — landed-price fee model (customer pays MyPlopPlop, we import + deliver)
  fees: {
    exchangeRateHTG: { type: Number, default: 135 },     // 1 USD -> HTG
    shippingMarkupPercent: { type: Number, default: 15 },// our shipping margin
    serviceFeePercent: { type: Number, default: 10 },    // handling / sourcing
    importFeePercent: { type: Number, default: 12 },     // customs / import duty estimate
    deliveryFeeHTG: { type: Number, default: 250 }       // flat last-mile (MsouWout)
  }
}, { timestamps: true });

// Sensible defaults on first creation — Amazon Associate ID already approved.
affiliateConfigSchema.statics.getSingleton = async function() {
  var doc = await this.findOne({ singleton: 'GLOBAL' });
  if (doc) return doc;
  return this.create({
    singleton: 'GLOBAL',
    retailers: [
      { key: 'amazon',     name: 'Amazon',      affiliateId: 'myplopplop69-20', affiliateEnabled: true, orderThroughEnabled: true },
      { key: 'walmart',    name: 'Walmart',     affiliateId: '', affiliateEnabled: true, orderThroughEnabled: true },
      { key: 'ebay',       name: 'eBay',        affiliateId: '', affiliateEnabled: true, orderThroughEnabled: true },
      { key: 'aliexpress', name: 'AliExpress',  affiliateId: '', affiliateEnabled: true, orderThroughEnabled: true },
      { key: 'temu',       name: 'Temu',        affiliateId: '', affiliateEnabled: false, orderThroughEnabled: true },
      { key: 'cj',         name: 'CJ Dropshipping', affiliateId: '', affiliateEnabled: false, orderThroughEnabled: true }
    ]
  });
};

module.exports = mongoose.model('AffiliateConfig', affiliateConfigSchema);
