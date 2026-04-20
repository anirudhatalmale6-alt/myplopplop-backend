const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const Store = require('../models/Store');
const Product = require('../models/Product');
const Order = require('../models/Order');
const { protect, authorize } = require('../middleware/auth');

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
      .select('name slug category logo coverImage rating stats address deliveryOptions isFeatured')
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
    var store = await Store.findOne({ _id: req.params.id, status: 'active' });
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
      deliveryOptions: req.body.deliveryOptions || {}
    });

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

    var allowed = ['name', 'description', 'phone', 'email', 'address', 'openingHours', 'deliveryOptions', 'logo', 'coverImage'];
    allowed.forEach(function(field) {
      if (req.body[field] !== undefined) store[field] = req.body[field];
    });

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

// ═══ PRODUCT MANAGEMENT ═══

// ─── ADD PRODUCT ───
router.post('/:storeId/products', protect, [
  body('name').trim().notEmpty(),
  body('price').isNumeric({ min: 0 })
], async function(req, res) {
  try {
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
