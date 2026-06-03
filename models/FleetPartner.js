var mongoose = require('mongoose');

var fleetPartnerSchema = new mongoose.Schema({
  company: {
    name: { type: String, required: [true, 'Company name is required'], trim: true, maxlength: 150 },
    contactPerson: { type: String, required: true, trim: true },
    phone: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    address: { type: String },
    taxId: { type: String },
    logo: { type: String, default: '' }
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  serviceCoverage: [{
    type: String,
    enum: ['Port-au-Prince', 'Cap-Haïtien', 'Gonaïves', 'Miragoâne', 'Les Cayes', 'Jacmel', 'Nationwide']
  }],
  fleet: {
    trucks: { type: Number, default: 0 },
    containers: { type: Number, default: 0 },
    flatbeds: { type: Number, default: 0 },
    dumpTrucks: { type: Number, default: 0 },
    cranes: { type: Number, default: 0 },
    forklifts: { type: Number, default: 0 }
  },
  vehicles: [{
    licensePlate: { type: String, required: true },
    type: {
      type: String,
      required: true,
      enum: ['truck', 'container', 'flatbed', 'dumpTruck', 'crane', 'forklift']
    },
    capacity: { type: Number },
    availabilityStatus: {
      type: String,
      enum: ['available', 'in-use', 'maintenance'],
      default: 'available'
    },
    driverAssigned: { type: String, default: '' }
  }],
  status: {
    type: String,
    enum: ['pending', 'active', 'suspended'],
    default: 'pending'
  },
  stats: {
    activeLoads: { type: Number, default: 0 },
    completedLoads: { type: Number, default: 0 },
    totalRevenue: { type: Number, default: 0 }
  },
  rating: {
    average: { type: Number, default: 0, min: 0, max: 5 },
    count: { type: Number, default: 0 }
  }
}, {
  timestamps: true
});

fleetPartnerSchema.index({ owner: 1 });
fleetPartnerSchema.index({ status: 1 });
fleetPartnerSchema.index({ 'company.name': 1 });
fleetPartnerSchema.index({ serviceCoverage: 1 });

module.exports = mongoose.model('FleetPartner', fleetPartnerSchema);
