const express = require('express');
const { body, validationResult } = require('express-validator');
const Ride = require('../models/Ride');
const DriverProfile = require('../models/DriverProfile');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');
const { calculateFare } = require('../utils/fareCalculator');

const router = express.Router();

// POST /api/rides - Create a new ride/delivery request
router.post('/', protect, [
  body('type').isIn(['delivery', 'ride']),
  body('pickup.address').notEmpty(),
  body('dropoff.address').notEmpty(),
  body('paymentMethod').isIn(['moncash', 'natcash', 'cashpaw', 'card', 'wallet', 'cash'])
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    const { type, pickup, dropoff, items, paymentMethod, distanceKm, recipient } = req.body;

    // Calculate fare
    const fareCalc = calculateFare(type, distanceKm || 5);

    const ride = await Ride.create({
      type,
      customer: req.user._id,
      pickup,
      dropoff,
      items: items || [],
      recipient: recipient || null,
      distanceKm: distanceKm || 5,
      fare: {
        total: fareCalc.totalFare,
        commission: fareCalc.commission,
        driverEarning: fareCalc.driverEarning
      },
      paymentMethod,
      status: 'requested'
    });

    // Create payment transaction
    await Transaction.create({
      user: req.user._id,
      ride: ride._id,
      type: 'payment',
      amount: fareCalc.totalFare,
      method: paymentMethod,
      description: `${type === 'delivery' ? 'Delivery' : 'Ride'} - ${pickup.address} to ${dropoff.address}`
    });

    const populated = await Ride.findById(ride._id).populate('customer', 'name phone');

    // Emit to socket for nearby drivers (handled in server.js)
    if (req.app.get('io')) {
      req.app.get('io').emit('new_ride', {
        rideId: ride._id,
        type: ride.type,
        pickup: ride.pickup,
        dropoff: ride.dropoff,
        fare: ride.fare
      });
    }

    res.status(201).json({ success: true, ride: populated });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/rides/:id/accept - Driver accepts a ride
router.put('/:id/accept', protect, authorize('driver'), async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) {
      return res.status(404).json({ success: false, message: 'Ride not found' });
    }
    if (ride.status !== 'requested') {
      return res.status(400).json({ success: false, message: 'Ride already taken' });
    }

    ride.driver = req.user._id;
    ride.status = 'accepted';
    ride.acceptedAt = new Date();
    await ride.save();

    const populated = await Ride.findById(ride._id)
      .populate('customer', 'name phone')
      .populate('driver', 'name phone');

    // Notify customer
    if (req.app.get('io')) {
      req.app.get('io').to(`ride_${ride._id}`).emit('ride_accepted', {
        rideId: ride._id,
        driver: { name: req.user.name, phone: req.user.phone }
      });
    }

    res.json({ success: true, ride: populated });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/rides/:id/status - Update ride status
router.put('/:id/status', protect, authorize('driver'), async (req, res) => {
  try {
    const { status } = req.body;
    const ride = await Ride.findById(req.params.id);

    if (!ride) {
      return res.status(404).json({ success: false, message: 'Ride not found' });
    }
    if (ride.driver.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not your ride' });
    }

    // Valid transitions
    const validTransitions = {
      accepted: ['picking_up', 'cancelled'],
      picking_up: ['in_progress', 'cancelled'],
      in_progress: ['delivered', 'cancelled']
    };

    if (!validTransitions[ride.status]?.includes(status)) {
      return res.status(400).json({ success: false, message: `Cannot change from ${ride.status} to ${status}` });
    }

    ride.status = status;
    if (status === 'picking_up') ride.pickedUpAt = new Date();
    if (status === 'delivered') {
      ride.deliveredAt = new Date();
      ride.paymentStatus = 'paid';

      // Update driver stats
      const updateField = ride.type === 'delivery' ? 'totalDeliveries' : 'totalRides';
      await DriverProfile.findOneAndUpdate(
        { user: req.user._id },
        {
          $inc: {
            [updateField]: 1,
            totalEarnings: ride.fare.driverEarning
          }
        }
      );

      // Create earning transaction for driver
      await Transaction.create({
        user: req.user._id,
        ride: ride._id,
        type: 'earning',
        amount: ride.fare.driverEarning,
        status: 'completed',
        description: `Earning from ${ride.type}`
      });

      // Create commission transaction
      await Transaction.create({
        user: req.user._id,
        ride: ride._id,
        type: 'commission',
        amount: ride.fare.commission,
        status: 'completed',
        description: `Commission (25%) from ${ride.type}`
      });
    }
    if (status === 'cancelled') {
      ride.cancelledAt = new Date();
      ride.cancelledBy = 'driver';
      ride.cancelReason = req.body.reason || '';
    }

    await ride.save();

    // Real-time update
    if (req.app.get('io')) {
      req.app.get('io').to(`ride_${ride._id}`).emit('ride_status', {
        rideId: ride._id,
        status: ride.status
      });
    }

    res.json({ success: true, ride });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/rides/:id/cancel - Customer cancels a ride
router.put('/:id/cancel', protect, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) {
      return res.status(404).json({ success: false, message: 'Ride not found' });
    }
    if (ride.customer.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not your ride' });
    }
    if (['delivered', 'cancelled'].includes(ride.status)) {
      return res.status(400).json({ success: false, message: 'Cannot cancel this ride' });
    }

    ride.status = 'cancelled';
    ride.cancelledAt = new Date();
    ride.cancelledBy = 'customer';
    ride.cancelReason = req.body.reason || '';
    await ride.save();

    if (req.app.get('io')) {
      req.app.get('io').to(`ride_${ride._id}`).emit('ride_cancelled', { rideId: ride._id });
    }

    res.json({ success: true, ride });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/rides/:id/rate - Rate a ride
router.put('/:id/rate', protect, async (req, res) => {
  try {
    const { rating } = req.body;
    const ride = await Ride.findById(req.params.id);

    if (!ride || ride.status !== 'delivered') {
      return res.status(400).json({ success: false, message: 'Can only rate delivered rides' });
    }

    if (ride.customer.toString() === req.user._id.toString()) {
      ride.driverRating = rating;
      // Update driver's average rating
      const driverRides = await Ride.find({ driver: ride.driver, driverRating: { $exists: true, $ne: null } });
      const avgRating = driverRides.reduce((sum, r) => sum + r.driverRating, 0) / driverRides.length;
      await DriverProfile.findOneAndUpdate({ user: ride.driver }, { rating: Math.round(avgRating * 10) / 10 });
    } else if (ride.driver.toString() === req.user._id.toString()) {
      ride.customerRating = rating;
    } else {
      return res.status(403).json({ success: false, message: 'Not part of this ride' });
    }

    await ride.save();
    res.json({ success: true, ride });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/rides - Get user's rides
router.get('/', protect, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const query = {};

    if (req.user.role === 'driver') {
      query.driver = req.user._id;
    } else {
      query.customer = req.user._id;
    }

    if (status) query.status = status;

    const rides = await Ride.find(query)
      .populate('customer', 'name phone')
      .populate('driver', 'name phone')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Ride.countDocuments(query);

    res.json({ success: true, count: rides.length, total, page: parseInt(page), rides });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/rides/available - Available rides for drivers
router.get('/available', protect, authorize('driver'), async (req, res) => {
  try {
    const rides = await Ride.find({ status: 'requested' })
      .populate('customer', 'name phone')
      .sort({ createdAt: -1 })
      .limit(50);

    res.json({ success: true, count: rides.length, rides });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/rides/:id - Get single ride
router.get('/:id', protect, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id)
      .populate('customer', 'name phone')
      .populate('driver', 'name phone');

    if (!ride) {
      return res.status(404).json({ success: false, message: 'Ride not found' });
    }

    res.json({ success: true, ride });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
