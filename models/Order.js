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
  commission: { type: Number, default: 0 }, // the SELLER fee taken from the merchant's settlement
  sellerFeePct: Number,          // the % behind `commission`, as applied to THIS order (15 Oct 2026)
  sellerFeeRule: String,         // 'legacy' (store.commissionRate) | 'accepted' | 'not_accepted'
  serviceFee: { type: Number, default: 0 }, // 5% service fee the shopper is shown and charged
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
    enum: ['moncash', 'natcash', 'wallet', 'card'],
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
    enum: ['customer', 'merchant', 'system', 'admin', null],
    default: null
  },
  cancelReason: String,

  // Timestamps
  paidAt: Date,
  confirmedAt: Date,
  preparedAt: Date,
  pickedUpAt: Date,
  deliveredAt: Date,
  cancelledAt: Date,

  // Ratings
  customerRating: { type: Number, min: 1, max: 5 },
  customerReview: String,
  merchantRating: { type: Number, min: 1, max: 5 },

  notes: String,

  // MsouWout dispatch integration
  msouwoutRideId: String,
  msouwoutTrackingCode: String,
  // MyPlopPlop delivery engine
  rideId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ride' },
  /* The customer's 4-digit delivery code. ⛔ Only the CUSTOMER (and an admin)
     may ever be sent it - routes strip it for the shop and the driver. */
  deliveryPin: String,

  /* ═══ 16 Oct 2026: the five must-fix areas (services/orderLifecycle.js) ═══ */
  // One payment for a basket of several shops: every order in it carries the
  // same paymentGroup (the first order's number), which is the reference the
  // customer paid under. Confirming the payment confirms all of them.
  paymentGroup: { type: String, index: true },
  paymentCheckedAt: Date,          // the server poller's last look at the gateway
  paymentChecks: { type: Number, default: 0 },
  pinAttempts: { type: Number, default: 0 },   // wrong delivery codes entered
  deliveredVia: String,            // 'pin' | 'pickup_pin' | 'admin_exception'
  // Money moves ONCE: each credit is stamped by the single atomic update that
  // makes it, so a retry or a second tap finds the stamp and does nothing.
  merchantCreditedAt: Date,
  driverCreditedAt: Date,
  driverCreditUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  noDriverAlertedAt: Date,
  refund: { type: mongoose.Schema.Types.ObjectId, ref: 'Refund' }
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
