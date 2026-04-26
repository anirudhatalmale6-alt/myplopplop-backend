const mongoose = require('mongoose');

const storeSchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  name: {
    type: String,
    required: [true, 'Store name is required'],
    trim: true,
    maxlength: 100
  },
  slug: {
    type: String,
    unique: true,
    lowercase: true,
    trim: true
  },
  description: {
    type: String,
    maxlength: 500
  },
  category: {
    type: String,
    enum: ['restaurant', 'supermarket', 'hardware', 'pharmacy', 'wholesale', 'retail', 'bakery', 'other'],
    default: 'other'
  },
  logo: String,
  coverImage: String,
  phone: String,
  email: String,
  address: {
    street: String,
    city: String,
    department: String,
    coordinates: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [0, 0] } // [lng, lat]
    }
  },
  openingHours: {
    monday: { open: String, close: String, closed: { type: Boolean, default: false } },
    tuesday: { open: String, close: String, closed: { type: Boolean, default: false } },
    wednesday: { open: String, close: String, closed: { type: Boolean, default: false } },
    thursday: { open: String, close: String, closed: { type: Boolean, default: false } },
    friday: { open: String, close: String, closed: { type: Boolean, default: false } },
    saturday: { open: String, close: String, closed: { type: Boolean, default: false } },
    sunday: { open: String, close: String, closed: { type: Boolean, default: true } }
  },
  deliveryOptions: {
    selfPickup: { type: Boolean, default: true },
    delivery: { type: Boolean, default: true },
    deliveryFee: { type: Number, default: 0 },
    freeDeliveryMin: { type: Number, default: 0 }, // minimum order for free delivery
    estimatedDeliveryMins: { type: Number, default: 45 }
  },
  commissionRate: {
    type: Number,
    default: 10, // 10% platform commission
    min: 0,
    max: 50
  },
  rating: {
    average: { type: Number, default: 0, min: 0, max: 5 },
    count: { type: Number, default: 0 }
  },
  stats: {
    totalOrders: { type: Number, default: 0 },
    totalRevenue: { type: Number, default: 0 },
    totalProducts: { type: Number, default: 0 }
  },
  status: {
    type: String,
    enum: ['pending', 'active', 'suspended', 'closed'],
    default: 'pending'
  },
  isVerified: { type: Boolean, default: false },
  isFeatured: { type: Boolean, default: false }
}, {
  timestamps: true
});

// Auto-generate slug
storeSchema.pre('save', function(next) {
  if (this.isNew || this.isModified('name')) {
    this.slug = this.name.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 50) + '-' + Date.now().toString(36);
  }
  next();
});

storeSchema.index({ 'address.coordinates': '2dsphere' });
storeSchema.index({ category: 1, status: 1 });
storeSchema.index({ owner: 1 });

module.exports = mongoose.model('Store', storeSchema);
