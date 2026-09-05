const mongoose = require('mongoose');

const driverProfileSchema = new mongoose.Schema({
  user: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  vehicleType: {
    type: String,
    enum: ['moto', 'car', 'truck'],
    required: true
  },
  vehiclePlate: {
    type: String,
    required: true,
    trim: true
  },
  vehicleModel: String,
  vehicleColor: String,

  // Documents
  licenseNumber: {
    type: String,
    required: true
  },
  licensePhoto: String,       // File path
  insurancePhoto: String,     // File path
  vehiclePhoto: String,       // File path
  idPhoto: String,            // File path

  // Verification
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected', 'suspended'],
    default: 'pending'
  },
  verifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  verifiedAt: Date,
  rejectionReason: String,

  // Service types this driver offers.
  //
  // This one array is what separates a MyPlopPlop delivery driver from a
  // passenger driver, and it is deliberately the ONLY thing that does. The
  // dispatch engine already searches on `services: 'delivery'`, so a second
  // "driverType" column would be a copy of this that could quietly disagree
  // with it - and a driver who disagreed with himself would either be offered
  // work he is not approved for, or none at all.
  //
  // A driver who registers on myplopplop.com to deliver parcels gets exactly
  // ['delivery'] and appears only in the delivery approval queue.
  services: [{
    type: String,
    enum: ['delivery', 'ride']
  }],

  // Location & availability
  isOnline: {
    type: Boolean,
    default: false
  },
  currentLocation: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number],  // [longitude, latitude]
      default: [0, 0]
    }
  },

  // Stats
  totalRides: { type: Number, default: 0 },
  totalDeliveries: { type: Number, default: 0 },
  totalEarnings: { type: Number, default: 0 },
  rating: { type: Number, default: 5.0, min: 1, max: 5 }
}, {
  timestamps: true
});

// Virtual: driver grade based on rating + rides
driverProfileSchema.virtual('grade').get(function() {
  var totalTrips = this.totalRides + this.totalDeliveries;
  if (this.rating >= 4.8 && totalTrips >= 100) return { tier: 'Elite', badge: 'gold', color: '#f59e0b' };
  if (this.rating >= 4.5 && totalTrips >= 50) return { tier: 'Pro', badge: 'silver', color: '#6b7280' };
  if (this.rating >= 4.0 && totalTrips >= 10) return { tier: 'Verified', badge: 'blue', color: '#3b82f6' };
  return { tier: 'New', badge: 'green', color: '#10b981' };
});

// What kind of driver this is, in one word, for the admin lists and screens.
// Read from `services` rather than stored, so it can never disagree with the
// array the dispatch engine actually searches on.
driverProfileSchema.virtual('driverType').get(function() {
  var s = this.services || [];
  var d = s.indexOf('delivery') !== -1;
  var r = s.indexOf('ride') !== -1;
  if (d && r) return 'both';
  if (r) return 'ride';
  return 'delivery';
});

driverProfileSchema.set('toJSON', { virtuals: true });
driverProfileSchema.set('toObject', { virtuals: true });

driverProfileSchema.index({ currentLocation: '2dsphere' });
driverProfileSchema.index({ status: 1, isOnline: 1 });
// The admin approval queues read "pending delivery drivers" / "pending ride
// drivers", which is this index.
driverProfileSchema.index({ services: 1, status: 1 });

module.exports = mongoose.model('DriverProfile', driverProfileSchema);
