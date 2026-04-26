const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema({
  product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
  name: String,
  price: { type: Number, required: true },
  quantity: { type: Number, required: true, min: 1 },
  subtotal: { type: Number, required: true }
}, { _id: true });

const orderSchema = new mongoose.Schema({
  orderNumber: {
    type: String,
    unique: true
  },
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  store: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Store',
    required: true
  },
  items: [orderItemSchema],

  // Recipient (for diaspora orders sent to someone in Haiti)
  recipient: {
    name: String,
    phone: String,
    address: String
  },
  isDiasporaOrder: { type: Boolean, default: false },

  // Delivery
  deliveryType: {
    type: String,
    enum: ['delivery', 'pickup'],
    default: 'delivery'
  },
  deliveryAddress: {
    street: String,
    city: String,
    notes: String,
    coordinates: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [0, 0] }
    }
  },
  deliveryFee: { type: Number, default: 0 },

  // Assigned rider
  rider: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },

  // Financials
  subtotal: { type: Number, required: true },
  commission: { type: Number, default: 0 }, // platform commission (10%)
  diasporaFee: { type: Number, default: 0 }, // +3-5% for diaspora orders
  total: { type: Number, required: true },
  merchantEarning: { type: Number, default: 0 },
  riderEarning: { type: Number, default: 0 },
  deliveryPlatformCut: { type: Number, default: 0 }, // 20% of delivery fee
  deliveryDriverCut: { type: Number, default: 0 }, // 80% of delivery fee

  // Payout tracking
  payoutStatus: {
    type: String,
    enum: ['held', 'pending', 'available', 'paid', 'refunded'],
    default: 'held'
  },
  payoutAvailableAt: Date,
  payoutPaidAt: Date,

  // Payment
  paymentMethod: {
    type: String,
    enum: ['moncash', 'natcash', 'wallet', 'cash', 'card'],
    default: 'moncash'
  },
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'refunded', 'failed'],
    default: 'pending'
  },
  paymentRef: String,

  // Order status
  status: {
    type: String,
    enum: ['pending', 'confirmed', 'preparing', 'ready', 'picked_up', 'delivering', 'delivered', 'cancelled'],
    default: 'pending'
  },
  cancelledBy: {
    type: String,
    enum: ['customer', 'merchant', 'system', null],
    default: null
  },
  cancelReason: String,

  // Timestamps
  confirmedAt: Date,
  preparedAt: Date,
  pickedUpAt: Date,
  deliveredAt: Date,
  cancelledAt: Date,

  // Ratings
  customerRating: { type: Number, min: 1, max: 5 },
  customerReview: String,
  merchantRating: { type: Number, min: 1, max: 5 },

  notes: String
}, {
  timestamps: true
});

// Auto-generate order number
orderSchema.pre('save', function(next) {
  if (this.isNew && !this.orderNumber) {
    var date = new Date();
    var prefix = 'PP';
    var datePart = date.getFullYear().toString().slice(2) +
      String(date.getMonth() + 1).padStart(2, '0') +
      String(date.getDate()).padStart(2, '0');
    var randPart = Math.random().toString(36).substring(2, 6).toUpperCase();
    this.orderNumber = prefix + datePart + randPart;
  }
  next();
});

orderSchema.index({ customer: 1, createdAt: -1 });
orderSchema.index({ store: 1, status: 1 });
orderSchema.index({ rider: 1, status: 1 });
orderSchema.index({ status: 1, createdAt: -1 });

module.exports = mongoose.model('Order', orderSchema);
