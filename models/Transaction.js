const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  ride: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Ride'
  },
  type: {
    type: String,
    enum: ['payment', 'earning', 'commission', 'topup', 'withdrawal', 'refund', 'referral'],
    required: true
  },
  amount: {
    type: Number,
    required: true
  },
  currency: {
    type: String,
    default: 'HTG'
  },
  method: {
    type: String,
    enum: ['moncash', 'natcash', 'cashpaw', 'card', 'wallet', 'cash']
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed'],
    default: 'pending'
  },
  reference: String,
  description: String,
  // Which wallet bucket the money left, so a rejected payout is refunded to the
  // same place it came from. Merchants are paid out of available_balance;
  // drivers are credited straight to balance when a delivery completes.
  sourceBucket: {
    type: String,
    enum: ['available_balance', 'balance'],
    default: 'available_balance'
  },
  recipient: String,
  /* 16 Oct 2026: an earning held for a while before it can be withdrawn.
     status 'pending' + releaseAt in the future = not yet available; the
     release job (services/orderLifecycle.js releaseMatured) flips it once,
     atomically, and moves the money between wallet buckets. */
  releaseAt: Date,
  earningOf: { type: String, enum: ['merchant', 'driver'] },
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order' }
}, {
  timestamps: true
});

transactionSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('Transaction', transactionSchema);
