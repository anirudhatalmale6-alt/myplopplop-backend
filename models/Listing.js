const mongoose = require('mongoose');

var listingSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Listing title is required'],
    trim: true,
    maxlength: 200
  },
  description: {
    type: String,
    maxlength: 5000
  },
  category: {
    type: String,
    enum: ['vehicles', 'real-estate', 'electronics', 'jobs', 'services', 'agriculture', 'construction', 'marketplace'],
    required: [true, 'Category is required']
  },
  subcategory: {
    type: String,
    trim: true
  },
  price: {
    type: Number,
    min: 0
  },
  currency: {
    type: String,
    default: 'HTG'
  },
  images: [String],
  location: {
    city: String,
    area: String,
    coordinates: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [0, 0] }
    }
  },
  seller: {
    name: String,
    phone: String,
    email: String,
    whatsapp: String
  },
  sellerUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  store: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Store'
  },
  source: {
    type: String,
    enum: ['user-submitted', 'partner-feed', 'aggregated'],
    default: 'user-submitted'
  },
  sourceUrl: String,
  status: {
    type: String,
    enum: ['active', 'pending', 'claimed', 'expired', 'flagged'],
    default: 'active'
  },
  trustScore: {
    type: Number,
    default: 0,
    min: 0,
    max: 100
  },
  stats: {
    views: { type: Number, default: 0 },
    inquiries: { type: Number, default: 0 },
    shares: { type: Number, default: 0 }
  },
  claimedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  claimedAt: Date,
  expiresAt: Date,
  tags: [String],
  isFeatured: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

listingSchema.index({ title: 'text', description: 'text' });
listingSchema.index({ category: 1 });
listingSchema.index({ status: 1 });
listingSchema.index({ 'location.city': 1 });
listingSchema.index({ 'location.coordinates': '2dsphere' });

module.exports = mongoose.model('Listing', listingSchema);
