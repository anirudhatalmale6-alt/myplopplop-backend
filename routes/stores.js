const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const Store = require('../models/Store');
const Product = require('../models/Product');
const Order = require('../models/Order');
const { protect, authorize } = require('../middleware/auth');
const referralService = require('../services/referral');

// ─── GET ALL ACTIVE STORES (public) ───
router.get('/', async function(req, res) {
  try {
    var page = parseInt(req.query.page) || 1;
    var limit = parseInt(req.query.limit) || 20;
    var category = req.query.category;
    var search = req.query.search;

    var query = { status: 'active' };
    if (category) query.category = category;
    if (search) {
      query.name = { $regex: search, $options: 'i' };
    }

    var stores = await Store.find(query)
      .select('name slug category logo coverImage rating stats address deliveryOptions isFeatured isVerified status')
      .sort({ isFeatured: -1, 'rating.average': -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    var total = await Store.countDocuments(query);

    res.json({
      success: true,
      data: stores,
      pagination: { page: page, limit: limit, total: total }
    });
  } catch (err) {
    console.error('Get stores error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET STORE BY SLUG (public) ───
router.get('/s/:slug', async function(req, res) {
  try {
    var store = await Store.findOne({ slug: req.params.slug, status: 'active' })
      .populate('owner', 'name phone');

    if (!store) {
      return res.status(404).json({ success: false, message: 'Store not found' });
    }

    var products = await Product.find({ store: store._id, isActive: true })
      .sort({ isFeatured: -1, orderCount: -1 });

    res.json({ success: true, data: { store: store, products: products } });
  } catch (err) {
    console.error('Get store error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET STORE BY ID (public) ───
router.get('/:id', async function(req, res) {
  try {
    // A shop link that carries a name instead of an id - a shared link that
    // got edited, an old bookmark, /api/stores/products - used to reach
    // Store.findOne with something that is not an id at all, and mongoose
    // threw. The shopper saw "Server error" for what is really just a shop
    // that is not there. Answer the question that was actually asked: look it
    // up by slug too, and say "not found" when it is not found.
    var byId = /^[0-9a-fA-F]{24}$/.test(String(req.params.id));
    var store = await Store.findOne(byId
      ? { _id: req.params.id, status: 'active' }
      : { slug: req.params.id, status: 'active' });
    if (!store) {
      return res.status(404).json({ success: false, message: 'Store not found' });
    }

    var products = await Product.find({ store: store._id, isActive: true })
      .sort({ isFeatured: -1, orderCount: -1 });

    res.json({ success: true, data: { store: store, products: products } });
  } catch (err) {
    console.error('Get store error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── CREATE STORE (merchant) ───
router.post('/', protect, [
  body('name').trim().notEmpty().withMessage('Store name is required'),
  body('category').isIn(['restaurant', 'supermarket', 'hardware', 'pharmacy', 'wholesale', 'retail', 'bakery', 'other'])
], async function(req, res) {
  try {
    var errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    // Set user role to merchant if not already
    var user = await require('../models/User').findById(req.user._id);
    if (user.role === 'customer') {
      user.role = 'merchant';
      await user.save();
    }

    var store = await Store.create({
      owner: req.user._id,
      name: req.body.name,
      description: req.body.description || '',
      category: req.body.category,
      phone: req.body.phone || user.phone,
      email: req.body.email || user.email,
      address: req.body.address || {},
      logo: req.body.logo || '',
      coverImage: req.body.coverImage || '',
      deliveryOptions: req.body.deliveryOptions || {},
      status: 'active',
      isVerified: true, // auto-verify new merchant stores on signup
      referralPartner: req.body.referralPartner || undefined
    });

    // Credit the LajanMaker agent who brought this merchant. A merchant can
    // arrive two ways - signing up straight from an agent's link, or as an
    // ordinary customer who opens a shop later - so the code is looked for
    // here as well as at sign-up. attachReferral() only writes one referral
    // per person, so doing it in both places cannot pay an agent twice.
    var agentCode = req.body.koutyeCode || req.body.agentCode || req.body.ref;
    var refResult = await referralService.attachReferral({
      code: agentCode,
      platform: 'myplopplop',
      entityType: 'merchant',
      user: req.user._id,
      name: store.name,
      phone: store.phone || user.phone,
      email: store.email || user.email,
      source: 'Store registration: ' + store.name
    });
    // Someone the agent signed up as a customer has now opened a shop. Same
    // referral, same 12 months - but the report should call them a merchant.
    if (!refResult.attached && refResult.reason === 'already_referred' && refResult.referral) {
      if (refResult.referral.referredEntity.type !== 'merchant') {
        refResult.referral.referredEntity.type = 'merchant';
        refResult.referral.referredEntity.name = store.name;
        await refResult.referral.save().catch(function () {});
      }
    }

    // Tell the office a real store just appeared, with the partner who sent them.
    try {
      require('../utils/notify').notifySignup('store', {
        storeName: store.name,
        name: user.name,
        phone: store.phone || user.phone,
        category: store.category,
        referralPartner: store.referralPartner || ''
      }).catch(function() {});
    } catch (e) { /* notification must never block a store being created */ }

    res.status(201).json({ success: true, data: store });
  } catch (err) {
    console.error('Create store error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── UPDATE STORE (owner only) ───
router.put('/:id', protect, async function(req, res) {
  try {
    var store = await Store.findById(req.params.id);
    if (!store) {
      return res.status(404).json({ success: false, message: 'Store not found' });
    }
    if (store.owner.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    var allowed = ['name', 'description', 'category', 'phone', 'email', 'address', 'openingHours', 'deliveryOptions', 'logo', 'coverImage', 'status'];
    allowed.forEach(function(field) {
      if (req.body[field] !== undefined) store[field] = req.body[field];
    });

    // The partner who introduced the merchant is set once, at sign-up, and is
    // not something a later edit can quietly reassign.
    if (!store.referralPartner && req.body.referralPartner) {
      store.referralPartner = req.body.referralPartner;
    }

    await store.save();
    res.json({ success: true, data: store });
  } catch (err) {
    console.error('Update store error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── MERCHANT: GET MY STORE ───
router.get('/merchant/my-store', protect, async function(req, res) {
  try {
    var store = await Store.findOne({ owner: req.user._id });
    if (!store) {
      return res.status(404).json({ success: false, message: 'No store found' });
    }

    var products = await Product.find({ store: store._id }).sort('-createdAt');
    var recentOrders = await Order.find({ store: store._id })
      .populate('customer', 'name phone')
      .sort('-createdAt')
      .limit(20);

    res.json({
      success: true,
      data: {
        store: store,
        products: products,
        recentOrders: recentOrders
      }
    });
  } catch (err) {
    console.error('Get my store error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── MERCHANT: GET STORE ORDERS ───
router.get('/:id/orders', protect, async function(req, res) {
  try {
    var store = await Store.findById(req.params.id);
    if (!store) {
      return res.status(404).json({ success: false, message: 'Store not found' });
    }
    if (store.owner.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    var page = parseInt(req.query.page) || 1;
    var limit = parseInt(req.query.limit) || 20;
    var statusFilter = req.query.status;

    var query = { store: store._id };
    if (statusFilter) query.status = statusFilter;

    var orders = await Order.find(query)
      .populate('customer', 'name phone')
      .populate('rider', 'name phone')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(limit);

    var total = await Order.countDocuments(query);

    res.json({
      success: true,
      data: orders,
      pagination: { page: page, limit: limit, total: total }
    });
  } catch (err) {
    console.error('Get store orders error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── ADMIN: Activate all pending stores ───
router.patch('/admin/activate-all', protect, authorize('admin'), async function(req, res) {
  try {
    var result = await Store.updateMany({ status: 'pending' }, { $set: { status: 'active' } });
    res.json({ success: true, activated: result.modifiedCount || result.nModified || 0 });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ═══ PRODUCT MANAGEMENT ═══

// ─── ADD PRODUCT ───
router.post('/:storeId/products', protect, [
  body('name').trim().notEmpty(),
  body('price').isNumeric()
], async function(req, res) {
  try {
    var errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    }
    var store = await Store.findById(req.params.storeId);
    if (!store) {
      return res.status(404).json({ success: false, message: 'Store not found' });
    }
    if (store.owner.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    var product = await Product.create({
      store: store._id,
      name: req.body.name,
      description: req.body.description || '',
      price: req.body.price,
      comparePrice: req.body.comparePrice,
      category: req.body.category || '',
      images: req.body.images || [],
      unit: req.body.unit || 'piece',
      stockQuantity: req.body.stockQuantity || -1,
      inStock: req.body.inStock !== false
    });

    store.stats.totalProducts += 1;
    await store.save();

    res.status(201).json({ success: true, data: product });
  } catch (err) {
    console.error('Add product error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── BULK ADD PRODUCTS ───
router.post('/:storeId/products/bulk', protect, async function(req, res) {
  try {
    var store = await Store.findById(req.params.storeId);
    if (!store) {
      return res.status(404).json({ success: false, message: 'Store not found' });
    }
    if (store.owner.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    var items = req.body.products;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'No products provided' });
    }

    // Delete existing products for this store first (full sync)
    await Product.deleteMany({ store: store._id });

    var created = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item.name || !item.name.trim()) continue;
      var product = await Product.create({
        store: store._id,
        name: item.name.trim(),
        description: item.description || '',
        price: parseFloat(item.price) || 0,
        category: item.category || 'Products',
        images: item.images || [],
        unit: item.unit || 'piece',
        inStock: true
      });
      created.push(product);
    }

    store.stats.totalProducts = created.length;
    await store.save();

    res.status(201).json({ success: true, data: created, count: created.length });
  } catch (err) {
    console.error('Bulk add products error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── UPDATE PRODUCT ───
router.put('/products/:productId', protect, async function(req, res) {
  try {
    var product = await Product.findById(req.params.productId);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    var store = await Store.findById(product.store);
    if (store.owner.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    var allowed = ['name', 'description', 'price', 'comparePrice', 'category', 'images', 'inStock', 'stockQuantity', 'unit', 'isActive', 'isFeatured'];
    allowed.forEach(function(field) {
      if (req.body[field] !== undefined) product[field] = req.body[field];
    });

    await product.save();
    res.json({ success: true, data: product });
  } catch (err) {
    console.error('Update product error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── DELETE PRODUCT ───
router.delete('/products/:productId', protect, async function(req, res) {
  try {
    var product = await Product.findById(req.params.productId);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    var store = await Store.findById(product.store);
    if (store.owner.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    product.isActive = false;
    await product.save();

    store.stats.totalProducts = Math.max(0, store.stats.totalProducts - 1);
    await store.save();

    res.json({ success: true, message: 'Product removed' });
  } catch (err) {
    console.error('Delete product error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
