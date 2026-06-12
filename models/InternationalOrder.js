const mongoose = require('mongoose');

const internationalOrderSchema = new mongoose.Schema({
  orderNumber: { type: String, unique: true },
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  store: { type: mongoose.Schema.Types.ObjectId, ref: 'InternationalStore', required: true },
  country: { type: String, required: true, enum: ['DO', 'PA', 'US', 'HT'] },
  supplierType: { type: String, default: 'MANUAL' },
  items: [{
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'InternationalProduct' },
    name: { type: String, required: true },
    sourcePrice: { type: Number, required: true },
    sourceCurrency: { type: String, required: true },
    finalPriceHTG: { type: Number, required: true },
    quantity: { type: Number, required: true, min: 1 },
    subtotalHTG: { type: Number, required: true },
    image: { type: String, default: '' }
  }],
  totalHTG: { type: Number, required: true },
  paymentMethod: {
    type: String, required: true,
    enum: ['moncash', 'natcash', 'bank_transfer', 'zelle', 'stripe', 'wire_transfer', 'credit_card', 'debit_card']
  },
  paymentVerification: {
    status: { type: String, enum: ['pending', 'submitted', 'approved', 'rejected'], default: 'pending' },
    receiptImage: { type: String },
    transactionRef: { type: String },
    notes: { type: String },
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: { type: Date }
  },
  stripePaymentId: { type: String },
  status: {
    type: String,
    enum: ['submitted', 'payment_received', 'payment_verified', 'purchase_authorized', 'purchased', 'pickup', 'shipping', 'delivered', 'completed', 'cancelled', 'refunded'],
    default: 'submitted'
  },
  statusHistory: [{
    status: { type: String },
    timestamp: { type: Date, default: Date.now },
    note: { type: String }
  }],
  deliveryAddress: {
    street: { type: String },
    city: { type: String },
    zone: { type: String },
    phone: { type: String }
  },
  trackingNumber: { type: String },
  supplierOrderId: { type: String },
  supplierOrderData: { type: mongoose.Schema.Types.Mixed },
  logistics: {
    legs: [{
      label: { type: String },
      carrier: { type: String },
      trackingNumber: { type: String },
      status: { type: String, enum: ['pending', 'in_transit', 'arrived', 'delivered'], default: 'pending' },
      origin: { type: String },
      destination: { type: String },
      updatedAt: { type: Date }
    }],
    currentLeg: { type: Number, default: 0 }
  },
  settlement: {
    supplierCostUSD: { type: Number, default: 0 },
    shippingCostUSD: { type: Number, default: 0 },
    exchangeRateUsed: { type: Number, default: 0 },
    platformProfit: { type: Number, default: 0 },
    settled: { type: Boolean, default: false }
  },
  estimatedDelivery: { type: Date },
  adminNotes: { type: String },
  cancelReason: { type: String }
}, { timestamps: true });

internationalOrderSchema.pre('save', function(next) {
  if (this.isNew && !this.orderNumber) {
    var prefix = this.country || 'XX';
    this.orderNumber = 'INT-' + prefix + '-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substr(2, 4).toUpperCase();
  }
  next();
});

internationalOrderSchema.index({ customer: 1, createdAt: -1 });
internationalOrderSchema.index({ status: 1 });
internationalOrderSchema.index({ 'paymentVerification.status': 1 });
internationalOrderSchema.index({ orderNumber: 1 });

module.exports = mongoose.model('InternationalOrder', internationalOrderSchema);
