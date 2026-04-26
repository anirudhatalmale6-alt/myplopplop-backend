const mongoose = require('mongoose');

const koutyeReferralSchema = new mongoose.Schema({
  koutye: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Koutye',
    required: true
  },
  koutyeCode: {
    type: String,
    required: true
  },
  platform: {
    type: String,
    enum: ['48hoursready', 'msouwout', 'myplopplop', 'utility', 'sol', 'prolakay'],
    required: true
  },
  referredEntity: {
    type: { type: String, enum: ['business', 'driver', 'customer', 'merchant', 'professional'] },
    name: String,
    phone: String,
    email: String,
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  status: {
    type: String,
    enum: ['active', 'expired', 'cancelled'],
    default: 'active'
  },
  startDate: {
    type: Date,
    default: Date.now
  },
  expiryDate: {
    type: Date,
    required: true
  },
  commissionRate: {
    type: Number,
    required: true
  },
  commissionType: {
    type: String,
    enum: ['percentage', 'flat', 'per_transaction', 'per_activity'],
    default: 'percentage'
  },
  totalCommissionEarned: {
    type: Number,
    default: 0
  },
  commissionCount: {
    type: Number,
    default: 0
  },
  lastCommissionDate: Date,
  sourceDescription: String
}, {
  timestamps: true
});

koutyeReferralSchema.index({ koutye: 1, status: 1 });
koutyeReferralSchema.index({ koutyeCode: 1 });
koutyeReferralSchema.index({ platform: 1 });
koutyeReferralSchema.index({ expiryDate: 1 });
koutyeReferralSchema.index({ 'referredEntity.userId': 1 });

koutyeReferralSchema.methods.isExpired = function() {
  return new Date() > this.expiryDate;
};

koutyeReferralSchema.methods.isActive = function() {
  return this.status === 'active' && !this.isExpired();
};

module.exports = mongoose.model('KoutyeReferral', koutyeReferralSchema);
