const mongoose = require('mongoose');

var buyerAlertSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  phone: String,
  email: String,
  whatsapp: String,
  searchQuery: {
    type: String,
    required: [true, 'Search query is required'],
    trim: true
  },
  category: String,
  maxPrice: Number,
  location: String,
  isActive: {
    type: Boolean,
    default: true
  },
  lastNotified: Date
}, {
  timestamps: true
});

module.exports = mongoose.model('BuyerAlert', buyerAlertSchema);
