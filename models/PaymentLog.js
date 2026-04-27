const mongoose = require('mongoose');

const paymentLogSchema = new mongoose.Schema({
  transaction_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'UtilityTransaction',
    required: true
  },
  payment_method: {
    type: String,
    enum: ['moncash', 'natcash', 'card'],
    required: true
  },
  provider_reference: String,
  amount: Number,
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed'],
    default: 'pending'
  },
  raw_response: mongoose.Schema.Types.Mixed,
  webhook_source: String
}, {
  timestamps: true
});

paymentLogSchema.index({ transaction_id: 1 });

module.exports = mongoose.model('PaymentLog', paymentLogSchema);
