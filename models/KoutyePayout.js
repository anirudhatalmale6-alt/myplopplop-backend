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
    enum: ['moncash', 'natcash', 'bank'],
    required: true
  },
  details: {
    phone: String,
    bankName: String,
    accountNumber: String,
    accountHolder: String
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'paid', 'rejected'],
    default: 'pending'
  },
  processedAt: Date,
  processedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  rejectionReason: String,
  reference: String
}, {
  timestamps: true
});

koutyePayoutSchema.index({ koutye: 1, createdAt: -1 });
koutyePayoutSchema.index({ status: 1 });

module.exports = mongoose.model('KoutyePayout', koutyePayoutSchema);
