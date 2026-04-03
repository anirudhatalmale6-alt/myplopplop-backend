const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const Ride = require('../models/Ride');

// MonCash SDK setup
let moncash = null;
function getMoncash() {
  if (!moncash) {
    const Moncash = require('moncash');
    moncash = new Moncash({
      mode: process.env.MONCASH_MODE || 'sandbox',
      clientId: process.env.MONCASH_CLIENT_ID || '',
      clientSecret: process.env.MONCASH_CLIENT_SECRET || ''
    });
  }
  return moncash;
}

// Helper: generate unique order ID
function generateOrderId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
}

// ─── MonCash: Create Payment (wallet top-up) ───
// POST /api/payments/moncash/topup
router.post('/moncash/topup', protect, async (req, res) => {
  try {
    const { amount } = req.body;
    if (!amount || amount < 50) {
      return res.status(400).json({ success: false, message: 'Minimum top-up is 50 HTG' });
    }

    const orderId = generateOrderId('topup');

    // Create transaction record (pending)
    const transaction = await Transaction.create({
      user: req.user._id,
      type: 'topup',
      amount: amount,
      method: 'moncash',
      status: 'pending',
      reference: orderId,
      description: 'Wallet top-up via MonCash'
    });

    // If MonCash credentials are configured, use real API
    if (process.env.MONCASH_CLIENT_ID) {
      const mc = getMoncash();
      mc.payment.create({ amount: amount, orderId: orderId }, (err, payment) => {
        if (err) {
          return res.status(500).json({ success: false, message: 'MonCash error: ' + (err.description || err.message) });
        }
        const redirectUrl = mc.payment.redirectUri(payment);
        return res.json({
          success: true,
          orderId: orderId,
          transactionId: transaction._id,
          redirectUrl: redirectUrl,
          mode: 'live'
        });
      });
    } else {
      // Demo mode - simulate payment success
      transaction.status = 'completed';
      await transaction.save();

      // Credit wallet
      await User.findByIdAndUpdate(req.user._id, {
        $inc: { 'wallet.balance': amount }
      });

      return res.json({
        success: true,
        orderId: orderId,
        transactionId: transaction._id,
        mode: 'demo',
        message: 'Demo mode: ' + amount + ' HTG added to wallet'
      });
    }
  } catch (error) {
    console.error('MonCash topup error:', error);
    res.status(500).json({ success: false, message: 'Payment failed' });
  }
});

// ─── MonCash: Create Payment (ride payment) ───
// POST /api/payments/moncash/ride
router.post('/moncash/ride', protect, async (req, res) => {
  try {
    const { rideId } = req.body;
    const ride = await Ride.findById(rideId);
    if (!ride) {
      return res.status(404).json({ success: false, message: 'Ride not found' });
    }
    if (ride.paymentStatus === 'paid') {
      return res.status(400).json({ success: false, message: 'Ride already paid' });
    }

    const amount = ride.fare.total;
    const orderId = generateOrderId('ride');

    const transaction = await Transaction.create({
      user: req.user._id,
      ride: ride._id,
      type: 'payment',
      amount: amount,
      method: 'moncash',
      status: 'pending',
      reference: orderId,
      description: 'Ride payment via MonCash'
    });

    if (process.env.MONCASH_CLIENT_ID) {
      const mc = getMoncash();
      mc.payment.create({ amount: amount, orderId: orderId }, (err, payment) => {
        if (err) {
          return res.status(500).json({ success: false, message: 'MonCash error' });
        }
        const redirectUrl = mc.payment.redirectUri(payment);
        return res.json({
          success: true,
          orderId: orderId,
          transactionId: transaction._id,
          redirectUrl: redirectUrl,
          mode: 'live'
        });
      });
    } else {
      // Demo mode
      transaction.status = 'completed';
      await transaction.save();
      ride.paymentStatus = 'paid';
      ride.paymentMethod = 'moncash';
      await ride.save();

      return res.json({
        success: true,
        orderId: orderId,
        transactionId: transaction._id,
        mode: 'demo',
        message: 'Demo mode: Ride paid (' + amount + ' HTG)'
      });
    }
  } catch (error) {
    console.error('MonCash ride payment error:', error);
    res.status(500).json({ success: false, message: 'Payment failed' });
  }
});

