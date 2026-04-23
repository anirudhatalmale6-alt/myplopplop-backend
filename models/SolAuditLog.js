const mongoose = require('mongoose');

const solAuditLogSchema = new mongoose.Schema({
  entityType: {
    type: String,
    enum: ['group', 'cycle', 'contribution', 'payout', 'membership', 'wallet_transaction'],
    required: true
  },
  entityId: {
    type: mongoose.Schema.Types.ObjectId,
    required: true
  },
  group: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SolGroup'
  },
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  actionType: {
    type: String,
    required: true
  },
  amount: Number,
  beforeState: mongoose.Schema.Types.Mixed,
  afterState: mongoose.Schema.Types.Mixed,
  metadata: mongoose.Schema.Types.Mixed
}, {
  timestamps: true
});

solAuditLogSchema.index({ group: 1, createdAt: -1 });
solAuditLogSchema.index({ entityType: 1, entityId: 1 });
solAuditLogSchema.index({ user: 1, createdAt: -1 });

module.exports = mongoose.model('SolAuditLog', solAuditLogSchema);
