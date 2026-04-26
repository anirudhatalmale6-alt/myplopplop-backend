const mongoose = require('mongoose');

const koutyeSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  koutyeCode: {
    type: String,
    unique: true,
    required: true
  },
  status: {
    type: String,
    enum: ['active', 'suspended', 'inactive'],
    default: 'active'
  },
  tier: {
    type: String,
    enum: ['bronze', 'silver', 'gold', 'platinum'],
    default: 'bronze'
  },
  whatsapp: {
    type: String,
    trim: true
  },
  bio: {
    type: String,
    maxlength: 300
  },
  payoutMethod: {
    type: String,
    enum: ['moncash', 'natcash', 'bank'],
    default: 'moncash'
  },
  payoutDetails: {
    phone: String,
    bankName: String,
    accountNumber: String,
    accountHolder: String
  },
  stats: {
    totalReferrals: { type: Number, default: 0 },
    activeReferrals: { type: Number, default: 0 },
    expiredReferrals: { type: Number, default: 0 },
    totalEarnings: { type: Number, default: 0 },
    pendingEarnings: { type: Number, default: 0 },
    paidEarnings: { type: Number, default: 0 },
    totalPayouts: { type: Number, default: 0 }
  },
  platformBreakdown: {
    '48hoursready': { referrals: { type: Number, default: 0 }, earnings: { type: Number, default: 0 } },
    'msouwout': { referrals: { type: Number, default: 0 }, earnings: { type: Number, default: 0 } },
    'myplopplop': { referrals: { type: Number, default: 0 }, earnings: { type: Number, default: 0 } },
    'utility': { referrals: { type: Number, default: 0 }, earnings: { type: Number, default: 0 } },
    'sol': { referrals: { type: Number, default: 0 }, earnings: { type: Number, default: 0 } },
    'prolakay': { referrals: { type: Number, default: 0 }, earnings: { type: Number, default: 0 } }
  },
  lastPayoutDate: Date,
  suspendedReason: String,
  suspendedAt: Date
}, {
  timestamps: true
});

koutyeSchema.index({ status: 1 });
koutyeSchema.index({ 'stats.totalEarnings': -1 });

koutyeSchema.methods.updateTier = function() {
  const earnings = this.stats.totalEarnings;
  const referrals = this.stats.totalReferrals;
  if (earnings >= 50000 && referrals >= 50) this.tier = 'platinum';
  else if (earnings >= 20000 && referrals >= 25) this.tier = 'gold';
  else if (earnings >= 5000 && referrals >= 10) this.tier = 'silver';
  else this.tier = 'bronze';
};

module.exports = mongoose.model('Koutye', koutyeSchema);
