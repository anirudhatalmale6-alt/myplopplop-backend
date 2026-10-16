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
    'prolakay': { referrals: { type: Number, default: 0 }, earnings: { type: Number, default: 0 } },
    /* Tike Lakay, added 3 Oct 2026. Without this bucket the commission is
       still written and still paid, but the agent's own dashboard shows
       nothing against ticket sales - which is the half he would notice. */
    'tikelakay': { referrals: { type: Number, default: 0 }, earnings: { type: Number, default: 0 } }
  },
  /* ENTERPRISE PARTNERS, 15 Oct 2026. Jeffery: "HaitiBiznis -> StarFlex
     Enterprise -> StarFlex Ajan -> recruited drivers/businesses." The agent
     keeps their own code, QR, history and wallet; this only says which
     partner organisation they recruit FOR. It is the Organization `slug`
     (e.g. "STARFLEX"), the same string already written on shops and drivers.
     Empty = an independent HaitiBiznis Ajan.
     ⛔ Set only from the console, from a list the organisation sent and he
     approved - never by the agent, never by a referral link. */
  organization: { type: String, trim: true, default: '', index: true, maxlength: 80 },
  organizationLinkedAt: Date,
  lastPayoutDate: Date,
  // 16 Oct 2026: a short lock so two payout requests cannot both spend one balance
  payoutBusyUntil: Date,
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
