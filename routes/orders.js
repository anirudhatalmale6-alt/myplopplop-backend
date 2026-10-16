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
const marketFees = require('../utils/marketFees');
const lifecycle = require('../services/orderLifecycle');

/* What each party may see of an order (16 Oct 2026). The delivery code goes
   ONLY to the customer (and an admin): the shop and the driver must get it
   from the customer at the door, or it proves nothing. */
function publicOrder(order, role) {
  var o = order && order.toObject ? order.toObject() : Object.assign({}, order);
  if (role !== 'customer' && role !== 'admin') delete o.deliveryPin;
  delete o.pinAttempts;
  return o;
}

// ─── PLACE ORDER ───
/* The fee the pages must display, from the one place the server charges it.
   Public: it is the price list, not anybody's data. */
router.get('/fees', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.json({ success: true, serviceFeePct: marketFees.serviceFeePct() });
});

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

    // The buyer's service fee (5% today; utils/marketFees.js), the same one
    // checkout shows and charges. Computed here rather than trusted from the page.
    var serviceFee = marketFees.serviceFeeFor(subtotal);

    // The SELLER fee, taken from the merchant's settlement (utils/marketFees.js).
    // With no pricing setting it is exactly the old store.commissionRate rule.
    var sellerFee = marketFees.sellerFeeFor(store, subtotal);
    var commissionRate = sellerFee.pct;
    var commission = sellerFee.fee;
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

    // Wallet payment: taken in ONE conditional update, so two orders placed at
    // the same moment cannot both spend the same balance (16 Oct 2026).
    if (req.body.paymentMethod === 'wallet') {
      var debited = await User.findOneAndUpdate(
        { _id: req.user._id, 'wallet.balance': { $gte: total } },
        { $inc: { 'wallet.balance': -total } });
      if (!debited) {
        return res.status(400).json({ success: false, message: 'Insufficient wallet balance' });
      }
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
      sellerFeePct: commissionRate,
      sellerFeeRule: sellerFee.rule,
      diasporaFee: diasporaFee,
      total: total,
      merchantEarning: merchantEarning,
      riderEarning: deliveryDriverCut,
      deliveryPlatformCut: deliveryPlatformCut,
      deliveryDriverCut: deliveryDriverCut,
      paymentMethod: req.body.paymentMethod,
      // ALWAYS pending here: "paid" is set only by services/orderLifecycle
      // confirmPayment (the gateway's answer, or the wallet debit above).
      paymentStatus: 'pending',
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
      status: 'pending',
      reference: order.orderNumber,
      order: order._id,
      description: 'Order from ' + store.name
    });

    /* 16 Oct 2026: the shop is NOT alerted here and the sale is NOT counted:
       an unpaid order is not an order yet. Both happen when the payment is
       confirmed (services/orderLifecycle.js). Revenue is counted on delivery. */
    store.stats.totalOrders += 1;
    await store.save();

    var io = req.app.get('io');
    if (req.body.paymentMethod === 'wallet') {
      // the money already left the wallet above: confirm it like any payment
      await lifecycle.confirmPayment(order, { status: true, trans_status: 'ok', montant: total, method: 'wallet' }, { io: io, source: 'wallet' });
      order = await Order.findById(order._id);
    }

    await order.populate('store', 'name logo phone');

    res.status(201).json({ success: true, data: publicOrder(order, 'customer') });
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

    res.json({ success: true, data: publicOrder(order, isCustomer ? 'customer' : isAdmin ? 'admin' : 'other') });
  } catch (err) {
    console.error('Get order error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── UPDATE ORDER STATUS (merchant/rider/admin) ───
/* 16 Oct 2026: every status change goes through services/orderLifecycle.js.
   - confirmed / preparing / ready: the SHOP, one step at a time, PAID orders only
   - cancelled: customer (before preparing), shop (before pickup), admin
     (before delivery); a paid order opens a refund for an admin to approve
   - picked_up / delivered: NOT here. Pickup is confirmed by the shop with the
     driver's pickup code (POST /:id/handover); delivery needs the customer's
     code (driver: PUT /api/rides/:id/status; pickup orders: POST
     /:id/complete-pickup) or an admin exception (POST /:id/admin-complete). */
router.put('/:id/status', protect, [
  body('status').isIn(['confirmed', 'preparing', 'ready', 'picked_up', 'delivering', 'delivered', 'cancelled'])
], async function(req, res) {
  try {
    var errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });
    var order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    var store = await Store.findById(order.store);
    var isMerchant = store && store.owner.toString() === req.user._id.toString();
    var isAdmin = req.user.role === 'admin';
    var isCustomer = order.customer.toString() === req.user._id.toString();
    var to = req.body.status;
    var io = req.app.get('io');
    var out;

    if (to === 'cancelled') {
      var role = isAdmin ? 'admin' : isMerchant ? 'merchant' : isCustomer ? 'customer' : null;
      if (!role) return res.status(403).json({ success: false, message: 'Not authorized' });
      out = await lifecycle.cancelOrder(order, { role: role, reason: req.body.reason, actor: req.user, io: io });
    } else if (to === 'confirmed' || to === 'preparing' || to === 'ready') {
      if (!isMerchant && !isAdmin) return res.status(403).json({ success: false, message: 'Not authorized' });
      out = await lifecycle.merchantAdvance(order, to, req.user, io);
    } else {
      return res.status(409).json({ success: false, message: to === 'delivered'
        ? 'Delivery is completed with the customer\'s 4-digit code, not from here.'
        : 'Pickup is confirmed by the shop with the driver\'s pickup code.' });
    }
    if (!out.ok) return res.status(out.code || 409).json({ success: false, message: out.message });
    if (io) {
      io.to('store_' + out.order.store).emit('order_status_update', { orderId: out.order._id, status: out.order.status });
    }
    res.json({ success: true, data: publicOrder(out.order, isCustomer ? 'customer' : isAdmin ? 'admin' : 'other'), refund: out.refund ? { id: out.refund._id, amount: out.refund.amount, status: out.refund.status } : undefined });
  } catch (err) {
    console.error('Update order status error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ─── ONE PAYMENT FOR A BASKET OF SEVERAL SHOPS (16 Oct 2026) ───
   Checkout creates one order per shop, then calls this with their ids. They
   all get the same paymentGroup (the first order's number), which is the
   reference the customer pays under, so confirming that payment confirms
   every shop's order. Only the customer's own unpaid orders, placed within
   the last hour. */
router.post('/basket', protect, async function(req, res) {
  try {
    var ids = Array.isArray(req.body && req.body.orderIds) ? req.body.orderIds.slice(0, 20) : [];
    if (!ids.length) return res.status(400).json({ success: false, message: 'orderIds required' });
    var orders = await Order.find({ _id: { $in: ids }, customer: req.user._id, paymentStatus: 'pending', status: 'pending',
      createdAt: { $gte: new Date(Date.now() - 3600 * 1000) } }).sort({ createdAt: 1 });
    if (orders.length !== ids.length) return res.status(400).json({ success: false, message: 'Some orders cannot be grouped (not yours, already paid, or too old)' });
    var group = orders[0].orderNumber;
    await Order.updateMany({ _id: { $in: orders.map(function (o) { return o._id; }) } }, { $set: { paymentGroup: group } });
    var total = orders.reduce(function (t, o) { return t + (Number(o.total) || 0); }, 0);
    res.json({ success: true, data: { paymentRef: group, total: total, orders: orders.length } });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ─── PICKUP VERIFICATION: the shop types the driver's pickup code ───
   The code is shown only to the driver who accepted the delivery, so the
   wrong driver cannot collect the parcel. Records the time and the driver's
   last known position. */
router.post('/:id/handover', protect, async function(req, res) {
  try {
    var order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    var store = await Store.findById(order.store);
    if (!store || String(store.owner) !== String(req.user._id)) return res.status(403).json({ success: false, message: 'Not authorized' });
    if (order.status !== 'ready' || !order.rideId) return res.status(409).json({ success: false, message: 'There is no driver collecting this order yet.' });
    var Ride = require('../models/Ride');
    var ride = await Ride.findById(order.rideId);
    if (!ride || !ride.driver || ['accepted', 'picking_up'].indexOf(ride.status) === -1) return res.status(409).json({ success: false, message: 'No driver has accepted this delivery yet.' });
    if (!ride.pickupCode || String(req.body.code || '').trim() !== String(ride.pickupCode)) {
      return res.status(400).json({ success: false, message: 'Wrong pickup code. Ask the driver to show the code in their app.' });
    }
    var DriverProfile = require('../models/DriverProfile');
    var dp = await DriverProfile.findOne({ user: ride.driver }).select('currentLocation status');
    if (!dp || dp.status !== 'approved') return res.status(409).json({ success: false, message: 'This driver is not approved. Do not hand over the order.' });
    var now = new Date();
    var r = await Ride.findOneAndUpdate({ _id: ride._id, status: { $in: ['accepted', 'picking_up'] }, pickupVerifiedAt: null },
      { $set: { status: 'in_progress', pickedUpAt: now, pickupVerifiedAt: now, pickupLocation: dp.currentLocation && dp.currentLocation.coordinates ? { type: 'Point', coordinates: dp.currentLocation.coordinates } : undefined } }, { new: true });
    if (!r) return res.status(409).json({ success: false, message: 'Already handed over.' });
    var o2 = await Order.findOneAndUpdate({ _id: order._id, status: 'ready' }, { $set: { status: 'picked_up', pickedUpAt: now } }, { new: true });
    await lifecycle.log(req.user, 'order.picked_up', o2 || order, { driver: ride.driver, verified: 'pickup_code' });
    require('./notifications').sendPushToUser(order.customer, 'Kòmand #' + order.orderNumber + ' an wout', 'Chofè a pran kòmand ou. Prepare kòd livrezon ou an.', { url: '/order-status.html?id=' + order._id }).catch(function () {});
    res.json({ success: true, data: publicOrder(o2 || order, 'other') });
  } catch (err) {
    console.error('Handover error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ─── A PICKUP (customer collects at the shop): the customer's code ─── */
router.post('/:id/complete-pickup', protect, async function(req, res) {
  try {
    var order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    var store = await Store.findById(order.store);
    if (!store || String(store.owner) !== String(req.user._id)) return res.status(403).json({ success: false, message: 'Not authorized' });
    if (order.deliveryType !== 'pickup') return res.status(409).json({ success: false, message: 'A delivery order is completed by the driver with the customer\'s code.' });
    if (order.status !== 'ready') return res.status(409).json({ success: false, message: 'Mark the order ready first.' });
    var pin = await lifecycle.checkPin(order, req.body.pin);
    if (!pin.ok) return res.status(pin.code).json({ success: false, message: pin.message });
    var out = await lifecycle.completeDelivery(order, { via: 'pickup_pin', actor: req.user });
    if (!out.ok) return res.status(out.code).json({ success: false, message: out.message });
    res.json({ success: true, data: publicOrder(out.order, 'other') });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ─── ADMIN EXCEPTION: the customer cannot give the code ───
   Admin only, a written reason, recorded in the audit log with who did it. */
router.post('/:id/admin-complete', protect, authorize('admin'), async function(req, res) {
  try {
    var reason = String((req.body && req.body.reason) || '').trim();
    if (reason.length < 10) return res.status(400).json({ success: false, message: 'Write the reason (at least 10 characters).' });
    var order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    var Ride = require('../models/Ride');
    var ride = order.rideId ? await Ride.findById(order.rideId) : null;
    var out = await lifecycle.completeDelivery(order, { via: 'admin_exception', actor: req.user, reason: reason, ride: ride });
    if (!out.ok) return res.status(out.code).json({ success: false, message: out.message });
    res.json({ success: true, data: publicOrder(out.order, 'admin') });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ─── ADMIN: a refund after delivery (wrong, damaged or missing goods) ─── */
router.post('/:id/refund', protect, authorize('admin'), async function(req, res) {
  try {
    var order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    var out = await lifecycle.openRefundForDelivered(order, req.user, req.body || {});
    if (!out.ok) return res.status(out.code).json({ success: false, message: out.message });
    res.status(201).json({ success: true, data: out.refund });
  } catch (err) {
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
