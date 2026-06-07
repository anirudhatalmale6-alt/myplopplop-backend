const mongoose = require('mongoose');

var sellerLeadSchema = new mongoose.Schema({
  name: String,
  phone: String,
  email: String,
  category: String,
  location: String,
  listingCount: {
    type: Number,
    default: 1
  },
  leadScore: {
    type: Number,
    default: 50,
    min: 0,
    max: 100
  },
  status: {
    type: String,
    enum: ['new', 'contacted', 'onboarding', 'converted', 'rejected'],
    default: 'new'
  },
  assignedKoutye: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  conversionValue: {
    type: Number,
    default: 0
  },
  notes: String,
  listings: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Listing'
  }]
}, {
  timestamps: true
});

module.exports = mongoose.model('SellerLead', sellerLeadSchema);
