const mongoose = require('mongoose');

const koutyeCommissionSchema = new mongoose.Schema({
  koutye: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Koutye',
    required: true
  },
  referral: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'KoutyeReferral',
    required: true
  },
  platform: {
    type: String,
    enum: ['48hoursready', 'msouwout', 'myplopplop', 'utility', 'sol', 'prolakay'],
    required: true
  },
  transactionId: {
    type: String
  },
  serviceType: {
    type: String,
    enum: ['package', 'ride', 'delivery', 'marketplace', 'utility', 'sol', 'talent'],
    default: 'package'
  },
  sourceAmount: {
    type: Number,
    required: true
  },
  platformFee: {
    type: Number
  },
  commissionRate: {
    type: Number,
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
  status: {
    type: String,
    enum: ['pending', 'validated', 'approved', 'paid', 'rejected', 'expired'],
    default: 'pending'
  },
  description: String,
  sourceTransaction: {
    type: String
  },
  earnedAt: {
    type: Date,
    default: Date.now
  },
  validatedAt: Date,
  approvedAt: Date,
  paidAt: Date,
  expiresAt: Date,
  rejectionReason: String
}, {
  timestamps: true
});

koutyeCommissionSchema.index({ koutye: 1, createdAt: -1 });
koutyeCommissionSchema.index({ status: 1 });
koutyeCommissionSchema.index({ platform: 1 });
koutyeCommissionSchema.index({ referral: 1 });

module.exports = mongoose.model('KoutyeCommission', koutyeCommissionSchema);