// ─── MonCash: Verify Payment (callback) ───
// GET /api/payments/moncash/verify?orderId=xxx
router.get('/moncash/verify', async (req, res) => {
  try {
    const { orderId, transactionId: mcTransId } = req.query;
    if (!orderId && !mcTransId) {
      return res.status(400).json({ success: false, message: 'orderId or transactionId required' });
    }

    const transaction = await Transaction.findOne({
      reference: orderId,
      status: 'pending'
    });

    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found or already processed' });
    }

    if (process.env.MONCASH_CLIENT_ID) {
      const mc = getMoncash();
      const verifyFn = orderId
        ? (cb) => mc.capture.getByOrderId(orderId, cb)
        : (cb) => mc.capture.getByTransactionId(mcTransId, cb);

      verifyFn((err, capture) => {
        if (err) {
          return res.status(400).json({ success: false, message: 'Payment verification failed' });
        }

        if (capture.payment) {
          // Mark transaction as completed
          transaction.status = 'completed';
          transaction.save();

          // Process based on transaction type
          if (transaction.type === 'topup') {
            User.findByIdAndUpdate(transaction.user, {
              $inc: { 'wallet.balance': transaction.amount }
            }).exec();
          } else if (transaction.type === 'payment' && transaction.ride) {
            Ride.findByIdAndUpdate(transaction.ride, {
              paymentStatus: 'paid',
              paymentMethod: 'moncash'
            }).exec();
          }

          return res.json({ success: true, payment: capture.payment });
        }
        return res.status(400).json({ success: false, message: 'Payment not completed' });
      });
    } else {
      return res.json({ success: true, mode: 'demo', message: 'Demo mode - no verification needed' });
    }
  } catch (error) {
    console.error('MonCash verify error:', error);
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

// ─── NatCash: Manual Payment (USSD-based) ───
// POST /api/payments/natcash/topup
router.post('/natcash/topup', protect, async (req, res) => {
  try {
    const { amount, natcashPhone } = req.body;
    if (!amount || amount < 50) {
      return res.status(400).json({ success: false, message: 'Minimum top-up is 50 HTG' });
    }

    const orderId = generateOrderId('nc_topup');

    const transaction = await Transaction.create({
      user: req.user._id,
      type: 'topup',
      amount: amount,
      method: 'natcash',
      status: 'pending',
      reference: orderId,
      description: 'Wallet top-up via NatCash. Phone: ' + (natcashPhone || 'N/A')
    });

    // NatCash doesn't have a public API - use manual verification flow
    // User sends money via *202# to the business NatCash number
    // Admin verifies and approves manually, or we check via webhook later
    const businessNumber = process.env.NATCASH_BUSINESS_NUMBER || '+50948XXXXXXX';

    if (process.env.NATCASH_AUTO_VERIFY === 'true') {
      // Future: auto-verify via NatCash business API when available
      return res.json({
        success: true,
        orderId: orderId,
        transactionId: transaction._id,
        mode: 'pending_verification',
        instructions: {
          step1: 'Dial *202# on your Natcom phone',
          step2: 'Select "Send Money"',
          step3: 'Enter business number: ' + businessNumber,
          step4: 'Enter amount: ' + amount + ' HTG',
          step5: 'Confirm with your NatCash PIN',
          reference: orderId
        }
      });
    } else {
      // Demo mode
      transaction.status = 'completed';
      await transaction.save();
      await User.findByIdAndUpdate(req.user._id, {
        $inc: { 'wallet.balance': amount }
      });

      return res.json({
        success: true,
        orderId: orderId,
        transactionId: transaction._id,
        mode: 'demo',
        message: 'Demo mode: ' + amount + ' HTG added to wallet'
      });
    }
  } catch (error) {
    console.error('NatCash topup error:', error);
    res.status(500).json({ success: false, message: 'Payment failed' });
  }
});

// ─── NatCash: Ride Payment ───
// POST /api/payments/natcash/ride
router.post('/natcash/ride', protect, async (req, res) => {
  try {
    const { rideId } = req.body;
    const ride = await Ride.findById(rideId);
    if (!ride) {
      return res.status(404).json({ success: false, message: 'Ride not found' });
    }

    const amount = ride.fare.total;
    const orderId = generateOrderId('nc_ride');

    const transaction = await Transaction.create({
      user: req.user._id,
      ride: ride._id,
      type: 'payment',
      amount: amount,
      method: 'natcash',
      status: 'pending',
      reference: orderId,
      description: 'Ride payment via NatCash'
    });

    // Demo mode
    transaction.status = 'completed';
    await transaction.save();
    ride.paymentStatus = 'paid';
    ride.paymentMethod = 'natcash';
    await ride.save();

    return res.json({
      success: true,
      orderId: orderId,
      transactionId: transaction._id,
      mode: 'demo',
      message: 'Demo mode: Ride paid (' + amount + ' HTG)'
    });
  } catch (error) {
    console.error('NatCash ride payment error:', error);
    res.status(500).json({ success: false, message: 'Payment failed' });
  }
});

// ─── Wallet: Pay from wallet balance ───
// POST /api/payments/wallet/ride
router.post('/wallet/ride', protect, async (req, res) => {
  try {
    const { rideId } = req.body;
    const ride = await Ride.findById(rideId);
    if (!ride) {
      return res.status(404).json({ success: false, message: 'Ride not found' });
    }

    const user = await User.findById(req.user._id);
    const amount = ride.fare.total;

    if (user.wallet.balance < amount) {
      return res.status(400).json({
        success: false,
        message: 'Insufficient wallet balance. Need ' + amount + ' HTG, have ' + user.wallet.balance + ' HTG'
      });
    }

    // Deduct from wallet
    user.wallet.balance -= amount;
    await user.save();

    // Mark ride as paid
    ride.paymentStatus = 'paid';
    ride.paymentMethod = 'wallet';
    await ride.save();

    // Create transaction records
    await Transaction.create({
      user: user._id,
      ride: ride._id,
      type: 'payment',
      amount: amount,
      method: 'wallet',
      status: 'completed',
      reference: generateOrderId('wallet'),
      description: 'Ride payment from wallet'
    });

    // Driver earning (75%)
    if (ride.driver) {
      const driverEarning = ride.fare.driverEarning || Math.round(amount * 0.75);
      await User.findByIdAndUpdate(ride.driver, {
        $inc: { 'wallet.balance': driverEarning }
      });
      await Transaction.create({
        user: ride.driver,
        ride: ride._id,
        type: 'earning',
        amount: driverEarning,
        status: 'completed',
        description: 'Ride earning (75%)'
      });
    }

    res.json({
      success: true,
      message: 'Paid ' + amount + ' HTG from wallet',
      newBalance: user.wallet.balance
    });
  } catch (error) {
    console.error('Wallet payment error:', error);
    res.status(500).json({ success: false, message: 'Payment failed' });
  }
});

// ─── Get payment history ───
// GET /api/payments/history
router.get('/history', protect, async (req, res) => {
  try {
    const transactions = await Transaction.find({ user: req.user._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .populate('ride', 'type pickup.address dropoff.address');

    res.json({ success: true, transactions });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to fetch history' });
  }
});

// ─── Admin: Verify pending NatCash payment ───
// POST /api/payments/admin/verify
router.post('/admin/verify', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin only' });
    }

    const { transactionId, approve } = req.body;
    const transaction = await Transaction.findById(transactionId);
    if (!transaction || transaction.status !== 'pending') {
      return res.status(404).json({ success: false, message: 'Pending transaction not found' });
    }

    if (approve) {
      transaction.status = 'completed';
      await transaction.save();

      if (transaction.type === 'topup') {
        await User.findByIdAndUpdate(transaction.user, {
          $inc: { 'wallet.balance': transaction.amount }
        });
      } else if (transaction.type === 'payment' && transaction.ride) {
        await Ride.findByIdAndUpdate(transaction.ride, {
          paymentStatus: 'paid'
        });
      }

      res.json({ success: true, message: 'Payment approved' });
    } else {
      transaction.status = 'failed';
      await transaction.save();
      res.json({ success: true, message: 'Payment rejected' });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

module.exports = router;
