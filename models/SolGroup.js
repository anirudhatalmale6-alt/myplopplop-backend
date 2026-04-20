const mongoose = require('mongoose');

const memberSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  joinedAt: { type: Date, default: Date.now },
  position: { type: Number }, // payout order (1-based)
  status: {
    type: String,
    enum: ['active', 'defaulted', 'removed', 'completed'],
    default: 'active'
  },
  totalContributed: { type: Number, default: 0 },
  totalReceived: { type: Number, default: 0 },
  missedPayments: { type: Number, default: 0 }
}, { _id: true });

const contributionSchema = new mongoose.Schema({
  member: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  cycle: { type: Number, required: true },
  amount: { type: Number, required: true },
  paidAt: { type: Date, default: Date.now },
  method: {
    type: String,
    enum: ['moncash', 'natcash', 'wallet', 'cash'],
    default: 'moncash'
  },
  transactionRef: String,
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'failed'],
    default: 'confirmed'
  }
}, { _id: true, timestamps: true });

const payoutSchema = new mongoose.Schema({
  recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  cycle: { type: Number, required: true },
  amount: { type: Number, required: true },
  platformFee: { type: Number, default: 0 },
  netAmount: { type: Number, required: true },
  paidAt: { type: Date, default: Date.now },
  method: {
    type: String,
    enum: ['moncash', 'natcash', 'wallet', 'cash'],
    default: 'wallet'
  },
  transactionRef: String,
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed'],
    default: 'pending'
  }
}, { _id: true, timestamps: true });

const solGroupSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Group name is required'],
    trim: true,
    maxlength: 100
  },
  description: {
    type: String,
    maxlength: 500
  },
  creator: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  admins: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  members: [memberSchema],

  // Group settings
  maxMembers: {
    type: Number,
    required: true,
    min: 3,
    max: 30,
    default: 10
  },
  contributionAmount: {
    type: Number,
    required: [true, 'Contribution amount is required'],
    min: 100 // minimum 100 HTG
  },
  currency: {
    type: String,
    default: 'HTG'
  },
  frequency: {
    type: String,
    enum: ['weekly', 'biweekly', 'monthly'],
    default: 'monthly'
  },

  // Cycle tracking
  currentCycle: { type: Number, default: 0 },
  totalCycles: { type: Number }, // = maxMembers (each member gets one payout)
  cycleStartDate: Date,
  nextPaymentDate: Date,
  nextPayoutDate: Date,

  // Payment order - array of user IDs in payout order
  payoutOrder: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],

  // Financial tracking
  contributions: [contributionSchema],
  payouts: [payoutSchema],
  totalCollected: { type: Number, default: 0 },
  totalDistributed: { type: Number, default: 0 },

  // Platform fees
  cycleFeePercent: { type: Number, default: 2 }, // 2% per cycle
  withdrawalFeePercent: { type: Number, default: 1.5 }, // 1.5% on withdrawal
  accessFee: { type: Number, default: 150 }, // 150 HTG/month

  // Trust layer (optional)
  trustLayerEnabled: { type: Boolean, default: false },
  trustFeePerMember: { type: Number, default: 0 }, // $2-$5 per member per cycle

  // Group status
  status: {
    type: String,
    enum: ['forming', 'active', 'paused', 'completed', 'dissolved'],
    default: 'forming'
  },

  // Premium group features
  isPremium: { type: Boolean, default: false },
  isVerified: { type: Boolean, default: false },

  // Invite
  inviteCode: {
    type: String,
    unique: true,
    sparse: true
  }
}, {
  timestamps: true
});

// Generate invite code on creation
solGroupSchema.pre('save', function(next) {
  if (this.isNew && !this.inviteCode) {
    var code = 'SOL-' + Math.random().toString(36).substring(2, 8).toUpperCase();
    this.inviteCode = code;
  }
  // totalCycles = maxMembers
  if (!this.totalCycles) {
    this.totalCycles = this.maxMembers;
  }
  next();
});

// Virtual: is group full
solGroupSchema.virtual('isFull').get(function() {
  var activeMembers = this.members.filter(function(m) {
    return m.status === 'active';
  });
  return activeMembers.length >= this.maxMembers;
});

// Virtual: active member count
solGroupSchema.virtual('activeMemberCount').get(function() {
  return this.members.filter(function(m) {
    return m.status === 'active';
  }).length;
});

// Get contributions for a specific cycle
solGroupSchema.methods.getCycleContributions = function(cycle) {
  return this.contributions.filter(function(c) {
    return c.cycle === cycle && c.status === 'confirmed';
  });
};

// Check if member has paid for current cycle
solGroupSchema.methods.hasMemberPaid = function(userId, cycle) {
  return this.contributions.some(function(c) {
    return c.member.toString() === userId.toString() &&
      c.cycle === cycle &&
      c.status === 'confirmed';
  });
};

// Get next payout recipient
solGroupSchema.methods.getNextRecipient = function() {
  if (this.payoutOrder.length === 0) return null;
  if (this.currentCycle >= this.payoutOrder.length) return null;
  return this.payoutOrder[this.currentCycle];
};

solGroupSchema.index({ creator: 1 });
solGroupSchema.index({ 'members.user': 1 });
solGroupSchema.index({ status: 1 });

module.exports = mongoose.model('SolGroup', solGroupSchema);
