const mongoose = require('mongoose');

const rideSchema = new mongoose.Schema({
  type: {
    type: String,
    enum: ['delivery', 'ride'],
    required: true
  },
  customer: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  driver: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  // For diaspora orders - the person receiving in Haiti
  recipient: {
    name: String,
    phone: String,
    address: String
  },

  // Locations
  pickup: {
    address: { type: String, required: true },
    coordinates: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [0, 0] }
    },
    notes: String
  },
  dropoff: {
    address: { type: String, required: true },
    coordinates: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [0, 0] }
    },
    notes: String
  },

  // For delivery orders
  items: [{
    name: String,
    quantity: { type: Number, default: 1 },
    price: Number,
    store: String
  }],

  // Fare
  distanceKm: Number,
  fare: {
    total: { type: Number, required: true },
    commission: Number,
    driverEarning: Number
  },

  // Payment
  paymentMethod: {
    type: String,
    enum: ['moncash', 'natcash', 'cashpaw', 'card', 'wallet', 'cash'],
    required: true
  },
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'refunded'],
    default: 'pending'
  },

  // Status tracking
  status: {
    type: String,
    enum: [
      'requested',      // Customer placed order
      'accepted',       // Driver accepted
      'picking_up',     // Driver heading to pickup
      'in_progress',    // Driver picked up, heading to dropoff
      'delivered',      // Completed
      'cancelled'       // Cancelled by either party
    ],
    default: 'requested'
  },
  cancelledBy: {
    type: String,
    enum: ['customer', 'driver', 'admin']
  },
  cancelReason: String,

  // Timestamps for each status
  acceptedAt: Date,
  pickedUpAt: Date,
  deliveredAt: Date,
  cancelledAt: Date,

  // Rating
  customerRating: { type: Number, min: 1, max: 5 },
  driverRating: { type: Number, min: 1, max: 5 },

  // Real-time tracking
  driverLocation: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], default: [0, 0] }
  }
}, {
  timestamps: true
});

rideSchema.index({ customer: 1, createdAt: -1 });
rideSchema.index({ driver: 1, createdAt: -1 });
rideSchema.index({ status: 1 });

module.exports = mongoose.model('Ride', rideSchema);
