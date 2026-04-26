const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const Order = require('../models/Order');
const Store = require('../models/Store');
const Product = require('../models/Product');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { protect, authorize } = require('../middleware/auth');

// ─── PLACE ORDER ───
router.post('/', protect, [
  body('storeId').notEmpty().withMessage('Store is required'),
  body('items').isArray({ min: 1 }).withMessage('At least one item required'),
  body('paymentMethod').isIn(['moncash', 'natcash', 'wallet', 'cash']).withMessage('Invalid payment method')
], async function(req, res) {
  try {
    var errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    var store = await Store.findById(req.body.storeId);
    if (!store || store.status !== 'active') {
      return res.status(404).json({ success: false, message: 'Store not found or inactive' });
    }

    // Build order items with current prices
    var orderItems = [];
    var subtotal = 0;

    for (var i = 0; i < req.body.items.length; i++) {
      var item = req.body.items[i];
      var product = await Product.findById(item.productId);
      if (!product || !product.isActive) {
        return res.status(400).json({ success: false, message: 'Product not found: ' + item.productId });
      }
      if (!product.inStock) {
        return res.status(400).json({ success: false, message: product.name + ' is out of stock' });
      }
      var qty = item.quantity || 1;
      var lineTotal = product.price * qty;
      orderItems.push({
        product: product._id,
        name: product.name,
        price: product.price,
        quantity: qty,
        subtotal: lineTotal
      });
      subtotal += lineTotal;

      // Update stock if tracked
      if (product.stockQuantity > 0) {
        product.stockQuantity -= qty;
        if (product.stockQuantity <= 0) product.inStock = false;
        await product.save();
      }
      product.orderCount += qty;
      await product.save();
    }

    var deliveryFee = 0;
    if (req.body.deliveryType === 'delivery') {
      deliveryFee = store.deliveryOptions.deliveryFee || 0;
      if (store.deliveryOptions.freeDeliveryMin > 0 && subtotal >= store.deliveryOptions.freeDeliveryMin) {
        deliveryFee = 0;
      }
    }

    var commissionRate = store.commissionRate || 10;
    var commission = Math.round(subtotal * commissionRate / 100);
    var merchantEarning = subtotal - commission;

    // Diaspora fee: +3-5% on subtotal
    var isDiaspora = req.body.isDiasporaOrder || false;
    var diasporaFee = 0;
    if (isDiaspora) {
      diasporaFee = Math.round(subtotal * 0.03); // 3% diaspora surcharge
    }

    // Delivery split: driver 80%, platform 20%
    var deliveryDriverCut = Math.round(deliveryFee * 0.80);
    var deliveryPlatformCut = deliveryFee - deliveryDriverCut;

    var total = subtotal + deliveryFee + diasporaFee;

    // Referral: 10% of platform commission
    var referralBonus = 0;
    var customer = await User.findById(req.user._id);
    if (customer.referredBy) {
      referralBonus = Math.round(commission * 0.10);
      var referrer = await User.findById(customer.referredBy);
      if (referrer) {
        referrer.wallet.balance += referralBonus;
        referrer.referralEarnings += referralBonus;
        await referrer.save();
        await Transaction.create({
          user: referrer._id,
          type: 'referral',
          amount: referralBonus,
          currency: 'HTG',
          method: 'wallet',
          status: 'completed',
          description: 'Referral bonus: 10% of order commission'
        });
      }
    }

    // Process wallet payment
    if (req.body.paymentMethod === 'wallet') {
      if (customer.wallet.balance < total) {
        return res.status(400).json({ success: false, message: 'Insufficient wallet balance' });
      }
      customer.wallet.balance -= total;
      await customer.save();
    }

    // Payout hold: new vendors get 72h, others get 24h
    var vendorCreated = store.createdAt;
    var isNewVendor = (Date.now() - vendorCreated.getTime()) < 30 * 24 * 60 * 60 * 1000; // < 30 days
    var holdHours = isNewVendor ? 72 : 24;
    if (isDiaspora) holdHours += 24; // extra 24h for diaspora
    var payoutAvailableAt = new Date(Date.now() + holdHours * 60 * 60 * 1000);

    var order = await Order.create({
      customer: req.user._id,
      store: store._id,
      items: orderItems,
      deliveryType: req.body.deliveryType || 'delivery',
      deliveryAddress: req.body.deliveryAddress || {},
      deliveryFee: deliveryFee,
      subtotal: subtotal,
      commission: commission,
      diasporaFee: diasporaFee,
      total: total,
      merchantEarning: merchantEarning,
      riderEarning: deliveryDriverCut,
      deliveryPlatformCut: deliveryPlatformCut,
      deliveryDriverCut: deliveryDriverCut,
      paymentMethod: req.body.paymentMethod,
      paymentStatus: req.body.paymentMethod === 'wallet' ? 'paid' : 'pending',
      payoutStatus: 'held',
      payoutAvailableAt: payoutAvailableAt,
      isDiasporaOrder: isDiaspora,
      recipient: req.body.recipient || null,
      notes: req.body.notes || ''
    });

    // Create transaction
    await Transaction.create({
      user: req.user._id,
      type: 'payment',
      amount: total,
      currency: 'HTG',
      method: req.body.paymentMethod,
      status: req.body.paymentMethod === 'wallet' ? 'completed' : 'pending',
      reference: order.orderNumber,
      description: 'Order from ' + store.name
    });

    // Update store stats
    store.stats.totalOrders += 1;
    store.stats.totalRevenue += merchantEarning;
    await store.save();

    await order.populate('store', 'name logo phone');

    res.status(201).json({ success: true, data: order });
  } catch (err) {
    console.error('Place order error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET MY ORDERS (customer) ───
router.get('/my-orders', protect, async function(req, res) {
  try {
    var page = parseInt(req.query.page) || 1;
    var limit = parseInt(req.query.limit) || 20;

    var orders = await Order.find({ customer: req.user._id })
      .populate('store', 'name logo category')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(limit);

    var total = await Order.countDocuments({ customer: req.user._id });

    res.json({
      success: true,
      data: orders,
      pagination: { page: page, limit: limit, total: total }
    });
  } catch (err) {
    console.error('Get orders error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET ORDER BY ID ───
router.get('/:id', protect, async function(req, res) {
  try {
    var order = await Order.findById(req.params.id)
      .populate('customer', 'name phone')
      .populate('store', 'name logo phone address')
      .populate('rider', 'name phone')
      .populate('items.product', 'name images');

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    // Only customer, store owner, rider, or admin can view
    var isCustomer = order.customer._id.toString() === req.user._id.toString();
    var isRider = order.rider && order.rider._id.toString() === req.user._id.toString();
    var isAdmin = req.user.role === 'admin';
    // Check store ownership
    var store = await Store.findById(order.store._id);
    var isMerchant = store && store.owner.toString() === req.user._id.toString();

    if (!isCustomer && !isRider && !isAdmin && !isMerchant) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    res.json({ success: true, data: order });
  } catch (err) {
    console.error('Get order error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── UPDATE ORDER STATUS (merchant/rider/admin) ───
router.put('/:id/status', protect, [
  body('status').isIn(['confirmed', 'preparing', 'ready', 'picked_up', 'delivering', 'delivered', 'cancelled'])
], async function(req, res) {
  try {
    var order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    var store = await Store.findById(order.store);
    var isMerchant = store && store.owner.toString() === req.user._id.toString();
    var isRider = order.rider && order.rider.toString() === req.user._id.toString();
    var isAdmin = req.user.role === 'admin';
    var isCustomer = order.customer.toString() === req.user._id.toString();

    if (!isMerchant && !isRider && !isAdmin) {
      // Customer can only cancel
      if (isCustomer && req.body.status === 'cancelled') {
        order.status = 'cancelled';
        order.cancelledBy = 'customer';
        order.cancelReason = req.body.reason || '';
        order.cancelledAt = new Date();
        await order.save();
        return res.json({ success: true, data: order });
      }
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    order.status = req.body.status;

    // Set timestamps
    if (req.body.status === 'confirmed') order.confirmedAt = new Date();
    if (req.body.status === 'preparing') order.preparedAt = new Date();
    if (req.body.status === 'picked_up') order.pickedUpAt = new Date();
    if (req.body.status === 'delivered') {
      order.deliveredAt = new Date();
      if (order.paymentStatus === 'paid') {
        // Move to pending_balance (hold → verify → release)
        var merchant = await User.findById(store.owner);
        if (merchant) {
          merchant.wallet.pending_balance += order.merchantEarning;
          await merchant.save();
        }
        order.payoutStatus = 'pending';
        // Credit delivery driver immediately (80%)
        if (order.rider && order.deliveryDriverCut > 0) {
          var driver = await User.findById(order.rider);
          if (driver) {
            driver.wallet.balance += order.deliveryDriverCut;
            await driver.save();
            await Transaction.create({
              user: driver._id,
              type: 'earning',
              amount: order.deliveryDriverCut,
              currency: 'HTG',
              method: 'wallet',
              status: 'completed',
              reference: order.orderNumber,
              description: 'Delivery earning (80%)'
            });
          }
        }
      }
    }
    if (req.body.status === 'cancelled') {
      order.cancelledBy = isMerchant ? 'merchant' : 'system';
      order.cancelReason = req.body.reason || '';
      order.cancelledAt = new Date();
      // Refund if paid
      if (order.paymentStatus === 'paid' && order.paymentMethod === 'wallet') {
        var customer = await User.findById(order.customer);
        if (customer) {
          customer.wallet.balance += order.total;
          await customer.save();
        }
        order.paymentStatus = 'refunded';
      }
    }

    await order.save();

    res.json({ success: true, data: order });
  } catch (err) {
    console.error('Update order status error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── ASSIGN RIDER TO ORDER ───
router.put('/:id/assign-rider', protect, authorize('admin', 'merchant'), async function(req, res) {
  try {
    var order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    order.rider = req.body.riderId;
    await order.save();

    res.json({ success: true, message: 'Rider assigned', data: order });
  } catch (err) {
    console.error('Assign rider error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── RATE ORDER ───
router.post('/:id/rate', protect, [
  body('rating').isInt({ min: 1, max: 5 })
], async function(req, res) {
  try {
    var order = await Order.findById(req.params.id);
    if (!order || order.status !== 'delivered') {
      return res.status(400).json({ success: false, message: 'Can only rate delivered orders' });
    }

    if (order.customer.toString() === req.user._id.toString()) {
      order.customerRating = req.body.rating;
      order.customerReview = req.body.review || '';

      // Update store rating
      var store = await Store.findById(order.store);
      if (store) {
        var newCount = store.rating.count + 1;
        store.rating.average = ((store.rating.average * store.rating.count) + req.body.rating) / newCount;
        store.rating.count = newCount;
        await store.save();
      }
    }

    await order.save();
    res.json({ success: true, message: 'Rating submitted' });
  } catch (err) {
    console.error('Rate order error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
