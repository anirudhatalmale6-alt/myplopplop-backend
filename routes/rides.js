const express = require('express');
const { body, validationResult } = require('express-validator');
const Ride = require('../models/Ride');
const DriverProfile = require('../models/DriverProfile');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');
const { calculateFare } = require('../utils/fareCalculator');
const { sendPushToUser } = require('./notifications');
const referralService = require('../services/referral');

const router = express.Router();

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// POST /api/rides/quote - Instant distance-based delivery/ride price (no ride created).
// Body: { pickup:{lat,lng}, dropoff:{lat,lng}, type:'delivery'|'ride' }
// Used by checkout to show the delivery price before the customer pays.
router.post('/quote', async (req, res) => {
  try {
    const p = req.body.pickup || {};
    const d = req.body.dropoff || {};
    const type = req.body.type === 'ride' ? 'ride' : 'delivery';
    if (p.lat == null || p.lng == null || d.lat == null || d.lng == null) {
      return res.status(400).json({ success: false, message: 'pickup and dropoff {lat,lng} are required' });
    }
    const distanceKm = haversineKm(Number(p.lat), Number(p.lng), Number(d.lat), Number(d.lng));
    const fare = calculateFare(type, distanceKm);
    res.json({
      success: true,
      data: {
        distanceKm: Math.round(distanceKm * 10) / 10,
        deliveryFee: fare.totalFare,
        driverEarning: fare.driverEarning,
        commission: fare.commission,
        breakdown: fare.breakdown
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

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

    // `recipient` is a nested path on Ride, and mongoose refuses to cast null
    // into one — so writing `recipient || null` made every request without a
    // named recipient fail validation. Leave the key out instead.
    const ride = await Ride.create({
      type,
      customer: req.user._id,
      pickup,
      dropoff,
      items: items || [],
      ...(recipient && recipient.name ? { recipient } : {}),
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

    /* Is this driver allowed to take THIS kind of job?
     *
     * Being role:'driver' was the only thing checked here. That is not the same
     * question. It meant a driver whose application was still pending - or had
     * been rejected outright - could accept a real passenger and a real
     * delivery; and it meant somebody approved only to carry parcels could
     * accept a person, and somebody approved only to carry passengers could
     * take a shop's delivery. The two pools are supposed to be separate, and
     * the approval is supposed to mean something.
     */
    const myProfile = await DriverProfile.findOne({ user: req.user._id });
    if (!myProfile) {
      return res.status(403).json({ success: false, message: 'No driver profile' });
    }
    if (myProfile.status !== 'approved') {
      return res.status(403).json({
        success: false,
        message: myProfile.status === 'pending'
          ? 'Your driver application has not been approved yet'
          : 'Your driver account is ' + myProfile.status
      });
    }
    if ((myProfile.services || []).indexOf(ride.type) === -1) {
      return res.status(403).json({
        success: false,
        message: ride.type === 'ride'
          ? 'You are registered for deliveries, not for carrying passengers'
          : 'You are registered for passenger rides, not for deliveries'
      });
    }

    // For auto-dispatched deliveries, only the driver currently being offered the
    // job may accept, and only before the 30s window closes.
    if (ride.offeredTo) {
      if (String(ride.offeredTo) !== String(req.user._id)) {
        return res.status(403).json({ success: false, message: 'This delivery is offered to another driver' });
      }
      if (ride.offerExpiresAt && ride.offerExpiresAt < new Date()) {
        return res.status(400).json({ success: false, message: 'Offer expired' });
      }
    }

    ride.driver = req.user._id;
    ride.status = 'accepted';
    ride.acceptedAt = new Date();
    ride.offeredTo = null;
    ride.offerExpiresAt = null;
    await ride.save();

    // Link the driver back onto the marketplace order so tracking + payout work.
    if (ride.order) {
      try {
        const Order = require('../models/Order');
        await Order.updateOne({ _id: ride.order }, { $set: { rider: req.user._id } });
      } catch (e) { /* non-fatal */ }
    }

    const populated = await Ride.findById(ride._id)
      .populate('customer', 'name phone')
      .populate('driver', 'name phone');

    // Notify customer via socket + push
    if (req.app.get('io')) {
      req.app.get('io').to(`ride_${ride._id}`).emit('ride_accepted', {
        rideId: ride._id,
        driver: { name: req.user.name, phone: req.user.phone }
      });
    }
    sendPushToUser(ride.customer, 'Driver Found!', req.user.name + ' is on the way to pick you up', {
      url: '/rides-tracking.html?id=' + ride._id
    }).catch(() => {});

    res.json({ success: true, ride: populated });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/rides/my-offer - The delivery currently offered to THIS driver (30s window),
// plus any job they've already accepted and are still working on.
router.get('/my-offer', protect, authorize('driver'), async (req, res) => {
  try {
    const offer = await Ride.findOne({
      type: 'delivery',
      status: 'requested',
      offeredTo: req.user._id,
      offerExpiresAt: { $gt: new Date() }
    }).populate('customer', 'name phone').populate('store', 'name');

    const active = await Ride.findOne({
      driver: req.user._id,
      status: { $in: ['accepted', 'picking_up', 'in_progress'] }
    }).populate('customer', 'name phone').populate('store', 'name');

    res.json({ success: true, data: { offer: offer || null, active: active || null } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/rides/:id/decline - Driver declines an offer → auto re-offer to next closest
router.put('/:id/decline', protect, authorize('driver'), async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ success: false, message: 'Ride not found' });
    if (ride.status !== 'requested') {
      return res.status(400).json({ success: false, message: 'Ride no longer open' });
    }
    if (ride.offeredTo && String(ride.offeredTo) !== String(req.user._id)) {
      return res.status(403).json({ success: false, message: 'Not your offer' });
    }
    const deliveryDispatch = require('../services/deliveryDispatch');
    await deliveryDispatch.declineOffer(ride, req.user._id, req.app.get('io'));
    res.json({ success: true, message: 'Passed to the next driver' });
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

    // Secure handover: the customer gives the driver the 4-digit code to complete.
    if (status === 'delivered' && ride.pin) {
      const given = String(req.body.pin || '').trim();
      if (given !== String(ride.pin)) {
        return res.status(400).json({ success: false, code: 'pin_required', message: 'Wrong delivery code. Ask the customer for their 4-digit code.' });
      }
    }

    ride.status = status;
    if (status === 'picking_up') ride.pickedUpAt = new Date();
    if (status === 'delivered') {
      ride.deliveredAt = new Date();
      ride.paymentStatus = 'paid';

      // The shop order this ride was dispatched for finishes with it. Without
      // this the goods were in the customer's hands while the order sat at
      // "ready", the tracking page never completed and the shop was never
      // credited for the sale.
      if (ride.order) {
        try {
          const Order = require('../models/Order');
          const shopOrder = await Order.findById(ride.order);
          if (shopOrder) {
            await require('../services/completeOrder').markOrderDelivered(shopOrder);
          }
        } catch (e) {
          console.error('Closing the shop order for ride ' + ride._id + ' failed:', e.message);
        }
      }

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

      // Ambassador referral bonus - MyPlopPlop platform fees
      // 10% of platform fees, only for first 3 months per referred account, with payout cap
      const driver = await User.findById(req.user._id);
      if (driver && driver.referredBy) {
        const referredAt = driver.referredAt || driver.createdAt;
        const threeMonthsAgo = new Date();
        threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
        const withinWindow = referredAt > threeMonthsAgo;

        if (withinWindow) {
          const referrer = await User.findById(driver.referredBy);
          if (referrer) {
            // Check payout cap for this referred account
            const platformFeeAmount = ride.fare.commission; // platform's commission portion
            const referralBonus = Math.round(platformFeeAmount * 0.10); // 10% of platform fees
            const cap = referrer.referralPayoutCap || 500;
            const currentPlatformEarnings = referrer.referralEarningsPlatform || 0;
            const remainingCap = Math.max(0, cap - currentPlatformEarnings);
            const actualBonus = Math.min(referralBonus, remainingCap);

            if (actualBonus > 0) {
              await User.findByIdAndUpdate(driver.referredBy, {
                $inc: {
                  'wallet.balance': actualBonus,
                  referralEarnings: actualBonus,
                  referralEarningsPlatform: actualBonus
                }
              });
              await Transaction.create({
                user: driver.referredBy,
                ride: ride._id,
                type: 'referral',
                amount: actualBonus,
                status: 'completed',
                description: 'Ambassador bonus (10% platform fee) from ' + driver.name + ' - ' + ride.type
              });
            }
          }
        }
      }

      /* LajanMaker: the agent who recruited this DRIVER earns a share of the
         platform's cut of the fare. This is separate from the old ambassador
         bonus above, which is driver-refers-driver, runs for 3 months and is
         capped at 500 HTG - a different scheme with a different window that
         nobody should confuse with the agent programme.

         Keyed on the ride id, so re-sending "delivered" cannot pay twice. */
      const agentCut = await referralService.payCommissionForUser(req.user._id, {
        platform: 'myplopplop',
        serviceType: ride.type === 'delivery' ? 'delivery' : 'ride',
        amount: ride.fare.total,
        transactionId: String(ride._id),
        description: (ride.type === 'delivery' ? 'Delivery ' : 'Ride ') + ride._id
      });
      if (agentCut.commissioned) {
        console.log('Agent ' + agentCut.koutyeCode + ' earned ' + agentCut.amount +
          ' HTG on ' + ride.type + ' ' + ride._id);
      }
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

    // Push notification to customer on status change
    const pushMessages = {
      picking_up: { title: 'Driver En Route', body: 'Your driver is heading to pick you up' },
      in_progress: { title: 'Ride Started', body: 'You are on your way to your destination' },
      delivered: { title: 'Ride Complete', body: 'You have arrived! Please rate your driver' },
      cancelled: { title: 'Ride Cancelled', body: 'Your ride has been cancelled' }
    };
    if (pushMessages[status]) {
      sendPushToUser(ride.customer, pushMessages[status].title, pushMessages[status].body, {
        url: status === 'delivered' ? '/rides-tracking.html?id=' + ride._id : '/orders.html'
      }).catch(() => {});
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
      await ride.save();
      // Update driver's average rating
      const driverRides = await Ride.find({ driver: ride.driver, driverRating: { $exists: true, $ne: null } });
      if (driverRides.length > 0) {
        const avgRating = driverRides.reduce((sum, r) => sum + r.driverRating, 0) / driverRides.length;
        await DriverProfile.findOneAndUpdate({ user: ride.driver }, { rating: Math.round(avgRating * 10) / 10 });
      }
    } else if (ride.driver && ride.driver.toString() === req.user._id.toString()) {
      ride.customerRating = rating;
      await ride.save();
    } else {
      return res.status(403).json({ success: false, message: 'Not part of this ride' });
    }
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
//
// Only jobs this driver is actually approved to do. It used to list every open
// job on the platform to anybody with role:'driver', so a delivery rider was
// shown passengers waiting and a driver still awaiting approval was shown
// everything.
router.get('/available', protect, authorize('driver'), async (req, res) => {
  try {
    const myProfile = await DriverProfile.findOne({ user: req.user._id });
    if (!myProfile || myProfile.status !== 'approved') {
      return res.json({
        success: true, count: 0, rides: [],
        message: 'Your driver application has not been approved yet'
      });
    }

    const rides = await Ride.find({
      status: 'requested',
      type: { $in: myProfile.services && myProfile.services.length ? myProfile.services : ['delivery'] }
    })
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
