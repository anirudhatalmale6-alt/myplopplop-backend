const mongoose = require('mongoose');

const utilityTransactionSchema = new mongoose.Schema({
  reference_id: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  utility_type: {
    type: String,
    enum: ['edh', 'dinepa'],
    required: true
  },
  customer_name: {
    type: String,
    required: true
  },
  phone: {
    type: String,
    required: true
  },
  email: String,
  zone: String,
  account_number: String,
  meter_number: String,
  amount: {
    type: Number,
    required: true
  },
  service_fee: {
    type: Number,
    required: true
  },
  total_amount: {
    type: Number,
    required: true
  },
  payment_method: {
    type: String,
    enum: ['moncash', 'natcash', 'card'],
    required: true
  },
  payment_status: {
    type: String,
    enum: ['pending', 'paid', 'processing', 'completed', 'failed', 'refunded'],
    default: 'pending'
  },
  processing_status: {
    type: String,
    enum: ['new', 'processing', 'completed', 'manual_review', 'failed'],
    default: 'new'
  },
  provider_reference: String,
  payment_url: String,
  sip_transaction_id: String,
  token: String,
  token_status: {
    type: String,
    enum: ['pending', 'generated', 'sent', 'failed']
  },
  receipt_url: String,
  admin_notes: String,
  koutye_code: String,
  status_logs: [{
    old_status: String,
    new_status: String,
    note: String,
    changed_by: String,
    created_at: { type: Date, default: Date.now }
  }]
}, {
  timestamps: true
});

utilityTransactionSchema.index({ utility_type: 1, createdAt: -1 });
utilityTransactionSchema.index({ payment_status: 1 });
utilityTransactionSchema.index({ phone: 1 });

module.exports = mongoose.model('UtilityTransaction', utilityTransactionSchema);
