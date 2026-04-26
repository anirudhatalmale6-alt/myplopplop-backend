const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const User = require('../models/User');
const Store = require('../models/Store');
const Transaction = require('../models/Transaction');
const { protect, authorize } = require('../middleware/auth');

// ─── RELEASE ELIGIBLE PAYOUTS (cron/admin trigger) ───
// Moves funds from pending_balance to available_balance for delivered orders past hold period
router.post('/release', protect, authorize('admin'), async function(req, res) {
  try {
    var now = new Date();
    var orders = await Order.find({
      payoutStatus: 'pending',
      payoutAvailableAt: { $lte: now },
      status: 'delivered',
      paymentStatus: 'paid'
    }).populate('store');

    var released = 0;
    for (var i = 0; i < orders.length; i++) {
      var order = orders[i];
      var merchant = await User.findById(order.store.owner);
      if (!merchant) continue;

      merchant.wallet.pending_balance -= order.merchantEarning;
      if (merchant.wallet.pending_balance < 0) merchant.wallet.pending_balance = 0;
      merchant.wallet.available_balance += order.merchantEarning;
      await merchant.save();

      order.payoutStatus = 'available';
      await order.save();
      released++;
    }

    res.json({ success: true, released: released, message: released + ' orders released to available balance' });
  } catch (err) {
    console.error('Release payouts error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET VENDOR WALLET SUMMARY ───
router.get('/wallet', protect, authorize('merchant'), async function(req, res) {
  try {
    var user = await User.findById(req.user._id);
    var stores = await Store.find({ owner: req.user._id });
    var storeIds = stores.map(function(s) { return s._id; });

    var pendingOrders = await Order.countDocuments({
      store: { $in: storeIds },
      payoutStatus: 'pending'
    });
    var availableOrders = await Order.countDocuments({
      store: { $in: storeIds },
      payoutStatus: 'available'
    });

    var recentPayouts = await Transaction.find({
      user: req.user._id,
      type: 'withdrawal',
    }).sort('-createdAt').limit(10);

    res.json({
      success: true,
      data: {
        balance: user.wallet.balance,
        pending_balance: user.wallet.pending_balance,
        available_balance: user.wallet.available_balance,
        currency: user.wallet.currency,
        pending_orders: pendingOrders,
        available_orders: availableOrders,
        recent_payouts: recentPayouts
      }
    });
  } catch (err) {
    console.error('Vendor wallet error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── REQUEST PAYOUT (vendor) ───
router.post('/request', protect, authorize('merchant'), async function(req, res) {
  try {
    var user = await User.findById(req.user._id);
    var minPayout = 500; // 500 HTG minimum

    if (user.wallet.available_balance < minPayout) {
      return res.status(400).json({
        success: false,
        message: 'Balans minimòm ' + minPayout + ' HTG pou mande peman. Balans disponib: ' + user.wallet.available_balance + ' HTG'
      });
    }

    var amount = req.body.amount || user.wallet.available_balance;
    if (amount > user.wallet.available_balance) {
      amount = user.wallet.available_balance;
    }
    if (amount < minPayout) {
      return res.status(400).json({ success: false, message: 'Montan minimòm: ' + minPayout + ' HTG' });
    }

    var method = req.body.method || 'moncash';

    // Deduct from available, move to main balance as "processing"
    user.wallet.available_balance -= amount;
    await user.save();

    var transaction = await Transaction.create({
      user: req.user._id,
      type: 'withdrawal',
      amount: amount,
      currency: 'HTG',
      method: method,
      status: 'pending',
      description: 'Payout request via ' + method
    });

    res.status(201).json({
      success: true,
      data: {
        transaction_id: transaction._id,
        amount: amount,
        method: method,
        status: 'pending',
        message: 'Demann peman soumèt. Peman ap trete nan 24-48h.'
      }
    });
  } catch (err) {
    console.error('Payout request error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── ADMIN: PROCESS PAYOUT ───
router.put('/process/:transactionId', protect, authorize('admin'), async function(req, res) {
  try {
    var transaction = await Transaction.findById(req.params.transactionId);
    if (!transaction || transaction.type !== 'withdrawal') {
      return res.status(404).json({ success: false, message: 'Payout not found' });
    }

    var action = req.body.action; // 'approve' or 'reject'
    if (action === 'approve') {
      transaction.status = 'completed';
      transaction.reference = req.body.reference || '';
      await transaction.save();
    } else if (action === 'reject') {
      transaction.status = 'failed';
      await transaction.save();
      // Refund to available_balance
      var user = await User.findById(transaction.user);
      if (user) {
        user.wallet.available_balance += transaction.amount;
        await user.save();
      }
    }

    res.json({ success: true, data: transaction });
  } catch (err) {
    console.error('Process payout error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── ADMIN: HOLD A PAYOUT ───
router.put('/hold/:orderId', protect, authorize('admin'), async function(req, res) {
  try {
    var order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

    order.payoutStatus = 'held';
    order.payoutAvailableAt = null;
    await order.save();

    res.json({ success: true, message: 'Payout held for manual review', data: order });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── ADMIN: PAYOUT DASHBOARD ───
router.get('/admin/summary', protect, authorize('admin'), async function(req, res) {
  try {
    var totalCollected = await Order.aggregate([
      { $match: { paymentStatus: 'paid' } },
      { $group: { _id: null, total: { $sum: '$total' }, commission: { $sum: '$commission' }, diaspora: { $sum: '$diasporaFee' }, deliveryPlatform: { $sum: '$deliveryPlatformCut' } } }
    ]);

    var pendingPayouts = await Order.aggregate([
      { $match: { payoutStatus: 'pending' } },
      { $group: { _id: null, total: { $sum: '$merchantEarning' }, count: { $sum: 1 } } }
    ]);

    var availablePayouts = await Order.aggregate([
      { $match: { payoutStatus: 'available' } },
      { $group: { _id: null, total: { $sum: '$merchantEarning' }, count: { $sum: 1 } } }
    ]);

    var completedPayouts = await Transaction.aggregate([
      { $match: { type: 'withdrawal', status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);

    var pendingWithdrawals = await Transaction.find({
      type: 'withdrawal', status: 'pending'
    }).populate('user', 'name phone').sort('-createdAt').limit(20);

    res.json({
      success: true,
      data: {
        total_collected: totalCollected[0] || { total: 0, commission: 0, diaspora: 0, deliveryPlatform: 0 },
        pending_payouts: pendingPayouts[0] || { total: 0, count: 0 },
        available_payouts: availablePayouts[0] || { total: 0, count: 0 },
        completed_payouts: completedPayouts[0] || { total: 0, count: 0 },
        pending_withdrawals: pendingWithdrawals
      }
    });
  } catch (err) {
    console.error('Admin payout summary error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── ADMIN: VENDOR BALANCES LIST ───
router.get('/admin/vendors', protect, authorize('admin'), async function(req, res) {
  try {
    var merchants = await User.find({ role: 'merchant' })
      .select('name phone wallet')
      .sort('-wallet.available_balance');

    res.json({ success: true, data: merchants });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
