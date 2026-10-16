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
  /* 16 Oct 2026: one release routine for the timer and this button
     (services/orderLifecycle.releaseMatured). This used to read-modify-save,
     so a click while the timer ran could release the same order twice. */
  try {
    var out = await require('../services/orderLifecycle').releaseMatured(new Date());
    res.json({ success: true, released: out.shops, drivers: out.drivers, message: out.shops + ' orders released to available balance' });
  } catch (err) {
    console.error('Release payouts error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET VENDOR WALLET SUMMARY ───
router.get('/wallet', protect, authorize('merchant', 'driver'), async function(req, res) {
  try {
    var user = await User.findById(req.user._id);

    // Drivers have no stores; their earnings land in wallet.balance directly.
    if (req.user.role === 'driver') {
      var driverPayouts = await Transaction.find({ user: req.user._id, type: 'withdrawal' })
        .sort('-createdAt').limit(10);
      var earned = await Transaction.aggregate([
        { $match: { user: user._id, type: 'earning' } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
      ]);
      return res.json({
        success: true,
        data: {
          balance: user.wallet.balance,
          pending_balance: user.wallet.pending_balance,
          available_balance: user.wallet.balance, // what a driver can actually withdraw
          currency: user.wallet.currency,
          lifetime_earned: (earned[0] && earned[0].total) || 0,
          earning_count: (earned[0] && earned[0].count) || 0,
          pending_orders: 0,
          available_orders: 0,
          recent_payouts: driverPayouts
        }
      });
    }

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

// ─── REQUEST PAYOUT (merchant or driver) ───
// Merchants are paid from available_balance (order money released after review).
// Drivers are credited straight to balance when a delivery completes, so they
// draw from there. The bucket is recorded so a rejection refunds the right one.
router.post('/request', protect, authorize('merchant', 'driver'), async function(req, res) {
  try {
    var user = await User.findById(req.user._id);
    var minPayout = 500; // 500 HTG minimum
    var bucket = req.user.role === 'driver' ? 'balance' : 'available_balance';
    var funds = user.wallet[bucket] || 0;

    if (funds < minPayout) {
      return res.status(400).json({
        success: false,
        message: 'Balans minimòm ' + minPayout + ' HTG pou mande peman. Balans disponib: ' + funds + ' HTG'
      });
    }

    var amount = Math.floor(Number(req.body.amount) || funds);
    if (amount > funds) {
      amount = funds;
    }
    if (amount < minPayout) {
      return res.status(400).json({ success: false, message: 'Montan minimòm: ' + minPayout + ' HTG' });
    }

    var method = req.body.method || 'moncash';
    var recipient = (req.body.recipient || user.phone || '').toString().trim();

    // Hold the money out of the wallet while the request is pending.
    // 16 Oct 2026: ONE conditional update - two taps at once used to both read
    // the same balance and both create a withdrawal for it.
    var held = await User.findOneAndUpdate({ _id: req.user._id, ['wallet.' + bucket]: { $gte: amount } },
      { $inc: { ['wallet.' + bucket]: -amount } }, { new: true });
    if (!held) return res.status(409).json({ success: false, message: 'Balans lan chanje. Rechaje paj la.' });

    var transaction = await Transaction.create({
      user: req.user._id,
      type: 'withdrawal',
      amount: amount,
      currency: 'HTG',
      method: method,
      status: 'pending',
      sourceBucket: bucket,
      recipient: recipient,
      description: 'Payout request via ' + method + (recipient ? ' to ' + recipient : '')
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
    /* 16 Oct 2026: only a PENDING request can be decided, once. Rejecting
       twice used to put the money back twice. */
    if (action === 'approve') {
      var ref = String(req.body.reference || '').trim();
      if (ref.length < 4) return res.status(400).json({ success: false, message: 'Enter the MonCash/NatCash transfer reference.' });
      transaction = await Transaction.findOneAndUpdate({ _id: transaction._id, type: 'withdrawal', status: 'pending' },
        { $set: { status: 'completed', reference: ref } }, { new: true });
    } else if (action === 'reject') {
      transaction = await Transaction.findOneAndUpdate({ _id: transaction._id, type: 'withdrawal', status: 'pending' },
        { $set: { status: 'failed' } }, { new: true });
      if (transaction) {
        var bucket = transaction.sourceBucket || 'available_balance';
        await User.updateOne({ _id: transaction.user }, { $inc: { ['wallet.' + bucket]: transaction.amount } });
      }
    } else {
      return res.status(400).json({ success: false, message: 'action must be approve or reject' });
    }
    if (!transaction) return res.status(409).json({ success: false, message: 'This payout was already decided.' });
    try {
      await require('../models/ActivityLog').create({ actor: req.user._id, actorName: req.user.name, actorRole: req.user.role,
        action: 'payout.' + action, targetType: 'Transaction', targetId: transaction._id,
        detail: { amount: transaction.amount, reference: transaction.reference || '', user: String(transaction.user) } });
    } catch (e) {}

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
