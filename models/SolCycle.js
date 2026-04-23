const mongoose = require('mongoose');

const solCycleSchema = new mongoose.Schema({
  group: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SolGroup',
    required: true
  },
  cycleNumber: {
    type: Number,
    required: true
  },
  startDate: {
    type: Date,
    required: true
  },
  dueDate: {
    type: Date,
    required: true
  },
  payoutDate: Date,
  expectedTotal: {
    type: Number,
    required: true
  },
  collectedTotal: {
    type: Number,
    default: 0
  },
  memberCount: {
    type: Number,
    required: true
  },
  payoutRecipient: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  status: {
    type: String,
    enum: ['upcoming', 'open', 'collection_in_progress', 'ready_for_payout', 'completed', 'failed'],
    default: 'upcoming'
  }
}, {
  timestamps: true
});

solCycleSchema.index({ group: 1, cycleNumber: 1 }, { unique: true });
solCycleSchema.index({ group: 1, status: 1 });

module.exports = mongoose.model('SolCycle', solCycleSchema);
