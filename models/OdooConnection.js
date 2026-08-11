const mongoose = require('mongoose');
const crypto = require('crypto');

// One Odoo instance linked to one MyPlopPlop store.
//
// Merchants who run Odoo (MSC Xpress runs On-Premise Enterprise 19) change their
// prices constantly, so a CSV upload is stale the moment it lands. This holds
// everything needed to pull their catalogue straight out of Odoo instead.

const odooConnectionSchema = new mongoose.Schema({
  store: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Store',
    required: true,
    unique: true
  },
  label: { type: String, default: '' },          // e.g. "MSC Xpress — Odoo 19 EE"
  isActive: { type: Boolean, default: false },

  // ─── Connection ───
  baseUrl: { type: String, default: '' },        // https://odoo.msc-example.com  (no trailing slash)
  database: { type: String, default: '' },       // Odoo database name
  username: { type: String, default: '' },       // login of the dedicated integration user
  apiKey: { type: String, default: '' },         // Odoo API key (Preferences → Account Security)

  // ─── What to pull ───
  model: { type: String, enum: ['product.template', 'product.product'], default: 'product.template' },
  // Extra Odoo domain, JSON-encoded, e.g. [["categ_id","child_of",12]]
  extraDomain: { type: String, default: '' },
  categoryIds: { type: [Number], default: [] },  // limit to these Odoo product categories
  onlySaleOk: { type: Boolean, default: true },
  syncImages: { type: Boolean, default: false },
  trackStock: { type: Boolean, default: true },
  // Skip anything Odoo prices at 0 — usually services or unpriced drafts
  skipZeroPrice: { type: Boolean, default: true },
  // Deactivate our copies of products that disappeared from Odoo (full syncs only)
  deactivateMissing: { type: Boolean, default: true },

  // ─── Pricing ───
  priceField: { type: String, enum: ['list_price', 'standard_price'], default: 'list_price' },
  pricelistId: { type: Number, default: 0 },     // optional Odoo pricelist to honour
  sourceCurrency: { type: String, default: 'HTG' },
  exchangeRateHTG: { type: Number, default: 135 },
  markupPercent: { type: Number, default: 0 },
  roundToHTG: { type: Number, default: 5 },      // round selling price to nearest N gourdes (0 = off)

  // ─── Category mapping ───
  defaultCategory: { type: String, default: 'general' },
  // { "Odoo category name": "myplopplop-category" }
  categoryMap: { type: mongoose.Schema.Types.Mixed, default: {} },

  // ─── Scheduling ───
  syncIntervalMinutes: { type: Number, default: 30 },
  webhookToken: { type: String, default: () => crypto.randomBytes(24).toString('hex') },

  // ─── State ───
  lastRunAt: { type: Date },
  lastFullSyncAt: { type: Date },
  // Odoo write_date watermark of the last successful pull (incremental syncs)
  lastWriteDate: { type: String, default: '' },
  status: { type: String, enum: ['never_run', 'ok', 'error', 'running'], default: 'never_run' },
  lastError: { type: String, default: '' },
  stats: {
    created: { type: Number, default: 0 },
    updated: { type: Number, default: 0 },
    deactivated: { type: Number, default: 0 },
    totalSynced: { type: Number, default: 0 }
  },
  history: {
    type: [{
      at: Date,
      mode: String,           // full | incremental | webhook
      created: Number,
      updated: Number,
      deactivated: Number,
      skipped: Number,
      durationMs: Number,
      ok: Boolean,
      message: String
    }],
    default: []
  }
}, { timestamps: true });

// Never hand credentials back out of the API.
odooConnectionSchema.methods.toSafeJSON = function () {
  const obj = this.toObject();
  obj.apiKey = obj.apiKey ? '••••••••' + obj.apiKey.slice(-4) : '';
  obj.hasApiKey = !!this.apiKey;
  return obj;
};

module.exports = mongoose.model('OdooConnection', odooConnectionSchema);
