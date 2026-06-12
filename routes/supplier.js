const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { protect, authorize } = require('../middleware/auth');
const SupplierConfig = require('../models/SupplierConfig');
const InternationalProduct = require('../models/InternationalProduct');
const InternationalOrder = require('../models/InternationalOrder');
const cj = require('../services/cjDropshipping');

// ─── ADMIN: List Supplier Configs ───
router.get('/configs', protect, authorize('admin'), async (req, res) => {
  try {
    var configs = await SupplierConfig.find();
    res.json({ success: true, data: configs });
  } catch (err) {
    console.error('Supplier configs error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── ADMIN: Get/Create CJ Config ───
router.get('/cj/config', protect, authorize('admin'), async (req, res) => {
  try {
    var config = await SupplierConfig.findOne({ supplierType: 'CJ_USA' });
    if (!config) {
      config = await SupplierConfig.create({
        supplierType: 'CJ_USA',
        name: 'CJ Dropshipping USA',
        isActive: false
      });
    }
    var safe = config.toObject();
    if (safe.credentials.apiSecret) safe.credentials.apiSecret = '***';
    res.json({ success: true, data: safe });
  } catch (err) {
    console.error('CJ config error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── ADMIN: Update CJ Credentials ───
router.put('/cj/config', protect, authorize('admin'), [
  body('credentials').optional().isObject(),
  body('settings').optional().isObject()
], async (req, res) => {
  try {
    var config = await SupplierConfig.findOne({ supplierType: 'CJ_USA' });
    if (!config) {
      config = await SupplierConfig.create({ supplierType: 'CJ_USA', name: 'CJ Dropshipping USA' });
    }

    if (req.body.credentials) {
      Object.keys(req.body.credentials).forEach(function(key) {
        if (req.body.credentials[key] !== '***') {
          config.credentials[key] = req.body.credentials[key];
        }
      });
    }
    if (req.body.settings) {
      Object.keys(req.body.settings).forEach(function(key) {
        config.settings[key] = req.body.settings[key];
      });
    }
    if (req.body.isActive !== undefined) config.isActive = req.body.isActive;

    await config.save();
    await cj.getOrCreateCJStore();

    res.json({ success: true, data: config });
  } catch (err) {
    console.error('Update CJ config error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── ADMIN: Test CJ Connection ───
router.post('/cj/test', protect, authorize('admin'), async (req, res) => {
  try {
    var result = await cj.testConnection();
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ─── ADMIN: Get CJ Auth Token ───
router.post('/cj/authenticate', protect, authorize('admin'), [
  body('email').isEmail(),
  body('password').notEmpty()
], async (req, res) => {
  var errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    var tokens = await cj.getAccessToken(req.body.email, req.body.password);
    var config = await SupplierConfig.findOne({ supplierType: 'CJ_USA' });
    if (!config) {
      config = await SupplierConfig.create({ supplierType: 'CJ_USA', name: 'CJ Dropshipping USA' });
    }
    config.credentials.accessToken = tokens.accessToken;
    config.credentials.refreshToken = tokens.refreshToken;
    config.credentials.tokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    config.isActive = true;
    await config.save();
    await cj.getOrCreateCJStore();

    res.json({ success: true, message: 'Authenticated with CJ Dropshipping' });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ─── ADMIN: Browse CJ Products ───
router.get('/cj/products', protect, authorize('admin'), async (req, res) => {
  try {
    var data = await cj.fetchProducts({
      page: req.query.page || 1,
      limit: req.query.limit || 20,
      categoryId: req.query.categoryId,
      productName: req.query.search
    });
    res.json({ success: true, data: data });
  } catch (err) {
    console.error('Browse CJ products error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── ADMIN: Import CJ Product ───
router.post('/cj/products/import', protect, authorize('admin'), [
  body('pid').notEmpty().withMessage('CJ Product ID required')
], async (req, res) => {
  var errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    var detail = await cj.getProductDetail(req.body.pid);
    var product = await cj.importProduct(detail, req.body.category, req.body.subcategory);
    res.json({ success: true, data: product });
  } catch (err) {
    console.error('Import CJ product error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── ADMIN: Bulk Import CJ Products ───
router.post('/cj/products/bulk-import', protect, authorize('admin'), [
  body('pids').isArray({ min: 1 }).withMessage('Product IDs array required')
], async (req, res) => {
  var errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    var imported = 0;
    var errs = [];

    for (var i = 0; i < req.body.pids.length; i++) {
      try {
        var detail = await cj.getProductDetail(req.body.pids[i]);
        await cj.importProduct(detail, req.body.category, req.body.subcategory);
        imported++;
      } catch (e) {
        errs.push({ pid: req.body.pids[i], error: e.message });
      }
    }

    res.json({ success: true, data: { imported, total: req.body.pids.length, errors: errs } });
  } catch (err) {
    console.error('Bulk import error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── ADMIN: Sync Inventory ───
router.post('/cj/sync/inventory', protect, authorize('admin'), async (req, res) => {
  try {
    var result = await cj.syncInventory();
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Sync inventory error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── ADMIN: Sync Tracking ───
router.post('/cj/sync/tracking', protect, authorize('admin'), async (req, res) => {
  try {
    var result = await cj.syncTracking();
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Sync tracking error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── ADMIN: CJ Dashboard Stats ───
router.get('/cj/stats', protect, authorize('admin'), async (req, res) => {
  try {
    var config = await SupplierConfig.findOne({ supplierType: 'CJ_USA' });
    var totalProducts = await InternationalProduct.countDocuments({ supplierType: 'CJ_USA', isActive: true });
    var totalOrders = await InternationalOrder.countDocuments({ supplierType: 'CJ_USA' });
    var lowStock = await InternationalProduct.countDocuments({ supplierType: 'CJ_USA', isActive: true, inventory: { $gt: 0, $lt: 10 } });

    var revenueAgg = await InternationalOrder.aggregate([
      { $match: { supplierType: 'CJ_USA', status: { $nin: ['cancelled', 'refunded'] } } },
      { $group: { _id: null, revenue: { $sum: '$totalHTG' }, cost: { $sum: '$settlement.supplierCostUSD' }, profit: { $sum: '$settlement.platformProfit' } } }
    ]);

    var topProducts = await InternationalProduct.find({ supplierType: 'CJ_USA', isActive: true })
      .sort({ orderCount: -1 }).limit(10).select('name images orderCount finalPriceHTG sourcePrice');

    res.json({
      success: true,
      data: {
        totalProducts,
        totalOrders,
        lowStockAlerts: lowStock,
        revenue: revenueAgg.length > 0 ? revenueAgg[0] : { revenue: 0, cost: 0, profit: 0 },
        topProducts,
        lastSync: config ? config.lastSync : {},
        settings: config ? config.settings : {}
      }
    });
  } catch (err) {
    console.error('CJ stats error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── ADMIN: CJ Orders List ───
router.get('/cj/orders', protect, authorize('admin'), async (req, res) => {
  try {
    var page = parseInt(req.query.page) || 1;
    var limit = parseInt(req.query.limit) || 50;
    var skip = (page - 1) * limit;

    var query = { supplierType: 'CJ_USA' };
    if (req.query.status) query.status = req.query.status;

    var orders = await InternationalOrder.find(query)
      .populate('customer', 'firstName lastName phone')
      .sort({ createdAt: -1 }).skip(skip).limit(limit);
    var total = await InternationalOrder.countDocuments(query);

    res.json({ success: true, data: orders, pagination: { page, limit, total } });
  } catch (err) {
    console.error('CJ orders error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── ADMIN: Smart Import Phase 1 ───
router.post('/cj/smart-import', protect, authorize('admin'), async (req, res) => {
  try {
    res.json({ success: true, message: 'Smart import started. This runs in the background.' });

    cj.smartImportPhase1(function(progress) {
      console.log('CJ Import: ' + progress.step + '/' + progress.total + ' - "' + progress.search + '" (' + progress.imported + ' imported)');
    }).then(function(result) {
      console.log('CJ Smart Import complete:', JSON.stringify(result));
    }).catch(function(err) {
      console.error('CJ Smart Import error:', err);
    });
  } catch (err) {
    console.error('Smart import error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── ADMIN: Get Import Rules ───
router.get('/cj/import-rules', protect, authorize('admin'), async (req, res) => {
  res.json({ success: true, data: cj.IMPORT_RULES });
});

// ─── PUBLIC: Featured CJ USA Products ───
router.get('/cj/featured', async (req, res) => {
  try {
    var limit = parseInt(req.query.limit) || 20;
    var products = await cj.getFeaturedProducts(limit);
    res.json({ success: true, data: products });
  } catch (err) {
    console.error('Featured products error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUBLIC: Featured CJ Products by Category ───
router.get('/cj/featured/:category', async (req, res) => {
  try {
    var limit = parseInt(req.query.limit) || 10;
    var products = await cj.getFeaturedByCategory(req.params.category, limit);
    res.json({ success: true, data: products });
  } catch (err) {
    console.error('Featured by category error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
