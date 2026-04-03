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
  description: String
}, {
  timestamps: true
});

transactionSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('Transaction', transactionSchema);
