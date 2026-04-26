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
  sourceAmount: {
    type: Number,
    required: true
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
    enum: ['pending', 'approved', 'paid', 'rejected'],
    default: 'pending'
  },
  description: String,
  sourceTransaction: {
    type: String
  },
  approvedAt: Date,
  paidAt: Date,
  rejectionReason: String
}, {
  timestamps: true
});

koutyeCommissionSchema.index({ koutye: 1, createdAt: -1 });
koutyeCommissionSchema.index({ status: 1 });
koutyeCommissionSchema.index({ platform: 1 });
koutyeCommissionSchema.index({ referral: 1 });

module.exports = mongoose.model('KoutyeCommission', koutyeCommissionSchema);
