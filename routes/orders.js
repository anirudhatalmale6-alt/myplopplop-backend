const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const Order = require('../models/Order');
const Store = require('../models/Store');
const Product = require('../models/Product');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { protect, authorize } = require('../middleware/auth');
const { calculateFare } = require('../utils/fareCalculator');

// ─── PLACE ORDER ───
router.post('/', protect, [
  body('storeId').notEmpty().withMessage('Store is required'),
  body('items').isArray({ min: 1 }).withMessage('At least one item required'),
  body('paymentMethod').isIn(['moncash', 'natcash', 'wallet', 'card']).withMessage('Invalid payment method')
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
      // Check sufficient stock (stockQuantity -1 means unlimited)
      if (product.stockQuantity >= 0 && product.stockQuantity < qty) {
        return res.status(400).json({ success: false, message: product.name + ' - only ' + product.stockQuantity + ' left in stock' });
      }
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
      if (product.stockQuantity >= 0) {
        product.stockQuantity -= qty;
        if (product.stockQuantity <= 0) product.inStock = false;
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

      // Checkout quotes a distance-based delivery price from the customer's GPS
      // pin (POST /api/rides/quote) and charges exactly that at the gateway. The
      // order used to record the store's flat fee instead - usually 0 - so the
      // customer paid for a delivery the books said was free and the rider's 80%
      // was calculated from nothing. Take the quoted figure, capped at what a
      // 30 km delivery costs so a tampered page cannot invent a payout.
      var quoted = Math.round(Number(req.body.deliveryFee));
      if (isFinite(quoted) && quoted > deliveryFee) {
        var ceiling = calculateFare('delivery', 30).totalFare;
        deliveryFee = Math.min(quoted, ceiling);
      }
    }

    // 5% service fee, the same one checkout shows and charges. Computed here
    // rather than trusted from the page.
    var serviceFee = Math.round(subtotal * 0.05);

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

    var total = subtotal + deliveryFee + serviceFee + diasporaFee;

    /* 🛑 15 Oct 2026: the old customer-referral bonus is SWITCHED OFF.
       It credited 10% of the merchant commission straight into the referrer's
       WALLET the moment an order was PLACED - before any payment - and wallet
       balance can pay for orders instantly. Unpaid orders therefore minted
       spendable money. It never paid anybody (no user had referredBy set).
       Agent commissions come from the Koutye engine, on PAID orders only
       (routes/payments.js). Jeffery: no commission on unpaid orders. */
    var referralBonus = 0;
    var customer = await User.findById(req.user._id);

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
      serviceFee: serviceFee,
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

    // Emit real-time notification to merchant
    var io = req.app.get('io');
    if (io) {
      io.to('store_' + store._id).emit('new_order', {
        orderId: order._id,
        orderNumber: order.orderNumber,
        total: order.total,
        itemCount: orderItems.length
      });
    }

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
      // Shared with the delivery driver's own "delivered", so the money moves
      // the same way whichever end closes the order. See services/completeOrder.
      await require('../services/completeOrder').markOrderDelivered(order);
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

    // Emit real-time status update
    var io = req.app.get('io');
    if (io) {
      io.to('order_' + order._id).emit('order_status_update', {
        orderId: order._id,
        status: order.status,
        updatedAt: new Date()
      });
      io.to('store_' + order.store).emit('order_status_update', {
        orderId: order._id,
        status: order.status
      });
    }

    // AUTOMATIC DISPATCH: the moment the store marks a delivery order "ready",
    // create a delivery ride and offer it to the nearest driver — no button, no staff.
    if (req.body.status === 'ready' && order.deliveryType === 'delivery' && !order.rideId) {
      try {
        var deliveryDispatch = require('../services/deliveryDispatch');
        deliveryDispatch.createDeliveryRideForOrder(order, store, io).catch(function (e) {
          console.error('Auto-dispatch error:', e.message);
        });
      } catch (dispErr) {
        console.error('Auto-dispatch load error:', dispErr.message);
      }
    }

    res.json({ success: true, data: order });
  } catch (err) {
    console.error('Update order status error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── ASSIGN RIDER TO ORDER ───
/* 🛑 15 Oct 2026: ADMIN ONLY, and only to an approved driver.
   It used to accept ANY merchant, without checking that the order belonged to
   that merchant's shop - and anyone becomes a merchant by opening a shop. A
   stranger could make himself the "rider" on somebody else's order, read the
   customer's phone and address, mark it delivered and be credited the
   driver's 80% (services/completeOrder.js). No page calls this route; drivers
   are assigned by dispatch (services/deliveryDispatch.js). */
router.put('/:id/assign-rider', protect, authorize('admin'), async function(req, res) {
  try {
    var order = await Order.findById(req.params.id);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    var rider = await User.findById(req.body.riderId).select('role isActive');
    if (!rider || rider.role !== 'driver' || rider.isActive === false) {
      return res.status(400).json({ success: false, message: 'That user is not an active driver' });
    }
    var DriverProfile = require('../models/DriverProfile');
    var dp = await DriverProfile.findOne({ user: rider._id }).select('status');
    if (!dp || dp.status !== 'approved') {
      return res.status(400).json({ success: false, message: 'That driver is not approved' });
    }

    order.rider = rider._id;
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
