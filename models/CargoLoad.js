var mongoose = require('mongoose');

var cargoLoadSchema = new mongoose.Schema({
  client: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  pickupLocation: {
    address: { type: String, required: true },
    city: { type: String, required: true },
    coordinates: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [0, 0] }
    }
  },
  deliveryLocation: {
    address: { type: String, required: true },
    city: { type: String, required: true },
    coordinates: {
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: [0, 0] }
    }
  },
  cargoType: { type: String, required: true },
  weight: { type: Number, required: true }, // in tons
  trucksNeeded: { type: Number, required: true, min: 1 },
  pickupDate: { type: Date, required: true },
  deliveryDate: { type: Date },
  specialRequirements: { type: String, default: '' },
  status: {
    type: String,
    enum: ['posted', 'assigned', 'in-transit', 'delivered', 'cancelled'],
    default: 'posted'
  },
  assignedPartner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'FleetPartner'
  },
  bids: [{
    partner: { type: mongoose.Schema.Types.ObjectId, ref: 'FleetPartner', required: true },
    price: { type: Number, required: true },
    trucksAvailable: { type: Number, required: true },
    estimatedDelivery: { type: Date },
    status: {
      type: String,
      enum: ['pending', 'accepted', 'rejected'],
      default: 'pending'
    },
    createdAt: { type: Date, default: Date.now }
  }],
  acceptedBid: {
    type: mongoose.Schema.Types.ObjectId
  },
  tracking: {
    driverLocation: { type: String, default: '' },
    vehicleLocation: { type: String, default: '' },
    estimatedArrival: { type: Date },
    deliveryConfirmed: { type: Boolean, default: false },
    proofOfDelivery: {
      photo: { type: String, default: '' },
      signature: { type: String, default: '' }
    }
  }
}, {
  timestamps: true
});

cargoLoadSchema.index({ client: 1, createdAt: -1 });
cargoLoadSchema.index({ status: 1 });
cargoLoadSchema.index({ assignedPartner: 1 });
cargoLoadSchema.index({ 'pickupLocation.coordinates': '2dsphere' });
cargoLoadSchema.index({ 'deliveryLocation.coordinates': '2dsphere' });

module.exports = mongoose.model('CargoLoad', cargoLoadSchema);
