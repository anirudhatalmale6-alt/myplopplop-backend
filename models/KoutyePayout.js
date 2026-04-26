const mongoose = require('mongoose');

const koutyePayoutSchema = new mongoose.Schema({
  koutye: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Koutye',
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 500
  },
  currency: {
    type: String,
    default: 'HTG'
  },
  method: {
    type: String,
    enum: ['moncash', 'natcash', 'bank', 'manual'],
    required: true
  },
  destinationAccount: {
    type: String
  },
  details: {
    phone: String,
    bankName: String,
    accountNumber: String,
    accountHolder: String
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'paid', 'rejected', 'failed'],
    default: 'pending'
  },
  adminNote: String,
  providerReference: String,
  requestedAt: {
    type: Date,
    default: Date.now
  },
  approvedAt: Date,
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  paidAt: Date,
  processedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  rejectedAt: Date,
  rejectionReason: String,
  reference: String
}, {
  timestamps: true
});

koutyePayoutSchema.index({ koutye: 1, createdAt: -1 });
koutyePayoutSchema.index({ status: 1 });

module.exports = mongoose.model('KoutyePayout', koutyePayoutSchema);
