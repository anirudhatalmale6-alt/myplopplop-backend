const mongoose = require('mongoose');

var sellerLeadSchema = new mongoose.Schema({
  name: String,
  phone: String,
  email: String,
  whatsapp: String,
  facebookUrl: String,
  category: String,
  location: String,
  capturedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
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
    enum: ['new', 'contacted', 'follow-up', 'registered', 'activated', 'rejected'],
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
