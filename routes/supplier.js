const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { protect, authorize } = require('../middleware/auth');
const SupplierConfig = require('../models/SupplierConfig');
const InternationalProduct = require('../models/InternationalProduct');
const InternationalOrder = require('../models/InternationalOrder');
const registry = require('../services/supplierRegistry');

function getAdapter(req, res) {
  var type = req.params.type;
  if (!type) {
    res.status(400).json({ success: false, message: 'Supplier type required' });
    return null;
  }
  return registry.get(type.toUpperCase());
}

// ─── List registered supplier types ───
router.get('/types', protect, authorize('admin'), (req, res) => {
  res.json({ success: true, data: registry.list() });
});

// ─── List all supplier configs ───
router.get('/configs', protect, authorize('admin'), async (req, res) => {
  try {
    var configs = await SupplierConfig.find();
    var safe = configs.map(function(c) {
      var obj = c.toObject();
      if (obj.credentials.apiSecret) obj.credentials.apiSecret = '***';
      return obj;
    });
    res.json({ success: true, data: safe });
  } catch (err) {
    console.error('Supplier configs error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── Get config for a supplier type ───
router.get('/:type/config', protect, authorize('admin'), async (req, res) => {
  try {
    var type = req.params.type.toUpperCase();
    var config = await SupplierConfig.findOne({ supplierType: type });
    if (!config) {
      config = await SupplierConfig.create({ supplierType: type, name: type });
    }
    var safe = config.toObject();
    if (safe.credentials.apiSecret) safe.credentials.apiSecret = '***';
    res.json({ success: true, data: safe });
  } catch (err) {
    console.error('Supplier config error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── Update config for a supplier type ───
router.put('/:type/config', protect, authorize('admin'), async (req, res) => {
  try {
    var type = req.params.type.toUpperCase();
    var config = await SupplierConfig.findOne({ supplierType: type });
    if (!config) {
      config = await SupplierConfig.create({ supplierType: type, name: req.body.name || type });
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
    if (req.body.name) config.name = req.body.name;
    if (req.body.isActive !== undefined) config.isActive = req.body.isActive;

    await config.save();

    var adapter = registry.get(type);
    if (adapter.ensureStore) {
      await adapter.ensureStore(config.name, req.body.country || 'US');
    }

    res.json({ success: true, data: config });
  } catch (err) {
    console.error('Update supplier config error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── Test connection ───
router.post('/:type/test', protect, authorize('admin'), async (req, res) => {
  try {
    var adapter = getAdapter(req, res);
    if (!adapter) return;
    var result = await adapter.testConnection();
    res.json({ success: true, data: result });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ─── Authenticate (for API-based suppliers) ───
router.post('/:type/authenticate', protect, authorize('admin'), async (req, res) => {
  try {
    var adapter = getAdapter(req, res);
    if (!adapter) return;
    var result = await adapter.authenticate(req.body);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

// ─── Browse supplier catalog ───
router.get('/:type/products', protect, authorize('admin'), async (req, res) => {
  try {
    var adapter = getAdapter(req, res);
    if (!adapter) return;
    var data = await adapter.fetchProducts({
      page: req.query.page || 1,
      limit: req.query.limit || 20,
      categoryId: req.query.categoryId,
      search: req.query.search
    });
    res.json({ success: true, data: data });
  } catch (err) {
    console.error('Browse products error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Import single product ───
router.post('/:type/products/import', protect, authorize('admin'), [
  body('externalId').notEmpty().withMessage('External product ID required')
], async (req, res) => {
  var errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    var adapter = getAdapter(req, res);
    if (!adapter) return;
    var detail = await adapter.getProductDetail(req.body.externalId);
    var product = await adapter.importProduct(detail, req.body.category, req.body.subcategory);
    res.json({ success: true, data: product });
  } catch (err) {
    console.error('Import product error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Bulk import ───
router.post('/:type/products/bulk-import', protect, authorize('admin'), [
  body('externalIds').isArray({ min: 1 }).withMessage('External IDs array required')
], async (req, res) => {
  var errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    var adapter = getAdapter(req, res);
    if (!adapter) return;
    var imported = 0;
    var errs = [];

    for (var i = 0; i < req.body.externalIds.length; i++) {
      try {
        var detail = await adapter.getProductDetail(req.body.externalIds[i]);
        await adapter.importProduct(detail, req.body.category, req.body.subcategory);
        imported++;
      } catch (e) {
        errs.push({ externalId: req.body.externalIds[i], error: e.message });
      }
    }

    res.json({ success: true, data: { imported, total: req.body.externalIds.length, errors: errs } });
  } catch (err) {
    console.error('Bulk import error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Manual product add (for non-API suppliers) ───
router.post('/:type/products/add', protect, authorize('admin'), [
  body('name').notEmpty().withMessage('Product name required'),
  body('sourcePrice').isNumeric().withMessage('Source price required')
], async (req, res) => {
  var errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    var adapter = getAdapter(req, res);
    if (!adapter) return;
    var product = await adapter.importProduct(req.body, req.body.category, req.body.subcategory);
    res.json({ success: true, data: product });
  } catch (err) {
    console.error('Add product error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Sync inventory ───
router.post('/:type/sync/inventory', protect, authorize('admin'), async (req, res) => {
  try {
    var adapter = getAdapter(req, res);
    if (!adapter) return;
    var result = await adapter.syncInventory();
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Sync inventory error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Sync tracking ───
router.post('/:type/sync/tracking', protect, authorize('admin'), async (req, res) => {
  try {
    var adapter = getAdapter(req, res);
    if (!adapter) return;
    var result = await adapter.syncTracking();
    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Sync tracking error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Smart import (for suppliers that support it) ───
router.post('/:type/smart-import', protect, authorize('admin'), async (req, res) => {
  try {
    var adapter = getAdapter(req, res);
    if (!adapter) return;
    if (!adapter.smartImport) {
      return res.status(400).json({ success: false, message: 'Smart import not supported for ' + req.params.type });
    }

    res.json({ success: true, message: 'Smart import started in background' });

    adapter.smartImport(function(progress) {
      console.log(req.params.type + ' Import: ' + progress.step + '/' + progress.total + ' - "' + progress.search + '" (' + progress.imported + ' imported)');
    }).then(function(result) {
      console.log(req.params.type + ' Smart Import complete:', JSON.stringify(result));
    }).catch(function(err) {
      console.error(req.params.type + ' Smart Import error:', err);
    });
  } catch (err) {
    console.error('Smart import error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ─── Get import rules ───
router.get('/:type/import-rules', protect, authorize('admin'), (req, res) => {
  var adapter = getAdapter(req, res);
  if (!adapter) return;
  var rules = adapter.getImportRules();
  res.json({ success: true, data: rules });
});

// ─── Dashboard stats ───
router.get('/:type/stats', protect, authorize('admin'), async (req, res) => {
  try {
    var adapter = getAdapter(req, res);
    if (!adapter) return;
    var stats = await adapter.getStats();
    res.json({ success: true, data: stats });
  } catch (err) {
    console.error('Supplier stats error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── Orders for a supplier ───
router.get('/:type/orders', protect, authorize('admin'), async (req, res) => {
  try {
    var adapter = getAdapter(req, res);
    if (!adapter) return;
    var statusQuery = req.query.status ? { status: req.query.status } : {};
    var result = await adapter.getOrders(statusQuery, parseInt(req.query.page), parseInt(req.query.limit));
    res.json({ success: true, data: result.orders, pagination: result.pagination });
  } catch (err) {
    console.error('Supplier orders error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUBLIC: Featured products for a supplier ───
router.get('/:type/featured', async (req, res) => {
  try {
    var adapter = registry.get(req.params.type.toUpperCase());
    var limit = parseInt(req.query.limit) || 20;
    var products = await adapter.getFeaturedProducts(limit);
    res.json({ success: true, data: products });
  } catch (err) {
    console.error('Featured products error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUBLIC: Featured by category ───
router.get('/:type/featured/:category', async (req, res) => {
  try {
    var adapter = registry.get(req.params.type.toUpperCase());
    var limit = parseInt(req.query.limit) || 10;
    var products = await adapter.getFeaturedByCategory(req.params.category, limit);
    res.json({ success: true, data: products });
  } catch (err) {
    console.error('Featured by category error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
