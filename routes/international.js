const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { protect, authorize } = require('../middleware/auth');
const upload = require('../middleware/upload');
const InternationalStore = require('../models/InternationalStore');
const InternationalProduct = require('../models/InternationalProduct');
const InternationalOrder = require('../models/InternationalOrder');
const Category = require('../models/Category');
const cj = require('../services/cjDropshipping');

// ─── PUBLIC: Browse Stores by Country ───
router.get('/stores', async (req, res) => {
  try {
    var query = { isActive: true };
    if (req.query.country) query.country = req.query.country.toUpperCase();
    if (req.query.category) query.category = req.query.category;

    var page = parseInt(req.query.page) || 1;
    var limit = parseInt(req.query.limit) || 50;
    var skip = (page - 1) * limit;

    var stores = await InternationalStore.find(query).sort({ 'stats.totalOrders': -1 }).skip(skip).limit(limit);
    var total = await InternationalStore.countDocuments(query);

    res.json({ success: true, data: stores, pagination: { page, limit, total } });
  } catch (err) {
    console.error('International stores error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUBLIC: Get Store with Products ───
router.get('/stores/:id', async (req, res) => {
  try {
    var store = await InternationalStore.findById(req.params.id);
    if (!store) return res.status(404).json({ success: false, message: 'Store not found' });

    var query = { store: store._id, isActive: true };
    if (req.query.category) query.category = req.query.category;
    if (req.query.search) query.$text = { $search: req.query.search };

    var products = await InternationalProduct.find(query).sort({ orderCount: -1 });

    res.json({ success: true, data: { store, products } });
  } catch (err) {
    console.error('International store detail error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUBLIC: Browse Products by Category ───
router.get('/products', async (req, res) => {
  try {
    var query = { isActive: true };
    if (req.query.category) query.category = req.query.category;
    if (req.query.subcategory) query.subcategory = req.query.subcategory;
    if (req.query.supplierType) query.supplierType = req.query.supplierType;
    if (req.query.country) {
      var stores = await InternationalStore.find({ country: req.query.country.toUpperCase() }).select('_id');
      query.store = { $in: stores.map(function(s) { return s._id; }) };
    }
    if (req.query.search) query.$text = { $search: req.query.search };
    if (req.query.minPrice) query.finalPriceHTG = { $gte: parseInt(req.query.minPrice) };
    if (req.query.maxPrice) {
      query.finalPriceHTG = query.finalPriceHTG || {};
      query.finalPriceHTG.$lte = parseInt(req.query.maxPrice);
    }

    var page = parseInt(req.query.page) || 1;
    var limit = parseInt(req.query.limit) || 40;
    var skip = (page - 1) * limit;
    var sort = req.query.sort === 'price_asc' ? { finalPriceHTG: 1 } :
               req.query.sort === 'price_desc' ? { finalPriceHTG: -1 } :
               req.query.sort === 'newest' ? { createdAt: -1 } :
               { orderCount: -1 };

    var products = await InternationalProduct.find(query)
      .populate('store', 'name country logo supplierType')
      .sort(sort).skip(skip).limit(limit);
    var total = await InternationalProduct.countDocuments(query);

    res.json({ success: true, data: products, pagination: { page, limit, total } });
  } catch (err) {
    console.error('Browse products error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PUBLIC: Get Single Product ───
router.get('/products/:id', async (req, res) => {
  try {
    var product = await InternationalProduct.findById(req.params.id).populate('store', 'name country logo estimatedDeliveryDays');
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
    res.json({ success: true, data: product });
  } catch (err) {
    console.error('International product error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── CUSTOMER: Place Order ───
router.post('/orders', protect, [
  body('storeId').notEmpty().withMessage('Store required'),
  body('items').isArray({ min: 1 }).withMessage('At least one item required'),
  body('items.*.productId').notEmpty().withMessage('Product ID required'),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
  body('paymentMethod').isIn(['moncash', 'natcash', 'bank_transfer', 'zelle', 'stripe', 'wire_transfer', 'credit_card', 'debit_card']).withMessage('Invalid payment method'),
  body('deliveryAddress.street').notEmpty().withMessage('Delivery address required'),
  body('deliveryAddress.city').notEmpty().withMessage('City required'),
  body('deliveryAddress.phone').notEmpty().withMessage('Phone required')
], async (req, res) => {
  var errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    var store = await InternationalStore.findById(req.body.storeId);
    if (!store) return res.status(404).json({ success: false, message: 'Store not found' });

    var productIds = req.body.items.map(function(i) { return i.productId; });
    var products = await InternationalProduct.find({ _id: { $in: productIds }, store: store._id, isActive: true });
    var productMap = {};
    products.forEach(function(p) { productMap[p._id.toString()] = p; });

    var orderItems = [];
    var totalHTG = 0;

    for (var i = 0; i < req.body.items.length; i++) {
      var item = req.body.items[i];
      var product = productMap[item.productId];
      if (!product) return res.status(400).json({ success: false, message: 'Product not found: ' + item.productId });
      if (!product.inStock) return res.status(400).json({ success: false, message: 'Out of stock: ' + product.name });

      var subtotal = Math.round(product.finalPriceHTG * item.quantity);
      orderItems.push({
        product: product._id,
        name: product.name,
        sourcePrice: product.sourcePrice,
        sourceCurrency: product.sourceCurrency,
        finalPriceHTG: product.finalPriceHTG,
        quantity: item.quantity,
        subtotalHTG: subtotal,
        image: product.images.length > 0 ? product.images[0] : ''
      });
      totalHTG += subtotal;
    }

    var needsManualVerification = ['bank_transfer', 'zelle', 'wire_transfer'].includes(req.body.paymentMethod);

    var order = await InternationalOrder.create({
      customer: req.user._id,
      store: store._id,
      country: store.country,
      supplierType: store.supplierType || 'MANUAL',
      items: orderItems,
      totalHTG: totalHTG,
      paymentMethod: req.body.paymentMethod,
      paymentVerification: {
        status: needsManualVerification ? 'pending' : 'pending'
      },
      deliveryAddress: req.body.deliveryAddress,
      estimatedDelivery: new Date(Date.now() + store.estimatedDeliveryDays * 24 * 60 * 60 * 1000),
      statusHistory: [{ status: 'submitted', note: 'Order placed' }]
    });

    // Update product order counts
    for (var j = 0; j < orderItems.length; j++) {
      await InternationalProduct.findByIdAndUpdate(orderItems[j].product, { $inc: { orderCount: orderItems[j].quantity } });
    }
    await InternationalStore.findByIdAndUpdate(store._id, {
      $inc: { 'stats.totalOrders': 1, 'stats.totalRevenue': totalHTG }
    });

    // Emit real-time event
    if (req.app.get('io')) {
      req.app.get('io').emit('international_order', { orderId: order._id, orderNumber: order.orderNumber });
    }

    res.status(201).json({ success: true, data: order });
  } catch (err) {
    console.error('International order error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── CUSTOMER: Upload Payment Receipt ───
router.post('/orders/:id/payment-receipt', protect, upload.single('receipt'), [
  body('transactionRef').optional().trim()
], async (req, res) => {
  try {
    var order = await InternationalOrder.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.customer.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    order.paymentVerification.status = 'submitted';
    if (req.file) order.paymentVerification.receiptImage = '/uploads/' + req.file.filename;
    if (req.body.transactionRef) order.paymentVerification.transactionRef = req.body.transactionRef;
    order.status = 'payment_received';
    order.statusHistory.push({ status: 'payment_received', note: 'Payment receipt uploaded' });
    await order.save();

    if (req.app.get('io')) {
      req.app.get('io').emit('payment_receipt_uploaded', { orderId: order._id, orderNumber: order.orderNumber });
    }

    res.json({ success: true, data: order });
  } catch (err) {
    console.error('Payment receipt upload error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── CUSTOMER: My International Orders ───
router.get('/orders/mine', protect, async (req, res) => {
  try {
    var page = parseInt(req.query.page) || 1;
    var limit = parseInt(req.query.limit) || 20;
    var skip = (page - 1) * limit;

    var query = { customer: req.user._id };
    if (req.query.status) query.status = req.query.status;

    var orders = await InternationalOrder.find(query)
      .populate('store', 'name country logo')
      .sort({ createdAt: -1 }).skip(skip).limit(limit);
    var total = await InternationalOrder.countDocuments(query);

    res.json({ success: true, data: orders, pagination: { page, limit, total } });
  } catch (err) {
    console.error('My international orders error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── CUSTOMER: Get Order Detail ───
router.get('/orders/:id', protect, async (req, res) => {
  try {
    var order = await InternationalOrder.findById(req.params.id)
      .populate('store', 'name country logo')
      .populate('customer', 'firstName lastName phone');

    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    if (order.customer._id.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    res.json({ success: true, data: order });
  } catch (err) {
    console.error('International order detail error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── ADMIN: Add Store ───
router.post('/admin/stores', protect, authorize('admin'), [
  body('name').notEmpty().withMessage('Store name required'),
  body('country').isIn(['DO', 'PA', 'US', 'HT']).withMessage('Invalid country')
], async (req, res) => {
  var errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    var store = await InternationalStore.create(req.body);
    res.status(201).json({ success: true, data: store });
  } catch (err) {
    console.error('Admin add store error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── ADMIN: Update Store ───
router.put('/admin/stores/:id', protect, authorize('admin'), async (req, res) => {
  try {
    var store = await InternationalStore.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!store) return res.status(404).json({ success: false, message: 'Store not found' });
    res.json({ success: true, data: store });
  } catch (err) {
    console.error('Admin update store error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── ADMIN: Add Product ───
router.post('/admin/products', protect, authorize('admin'), [
  body('store').notEmpty().withMessage('Store required'),
  body('name').notEmpty().withMessage('Product name required'),
  body('sourcePrice').isNumeric().withMessage('Source price required'),
  body('sourceCurrency').isIn(['USD', 'DOP', 'PAB']).withMessage('Invalid currency')
], async (req, res) => {
  var errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    var store = await InternationalStore.findById(req.body.store);
    if (!store) return res.status(404).json({ success: false, message: 'Store not found' });

    // Calculate final HTG price
    var exchangeRate = parseFloat(req.body.exchangeRate) || 1;
    var baseHTG = Math.round(req.body.sourcePrice * exchangeRate);
    var serviceFee = Math.round(baseHTG * (store.serviceFeePercent / 100));
    var logisticsFee = store.logisticsFeeHTG || 0;
    var customsDuty = Math.round(baseHTG * (store.customsDutyPercent / 100));

    if (req.body.serviceFee !== undefined) serviceFee = parseInt(req.body.serviceFee);
    if (req.body.logisticsFee !== undefined) logisticsFee = parseInt(req.body.logisticsFee);
    if (req.body.customsDuty !== undefined) customsDuty = parseInt(req.body.customsDuty);

    var finalPriceHTG = req.body.finalPriceHTG ? parseInt(req.body.finalPriceHTG) : (baseHTG + serviceFee + logisticsFee + customsDuty);

    var product = await InternationalProduct.create({
      store: store._id,
      name: req.body.name,
      description: req.body.description || '',
      category: req.body.category || 'General',
      images: req.body.images || [],
      sourcePrice: req.body.sourcePrice,
      sourceCurrency: req.body.sourceCurrency,
      exchangeRate: exchangeRate,
      serviceFee: serviceFee,
      logisticsFee: logisticsFee,
      customsDuty: customsDuty,
      finalPriceHTG: finalPriceHTG,
      estimatedDeliveryDays: req.body.estimatedDeliveryDays || store.estimatedDeliveryDays
    });

    await InternationalStore.findByIdAndUpdate(store._id, { $inc: { 'stats.totalProducts': 1 } });
    res.status(201).json({ success: true, data: product });
  } catch (err) {
    console.error('Admin add product error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── ADMIN: Update Product ───
router.put('/admin/products/:id', protect, authorize('admin'), async (req, res) => {
  try {
    var product = await InternationalProduct.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!product) return res.status(404).json({ success: false, message: 'Product not found' });
    res.json({ success: true, data: product });
  } catch (err) {
    console.error('Admin update product error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── ADMIN: CSV Import Products ───
router.post('/admin/stores/:storeId/import', protect, authorize('admin'), upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ success: false, message: 'No file uploaded' });

    var store = await InternationalStore.findById(req.params.storeId);
    if (!store) return res.status(404).json({ success: false, message: 'Store not found' });

    var XLSX = require('xlsx');
    var workbook = XLSX.readFile(req.file.path);
    var sheet = workbook.Sheets[workbook.SheetNames[0]];
    var rows = XLSX.utils.sheet_to_json(sheet);

    var imported = 0;
    var errors = [];

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      try {
        if (!row.name || !row.sourcePrice) {
          errors.push('Row ' + (i + 2) + ': Missing name or price');
          continue;
        }

        var exchangeRate = parseFloat(row.exchangeRate) || 1;
        var baseHTG = Math.round(parseFloat(row.sourcePrice) * exchangeRate);
        var serviceFee = Math.round(baseHTG * (store.serviceFeePercent / 100));
        var logisticsFee = store.logisticsFeeHTG || 0;
        var customsDuty = Math.round(baseHTG * (store.customsDutyPercent / 100));
        var finalPrice = row.finalPriceHTG ? parseInt(row.finalPriceHTG) : (baseHTG + serviceFee + logisticsFee + customsDuty);

        await InternationalProduct.create({
          store: store._id,
          name: row.name,
          description: row.description || '',
          category: row.category || 'General',
          images: row.image ? [row.image] : [],
          sourcePrice: parseFloat(row.sourcePrice),
          sourceCurrency: row.sourceCurrency || 'USD',
          exchangeRate: exchangeRate,
          serviceFee: serviceFee,
          logisticsFee: logisticsFee,
          customsDuty: customsDuty,
          finalPriceHTG: finalPrice,
          estimatedDeliveryDays: parseInt(row.deliveryDays) || store.estimatedDeliveryDays
        });
        imported++;
      } catch (e) {
        errors.push('Row ' + (i + 2) + ': ' + e.message);
      }
    }

    await InternationalStore.findByIdAndUpdate(store._id, { $inc: { 'stats.totalProducts': imported } });
    res.json({ success: true, data: { imported, total: rows.length, errors } });
  } catch (err) {
    console.error('CSV import error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── ADMIN: List All Orders ───
router.get('/admin/orders', protect, authorize('admin'), async (req, res) => {
  try {
    var page = parseInt(req.query.page) || 1;
    var limit = parseInt(req.query.limit) || 50;
    var skip = (page - 1) * limit;

    var query = {};
    if (req.query.status) query.status = req.query.status;
    if (req.query.country) query.country = req.query.country;
    if (req.query.paymentStatus) query['paymentVerification.status'] = req.query.paymentStatus;

    var orders = await InternationalOrder.find(query)
      .populate('store', 'name country')
      .populate('customer', 'firstName lastName phone')
      .sort({ createdAt: -1 }).skip(skip).limit(limit);
    var total = await InternationalOrder.countDocuments(query);

    res.json({ success: true, data: orders, pagination: { page, limit, total } });
  } catch (err) {
    console.error('Admin orders error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── ADMIN: Verify Payment ───
router.patch('/admin/orders/:id/verify-payment', protect, authorize('admin'), [
  body('status').isIn(['approved', 'rejected']).withMessage('Status must be approved or rejected')
], async (req, res) => {
  var errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    var order = await InternationalOrder.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    order.paymentVerification.status = req.body.status;
    order.paymentVerification.reviewedBy = req.user._id;
    order.paymentVerification.reviewedAt = new Date();
    if (req.body.notes) order.paymentVerification.notes = req.body.notes;

    if (req.body.status === 'approved') {
      order.status = 'payment_verified';
      order.statusHistory.push({ status: 'payment_verified', note: 'Payment approved by admin' });
      await order.save();

      // Auto-create CJ order if this is a CJ supplier order
      if (order.supplierType === 'CJ_USA') {
        try {
          await cj.createCJOrder(order);
        } catch (cjErr) {
          console.error('Auto CJ order creation failed:', cjErr.message);
          order.adminNotes = (order.adminNotes || '') + ' | CJ auto-order failed: ' + cjErr.message;
          await order.save();
        }
      }
    } else {
      order.statusHistory.push({ status: order.status, note: 'Payment rejected: ' + (req.body.notes || '') });
      await order.save();
    }

    if (req.app.get('io')) {
      req.app.get('io').emit('payment_verified', { orderId: order._id, status: req.body.status });
    }

    res.json({ success: true, data: order });
  } catch (err) {
    console.error('Verify payment error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── ADMIN: Update Order Status ───
router.patch('/admin/orders/:id/status', protect, authorize('admin'), [
  body('status').isIn(['submitted', 'payment_received', 'payment_verified', 'purchase_authorized', 'purchased', 'pickup', 'shipping', 'delivered', 'completed', 'cancelled', 'refunded']).withMessage('Invalid status')
], async (req, res) => {
  var errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    var order = await InternationalOrder.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    order.status = req.body.status;
    if (req.body.trackingNumber) order.trackingNumber = req.body.trackingNumber;
    if (req.body.note) order.adminNotes = req.body.note;
    if (req.body.status === 'cancelled') order.cancelReason = req.body.note || 'Cancelled by admin';
    order.statusHistory.push({ status: req.body.status, note: req.body.note || '' });
    await order.save();

    if (req.app.get('io')) {
      req.app.get('io').emit('international_order_update', { orderId: order._id, status: req.body.status });
    }

    res.json({ success: true, data: order });
  } catch (err) {
    console.error('Update order status error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── ADMIN: Dashboard Stats ───
router.get('/admin/stats', protect, authorize('admin'), async (req, res) => {
  try {
    var totalStores = await InternationalStore.countDocuments({ isActive: true });
    var totalProducts = await InternationalProduct.countDocuments({ isActive: true });
    var totalOrders = await InternationalOrder.countDocuments();
    var pendingPayments = await InternationalOrder.countDocuments({ 'paymentVerification.status': 'submitted' });

    var revenueAgg = await InternationalOrder.aggregate([
      { $match: { status: { $nin: ['cancelled', 'refunded'] } } },
      { $group: { _id: null, total: { $sum: '$totalHTG' } } }
    ]);
    var totalRevenue = revenueAgg.length > 0 ? revenueAgg[0].total : 0;

    var byCountry = await InternationalOrder.aggregate([
      { $match: { status: { $nin: ['cancelled', 'refunded'] } } },
      { $group: { _id: '$country', orders: { $sum: 1 }, revenue: { $sum: '$totalHTG' } } }
    ]);

    res.json({
      success: true,
      data: { totalStores, totalProducts, totalOrders, pendingPayments, totalRevenue, byCountry }
    });
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
