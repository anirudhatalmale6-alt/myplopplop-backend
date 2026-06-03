var express = require('express');
var router = express.Router();
var FleetPartner = require('../models/FleetPartner');
var CargoLoad = require('../models/CargoLoad');
var { protect } = require('../middleware/auth');

// ═══════════════════════════════════════════════════════
// FLEET PARTNER ROUTES
// ═══════════════════════════════════════════════════════

// ─── REGISTER FLEET PARTNER COMPANY ───
router.post('/partners/register', protect, async function(req, res) {
  try {
    // Check if user already has a fleet partner company
    var existing = await FleetPartner.findOne({ owner: req.user._id });
    if (existing) {
      return res.status(400).json({ success: false, message: 'You already have a registered fleet company' });
    }

    var partner = await FleetPartner.create({
      owner: req.user._id,
      company: {
        name: req.body.companyName,
        contactPerson: req.body.contactPerson,
        phone: req.body.phone,
        email: req.body.email,
        address: req.body.address || '',
        taxId: req.body.taxId || '',
        logo: req.body.logo || ''
      },
      serviceCoverage: req.body.serviceCoverage || [],
      fleet: req.body.fleet || {}
    });

    res.status(201).json({ success: true, data: partner });
  } catch (err) {
    console.error('Register fleet partner error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET MY FLEET COMPANY ───
router.get('/partners/my-company', protect, async function(req, res) {
  try {
    var partner = await FleetPartner.findOne({ owner: req.user._id })
      .populate('owner', 'name phone email');

    if (!partner) {
      return res.status(404).json({ success: false, message: 'No fleet company found' });
    }

    res.json({ success: true, data: partner });
  } catch (err) {
    console.error('Get my fleet company error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── UPDATE FLEET PARTNER ───
router.put('/partners/:id', protect, async function(req, res) {
  try {
    var partner = await FleetPartner.findById(req.params.id);
    if (!partner) {
      return res.status(404).json({ success: false, message: 'Fleet partner not found' });
    }
    if (partner.owner.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    // Update company fields
    if (req.body.companyName) partner.company.name = req.body.companyName;
    if (req.body.contactPerson) partner.company.contactPerson = req.body.contactPerson;
    if (req.body.phone) partner.company.phone = req.body.phone;
    if (req.body.email) partner.company.email = req.body.email;
    if (req.body.address !== undefined) partner.company.address = req.body.address;
    if (req.body.taxId !== undefined) partner.company.taxId = req.body.taxId;
    if (req.body.logo !== undefined) partner.company.logo = req.body.logo;

    // Update other fields
    if (req.body.serviceCoverage) partner.serviceCoverage = req.body.serviceCoverage;
    if (req.body.fleet) partner.fleet = req.body.fleet;
    if (req.body.status && req.user.role === 'admin') partner.status = req.body.status;

    await partner.save();
    res.json({ success: true, data: partner });
  } catch (err) {
    console.error('Update fleet partner error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── ADD VEHICLE TO FLEET ───
router.post('/partners/:id/vehicles', protect, async function(req, res) {
  try {
    var partner = await FleetPartner.findById(req.params.id);
    if (!partner) {
      return res.status(404).json({ success: false, message: 'Fleet partner not found' });
    }
    if (partner.owner.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    var vehicle = {
      licensePlate: req.body.licensePlate,
      type: req.body.type,
      capacity: req.body.capacity || 0,
      availabilityStatus: req.body.availabilityStatus || 'available',
      driverAssigned: req.body.driverAssigned || ''
    };

    partner.vehicles.push(vehicle);

    // Update fleet count for the vehicle type
    var typeCountMap = {
      truck: 'trucks',
      container: 'containers',
      flatbed: 'flatbeds',
      dumpTruck: 'dumpTrucks',
      crane: 'cranes',
      forklift: 'forklifts'
    };
    var fleetField = typeCountMap[req.body.type];
    if (fleetField) {
      partner.fleet[fleetField] = (partner.fleet[fleetField] || 0) + 1;
    }

    await partner.save();

    var addedVehicle = partner.vehicles[partner.vehicles.length - 1];
    res.status(201).json({ success: true, data: addedVehicle });
  } catch (err) {
    console.error('Add vehicle error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── REMOVE VEHICLE FROM FLEET ───
router.delete('/partners/:id/vehicles/:vehicleId', protect, async function(req, res) {
  try {
    var partner = await FleetPartner.findById(req.params.id);
    if (!partner) {
      return res.status(404).json({ success: false, message: 'Fleet partner not found' });
    }
    if (partner.owner.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    var vehicle = partner.vehicles.id(req.params.vehicleId);
    if (!vehicle) {
      return res.status(404).json({ success: false, message: 'Vehicle not found' });
    }

    // Decrement fleet count for the vehicle type
    var typeCountMap = {
      truck: 'trucks',
      container: 'containers',
      flatbed: 'flatbeds',
      dumpTruck: 'dumpTrucks',
      crane: 'cranes',
      forklift: 'forklifts'
    };
    var fleetField = typeCountMap[vehicle.type];
    if (fleetField) {
      partner.fleet[fleetField] = Math.max(0, (partner.fleet[fleetField] || 0) - 1);
    }

    partner.vehicles.pull({ _id: req.params.vehicleId });
    await partner.save();

    res.json({ success: true, message: 'Vehicle removed' });
  } catch (err) {
    console.error('Remove vehicle error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════
// CARGO LOAD ROUTES
// ═══════════════════════════════════════════════════════

// ─── POST A NEW CARGO LOAD ───
router.post('/loads', protect, async function(req, res) {
  try {
    var load = await CargoLoad.create({
      client: req.user._id,
      pickupLocation: req.body.pickupLocation,
      deliveryLocation: req.body.deliveryLocation,
      cargoType: req.body.cargoType,
      weight: req.body.weight,
      trucksNeeded: req.body.trucksNeeded,
      pickupDate: req.body.pickupDate,
      deliveryDate: req.body.deliveryDate || null,
      specialRequirements: req.body.specialRequirements || ''
    });

    res.status(201).json({ success: true, data: load });
  } catch (err) {
    console.error('Post cargo load error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── LIST AVAILABLE CARGO LOADS (public) ───
router.get('/loads', async function(req, res) {
  try {
    var page = parseInt(req.query.page) || 1;
    var limit = parseInt(req.query.limit) || 20;
    var city = req.query.city;
    var cargoType = req.query.cargoType;

    var query = { status: 'posted' };
    if (city) query['pickupLocation.city'] = { $regex: city, $options: 'i' };
    if (cargoType) query.cargoType = { $regex: cargoType, $options: 'i' };

    var loads = await CargoLoad.find(query)
      .populate('client', 'name phone')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(limit);

    var total = await CargoLoad.countDocuments(query);

    res.json({
      success: true,
      data: loads,
      pagination: { page: page, limit: limit, total: total }
    });
  } catch (err) {
    console.error('List cargo loads error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET LOAD DETAILS ───
router.get('/loads/:id', async function(req, res) {
  try {
    var load = await CargoLoad.findById(req.params.id)
      .populate('client', 'name phone email')
      .populate('assignedPartner', 'company.name company.phone')
      .populate('bids.partner', 'company.name company.phone rating');

    if (!load) {
      return res.status(404).json({ success: false, message: 'Cargo load not found' });
    }

    res.json({ success: true, data: load });
  } catch (err) {
    console.error('Get load details error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── UPDATE LOAD (client only) ───
router.put('/loads/:id', protect, async function(req, res) {
  try {
    var load = await CargoLoad.findById(req.params.id);
    if (!load) {
      return res.status(404).json({ success: false, message: 'Cargo load not found' });
    }
    if (load.client.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    if (load.status !== 'posted') {
      return res.status(400).json({ success: false, message: 'Can only update loads with status "posted"' });
    }

    var allowed = ['pickupLocation', 'deliveryLocation', 'cargoType', 'weight', 'trucksNeeded', 'pickupDate', 'deliveryDate', 'specialRequirements', 'status'];
    allowed.forEach(function(field) {
      if (req.body[field] !== undefined) load[field] = req.body[field];
    });

    await load.save();
    res.json({ success: true, data: load });
  } catch (err) {
    console.error('Update load error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════
// BIDDING ROUTES
// ═══════════════════════════════════════════════════════

// ─── FLEET PARTNER SUBMITS BID ───
router.post('/loads/:id/bid', protect, async function(req, res) {
  try {
    var load = await CargoLoad.findById(req.params.id);
    if (!load) {
      return res.status(404).json({ success: false, message: 'Cargo load not found' });
    }
    if (load.status !== 'posted') {
      return res.status(400).json({ success: false, message: 'This load is no longer accepting bids' });
    }

    // Find the partner company owned by this user
    var partner = await FleetPartner.findOne({ owner: req.user._id });
    if (!partner) {
      return res.status(400).json({ success: false, message: 'You must register a fleet company first' });
    }
    if (partner.status !== 'active') {
      return res.status(400).json({ success: false, message: 'Your fleet company must be active to bid' });
    }

    // Check if partner already bid on this load
    var alreadyBid = load.bids.some(function(bid) {
      return bid.partner.toString() === partner._id.toString();
    });
    if (alreadyBid) {
      return res.status(400).json({ success: false, message: 'You already submitted a bid for this load' });
    }

    load.bids.push({
      partner: partner._id,
      price: req.body.price,
      trucksAvailable: req.body.trucksAvailable,
      estimatedDelivery: req.body.estimatedDelivery || null,
      status: 'pending',
      createdAt: new Date()
    });

    await load.save();

    var newBid = load.bids[load.bids.length - 1];
    res.status(201).json({ success: true, data: newBid });
  } catch (err) {
    console.error('Submit bid error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── CLIENT ACCEPTS BID ───
router.put('/loads/:id/bids/:bidId/accept', protect, async function(req, res) {
  try {
    var load = await CargoLoad.findById(req.params.id);
    if (!load) {
      return res.status(404).json({ success: false, message: 'Cargo load not found' });
    }
    if (load.client.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    if (load.status !== 'posted') {
      return res.status(400).json({ success: false, message: 'This load has already been assigned' });
    }

    var bid = load.bids.id(req.params.bidId);
    if (!bid) {
      return res.status(404).json({ success: false, message: 'Bid not found' });
    }

    // Accept the selected bid, reject all others
    load.bids.forEach(function(b) {
      if (b._id.toString() === req.params.bidId) {
        b.status = 'accepted';
      } else {
        b.status = 'rejected';
      }
    });

    load.acceptedBid = bid._id;
    load.assignedPartner = bid.partner;
    load.status = 'assigned';

    await load.save();

    // Update partner stats
    await FleetPartner.findByIdAndUpdate(bid.partner, {
      $inc: { 'stats.activeLoads': 1 }
    });

    var updatedLoad = await CargoLoad.findById(load._id)
      .populate('client', 'name phone')
      .populate('assignedPartner', 'company.name company.phone');

    res.json({ success: true, data: updatedLoad });
  } catch (err) {
    console.error('Accept bid error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── CLIENT DIRECTLY ASSIGNS LOAD TO PARTNER ───
router.put('/loads/:id/assign', protect, async function(req, res) {
  try {
    var load = await CargoLoad.findById(req.params.id);
    if (!load) {
      return res.status(404).json({ success: false, message: 'Cargo load not found' });
    }
    if (load.client.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }
    if (load.status !== 'posted') {
      return res.status(400).json({ success: false, message: 'This load has already been assigned' });
    }

    var partnerId = req.body.partnerId;
    if (!partnerId) {
      return res.status(400).json({ success: false, message: 'partnerId is required' });
    }

    var partner = await FleetPartner.findById(partnerId);
    if (!partner) {
      return res.status(404).json({ success: false, message: 'Fleet partner not found' });
    }
    if (partner.status !== 'active') {
      return res.status(400).json({ success: false, message: 'Fleet partner is not active' });
    }

    // Reject all existing bids
    load.bids.forEach(function(b) {
      b.status = 'rejected';
    });

    load.assignedPartner = partner._id;
    load.status = 'assigned';

    await load.save();

    // Update partner stats
    partner.stats.activeLoads = (partner.stats.activeLoads || 0) + 1;
    await partner.save();

    var updatedLoad = await CargoLoad.findById(load._id)
      .populate('client', 'name phone')
      .populate('assignedPartner', 'company.name company.phone');

    res.json({ success: true, data: updatedLoad });
  } catch (err) {
    console.error('Assign load error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ═══════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════

// ─── FLEET PARTNER DASHBOARD STATS ───
router.get('/partners/:id/dashboard', protect, async function(req, res) {
  try {
    var partner = await FleetPartner.findById(req.params.id);
    if (!partner) {
      return res.status(404).json({ success: false, message: 'Fleet partner not found' });
    }
    if (partner.owner.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    // Get active loads assigned to this partner
    var activeLoads = await CargoLoad.find({
      assignedPartner: partner._id,
      status: { $in: ['assigned', 'in-transit'] }
    })
      .populate('client', 'name phone')
      .sort('-createdAt');

    // Get completed loads
    var completedLoads = await CargoLoad.countDocuments({
      assignedPartner: partner._id,
      status: 'delivered'
    });

    // Get pending bids by this partner
    var loadsWithPendingBids = await CargoLoad.find({
      'bids.partner': partner._id,
      'bids.status': 'pending',
      status: 'posted'
    })
      .populate('client', 'name phone')
      .sort('-createdAt');

    // Available vehicles count
    var availableVehicles = partner.vehicles.filter(function(v) {
      return v.availabilityStatus === 'available';
    }).length;

    var totalVehicles = partner.vehicles.length;

    res.json({
      success: true,
      data: {
        partner: partner,
        activeLoads: activeLoads,
        completedLoadsCount: completedLoads,
        pendingBids: loadsWithPendingBids,
        vehicleSummary: {
          total: totalVehicles,
          available: availableVehicles,
          inUse: totalVehicles - availableVehicles
        },
        stats: partner.stats,
        rating: partner.rating
      }
    });
  } catch (err) {
    console.error('Fleet partner dashboard error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
