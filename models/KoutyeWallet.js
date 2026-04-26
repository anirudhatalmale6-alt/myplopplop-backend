const mongoose = require('mongoose');

const koutyeWalletSchema = new mongoose.Schema({
  koutye: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Koutye',
    required: true,
    unique: true
  },
  available_balance: {
    type: Number,
    default: 0
  },
  pending_balance: {
    type: Number,
    default: 0
  },
  paid_balance: {
    type: Number,
    default: 0
  },
  lifetime_earnings: {
    type: Number,
    default: 0
  },
  currency: {
    type: String,
    default: 'HTG'
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('KoutyeWallet', koutyeWalletSchema);
