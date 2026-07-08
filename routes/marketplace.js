const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const AffiliateConfig = require('../models/AffiliateConfig');
const affiliate = require('../services/affiliate');

// In-memory default so the unified search stays up even if Mongo is cold
// (Render free tier) — the demo never breaks. Live/admin data comes from DB.
var DEFAULT_CFG = {
  retailers: [
    { key: 'amazon',     name: 'Amazon',          affiliateId: 'myplopplop69-20', affiliateEnabled: true, orderThroughEnabled: true },
    { key: 'walmart',    name: 'Walmart',         affiliateId: '', affiliateEnabled: true,  orderThroughEnabled: true },
    { key: 'ebay',       name: 'eBay',            affiliateId: '', affiliateEnabled: true,  orderThroughEnabled: true },
    { key: 'aliexpress', name: 'AliExpress',      affiliateId: '', affiliateEnabled: true,  orderThroughEnabled: true },
    { key: 'temu',       name: 'Temu',            affiliateId: '', affiliateEnabled: false, orderThroughEnabled: true },
    { key: 'cj',         name: 'CJ Dropshipping', affiliateId: '', affiliateEnabled: false, orderThroughEnabled: true }
  ],
  fees: { exchangeRateHTG: 135, shippingMarkupPercent: 15, serviceFeePercent: 10, importFeePercent: 12, deliveryFeeHTG: 250 }
};

async function loadConfig() {
  try {
    var doc = await AffiliateConfig.getSingleton();
    return doc.toObject ? doc.toObject() : doc;
  } catch (err) {
    // DB not ready — fall back to defaults so search still works
    return DEFAULT_CFG;
  }
}

// ─── Unified Global Product Search (public) ───
// GET /api/marketplace/search?q=headphones&retailer=amazon
// Returns every match as a two-option card: affiliate link + order-through price.
router.get('/search', async (req, res) => {
  try {
    var q = (req.query.q || '').toString();
    var retailer = req.query.retailer ? req.query.retailer.toString().toLowerCase() : null;
    var cfg = await loadConfig();

    var results = affiliate.searchDemo(q, cfg, retailer);

    res.json({
      success: true,
      query: q,
      count: results.length,
      currency: 'HTG',
      results: results
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Retailers list (public — used to render supplier filter chips) ───
router.get('/retailers', async (req, res) => {
  var cfg = await loadConfig();
  res.json({
    success: true,
    retailers: cfg.retailers.map(function(r) {
      return { key: r.key, name: r.name, affiliate: r.affiliateEnabled, orderThrough: r.orderThroughEnabled };
    })
  });
});

// ─── Admin: get full settings (affiliate IDs + fee model) ───
router.get('/settings', protect, authorize('admin'), async (req, res) => {
  try {
    var doc = await AffiliateConfig.getSingleton();
    res.json({ success: true, settings: doc });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Admin: update settings ───
// Body: { retailers: [{key, affiliateId, affiliateEnabled, orderThroughEnabled}], fees: {...} }
router.put('/settings', protect, authorize('admin'), async (req, res) => {
  try {
    var doc = await AffiliateConfig.getSingleton();

    if (Array.isArray(req.body.retailers)) {
      req.body.retailers.forEach(function(incoming) {
        var existing = doc.retailers.find(function(r) { return r.key === incoming.key; });
        if (existing) {
          if (incoming.affiliateId !== undefined) existing.affiliateId = incoming.affiliateId;
          if (incoming.affiliateEnabled !== undefined) existing.affiliateEnabled = !!incoming.affiliateEnabled;
          if (incoming.orderThroughEnabled !== undefined) existing.orderThroughEnabled = !!incoming.orderThroughEnabled;
        } else if (incoming.key && incoming.name) {
          // modular: admin can add a brand-new retailer
          doc.retailers.push({
            key: incoming.key,
            name: incoming.name,
            affiliateId: incoming.affiliateId || '',
            affiliateEnabled: incoming.affiliateEnabled !== undefined ? !!incoming.affiliateEnabled : true,
            orderThroughEnabled: incoming.orderThroughEnabled !== undefined ? !!incoming.orderThroughEnabled : true
          });
        }
      });
    }

    if (req.body.fees && typeof req.body.fees === 'object') {
      ['exchangeRateHTG', 'shippingMarkupPercent', 'serviceFeePercent', 'importFeePercent', 'deliveryFeeHTG'].forEach(function(k) {
        if (req.body.fees[k] !== undefined && req.body.fees[k] !== '') {
          doc.fees[k] = parseFloat(req.body.fees[k]);
        }
      });
    }

    await doc.save();
    res.json({ success: true, settings: doc });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
