const express = require('express');
const { body, validationResult } = require('express-validator');
const Ride = require('../models/Ride');
const DriverProfile = require('../models/DriverProfile');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const { protect, authorize, driverAccess } = require('../middleware/auth');
const { calculateFare } = require('../utils/fareCalculator');
const { sendPushToUser } = require('./notifications');

/* 16 Oct 2026: what a DRIVER may see of a job. ⛔ Never the customer's
   delivery code - he must get it from the customer at the door. The pickup
   code is his own, to show the shop. */
function forDriver(ride) {
  if (!ride) return ride;
  const o = ride.toObject ? ride.toObject() : Object.assign({}, ride);
  delete o.pin;
  return o;
}
/* The PICKUP code is the driver's, shown to the shop at the counter: if the
   shop (or anyone else) could read it, the shop could "confirm" a pickup with
   no driver there. Only the ride's own driver (and an admin) get it. */
function forCustomer(ride) {
  if (!ride) return ride;
  const o = ride.toObject ? ride.toObject() : Object.assign({}, ride);
  delete o.pickupCode;
  return o;
}
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
    const { type, pickup, dropoff, items, paymentMethod, recipient } = req.body;

    /* 27 Oct 2026: a delivery that is not a shop order is a PARCEL now, paid
       before any driver hears about it (POST /api/rides/parcel). This route
       used to create one unpaid and broadcast it to every driver at once. */
    if (type === 'delivery') {
      return res.status(400).json({ success: false, code: 'use_parcel', message: 'To send a package use Voye yon koli (voye-koli.html).' });
    }

    /* 🛑 27 Oct 2026: the price came from a distanceKm the PHONE sent, so a
       customer could set their own fare. The server measures it from the two
       points itself; with no points it charges the old default of 5 km. The
       body's distanceKm is ignored. */
    const pc = pickup && pickup.coordinates && pickup.coordinates.coordinates;
    const dc = dropoff && dropoff.coordinates && dropoff.coordinates.coordinates;
    const P = require('../services/parcel');
    const distanceKm = (pc && dc && P.inHaiti(+pc[1], +pc[0]) && P.inHaiti(+dc[1], +dc[0]))
      ? Math.round(P.haversineKm(+pc[1], +pc[0], +dc[1], +dc[0]) * 10) / 10 : 5;

    // Calculate fare
    const fareCalc = calculateFare(type, distanceKm);

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
      distanceKm: distanceKm,
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

    // Only signed-in, approved drivers are in the 'drivers' room (server.js).
    // This used to go to EVERY open connection, addresses included (16 Oct 2026).
    if (req.app.get('io')) {
      req.app.get('io').to('drivers').emit('new_ride', {
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

/* ═══ VOYE YON KOLI (27 Oct 2026) ════════════════════════════════════════
   POST /api/rides/parcel - the sender, signed in.
   Body: { pickup:{address,lat,lng,notes}, dropoff:{address,lat,lng,notes},
           recipient:{name,phone}, photo:'data:image/jpeg;base64,...',
           description, paymentMethod:'moncash'|'natcash'|'card' }
   Creates the parcel UNPAID ('awaiting_payment'): no driver sees it until
   services/parcel.js confirmPaid. The price is the server's, from the two
   points - the same calculateFare and 80/20 split as every delivery. */
router.post('/parcel', protect, async (req, res) => {
  try {
    /* 5 Nov 2026, Jeffery: "If anything fails, stop new Koli assignments until the issue is resolved." Render env
       KOLI_PAUSED=1 = no NEW package is accepted (packages already paid finish normally). Off = unset. */
    if (process.env.KOLI_PAUSED === '1') return res.status(503).json({ success: false, code: 'koli_paused',
      message: 'Voye yon koli poze pou kounye a. Eseye ankò pita. / Package sending is paused for now. Please try again later.' });
    const P = require('../services/parcel');
    const b = req.body || {};
    const pk = b.pickup || {}, dp = b.dropoff || {}, rc = b.recipient || {};
    const plat = Number(pk.lat), plng = Number(pk.lng), dlat = Number(dp.lat), dlng = Number(dp.lng);
    const say = function (m) { return res.status(400).json({ success: false, message: m }); };
    if (!String(pk.address || '').trim() || !P.inHaiti(plat, plng)) return say('Chwazi kote chofè a dwe pran koli a (sou kat la).');
    if (!String(dp.address || '').trim() || !P.inHaiti(dlat, dlng)) return say('Chwazi kote koli a dwe ale (sou kat la).');
    const km = P.haversineKm(plat, plng, dlat, dlng);
    if (km < 0.05) return say('Kote pou pran l ak kote pou livre l se menm kote a.');
    if (km > 150) return say('Distans sa a twò long pou yon livrezon moto.');
    const rname = String(rc.name || '').trim().slice(0, 80);
    const rphone = String(rc.phone || '').replace(/\D/g, '');
    if (!rname) return say('Mete non moun k ap resevwa koli a.');
    /* 5 Nov 2026: a Haiti number - 8 digits, or 509 + 8 (a 9- or 10-digit "number" can reach nobody) */
    if (!(rphone.length === 8 || (rphone.length === 11 && rphone.indexOf('509') === 0))) return say('Mete nimewo telefòn moun k ap resevwa koli a (8 chif).');
    const photo = String(b.photo || '');
    if (!/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(photo)) return say('Pran yon foto koli a.');
    if (photo.length > 550 * 1024) return say('Foto a twò gwo. Eseye ankò.');
    const method = ['moncash', 'natcash', 'card'].indexOf(b.paymentMethod) !== -1 ? b.paymentMethod : 'moncash';

    const distanceKm = Math.round(km * 10) / 10;
    const fare = calculateFare('delivery', distanceKm);
    const pt = function (lat, lng) { return { type: 'Point', coordinates: [lng, lat] }; };
    const ride = await Ride.create({
      type: 'delivery', source: 'parcel', status: 'awaiting_payment', paymentStatus: 'pending',
      customer: req.user._id,
      pickup: { address: String(pk.address).slice(0, 200), coordinates: pt(plat, plng), notes: String(pk.notes || '').slice(0, 200) },
      dropoff: { address: String(dp.address).slice(0, 200), coordinates: pt(dlat, dlng), notes: String(dp.notes || '').slice(0, 200) },
      recipient: { name: rname, phone: rphone.length === 8 ? '+509' + rphone : '+' + rphone, address: String(dp.address).slice(0, 200) },
      parcel: { photo: photo, description: String(b.description || '').slice(0, 200) },
      items: [{ name: 'Koli' + (b.description ? ': ' + String(b.description).slice(0, 60) : ''), quantity: 1 }],
      distanceKm: distanceKm,
      fare: { total: fare.totalFare, commission: fare.commission, driverEarning: fare.driverEarning },
      paymentMethod: method,
      pin: P.newPin(),
      trackToken: P.newTrackToken()
    });
    const out = forCustomer(ride);
    delete out.parcel;   // the sender has the photo; don't send 400 KB back
    res.status(201).json({ success: true, ride: out });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/* GET /api/rides/track/:token - the RECIPIENT's link. No sign-in, nothing
   private (services/parcel.js publicView). The token is 32 random hex
   characters, so links cannot be guessed. */
router.get('/track/:token', async (req, res) => {
  try {
    const t = String(req.params.token || '');
    if (!/^[a-f0-9]{32}$/.test(t)) return res.status(404).json({ success: false, message: 'Not found' });
    const ride = await Ride.findOne({ trackToken: t, source: 'parcel' })
      .select('-parcel.photo -pin')
      .populate('driver', 'name').populate('customer', 'name');
    if (!ride) return res.status(404).json({ success: false, message: 'Not found' });
    let loc = null;
    if (ride.driver) {
      const prof = await DriverProfile.findOne({ user: ride.driver._id }).select('currentLocation locationUpdatedAt');
      const c = prof && prof.currentLocation && prof.currentLocation.coordinates;
      if (c && (c[0] || c[1]) && prof.locationUpdatedAt && (Date.now() - prof.locationUpdatedAt) < 15 * 60 * 1000) loc = c;
    }
    res.json({ success: true, parcel: require('../services/parcel').publicView(ride, loc) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/rides/:id/accept - Driver accepts a ride
router.put('/:id/accept', protect, driverAccess, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) {
      return res.status(404).json({ success: false, message: 'Ride not found' });
    }
    if (ride.status !== 'requested') {
      return res.status(400).json({ success: false, message: 'Ride already taken' });
    }
    // A parcel reaches 'requested' only once paid; this is the second lock on the door.
    if (ride.source === 'parcel' && ride.paymentStatus !== 'paid') {
      return res.status(409).json({ success: false, message: 'This parcel is not paid' });
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
    if (myProfile.status === 'approved' && !(await require('../services/msouwoutDriver').stillApproved(myProfile))) {
      return res.status(403).json({ success: false, message: 'Your driver account is ' + myProfile.status });
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

    // A shop under a demo lock: only its named drivers, even when the job is
    // waiting un-offered (offeredTo null) - that state is otherwise open to all.
    if (ride.store) {
      const only = await require('../services/deliveryDispatch').lockedDrivers(ride.store);
      if (only && only.indexOf(String(req.user._id)) === -1) {
        return res.status(403).json({ success: false, message: 'This delivery is reserved for another driver' });
      }
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

    /* 16 Oct 2026: ONE conditional update. Two drivers accepting at the same
       instant used to both succeed (read, check, save); now exactly one wins
       and the other is told the job is gone. A driver who already accepted
       and dropped this job cannot take it again. */
    if (ride.order) {
      const Order = require('../models/Order');
      const linked = await Order.findById(ride.order).select('status paymentStatus');
      if (!linked || linked.status === 'cancelled' || linked.paymentStatus !== 'paid') {
        return res.status(409).json({ success: false, message: 'This order was cancelled or is not paid' });
      }
    }
    /* 5 Nov 2026, Jeffery: "A driver should only receive new requests when available." One job at a
       time, counted across MyPlopPlop (deliveries, parcels) AND MsouWout (passenger rides). */
    const BUSY = require('../services/driverBusy');
    const BUSY_MSG = 'Ou gen yon travay ki poko fini (kous oswa livrezon). Fini l anvan ou pran yon lòt.';
    const UNVERIFIED_MSG = 'Nou pa ka verifye kounye a si ou lib (MsouWout pa reponn). Eseye ankò nan kèk segonn.';
    const OAVCT_MSG = 'OAVCT ou ekspire. Ou pa ka pran nouvo livrezon jiskaske nouvo OAVCT ou verifye.';
    const st = await BUSY.check(myProfile);
    if (st.held) return res.status(403).json({ success: false, code: 'oavct_expired', message: OAVCT_MSG });
    if (st.busy) {
      return res.status(409).json({ success: false, code: st.unverified ? 'busy_unverified' : 'driver_busy',
        message: st.unverified ? UNVERIFIED_MSG : BUSY_MSG });
    }
    const now = new Date();
    const won = await Ride.findOneAndUpdate(
      { _id: ride._id, status: 'requested', driver: null, droppedBy: { $ne: req.user._id }, needsDriverPay: { $ne: true },
        $or: [{ offeredTo: null }, { offeredTo: req.user._id, offerExpiresAt: { $gt: now } }] },
      { $set: { driver: req.user._id, status: 'accepted', acceptedAt: now, offeredTo: null, offerExpiresAt: null,
                pickupCode: ride.order ? String(Math.floor(1000 + Math.random() * 9000)) : undefined } },
      { new: true });
    if (!won) {
      return res.status(409).json({ success: false, message: 'Ride already taken' });
    }
    /* two of his own taps in the same second: keep the first job, hand this one back */
    const handBack = function () {
      return Ride.updateOne({ _id: won._id, driver: req.user._id, status: 'accepted' },
        { $set: { status: 'requested', driver: null, acceptedAt: null, pickupCode: null } });
    };
    if (await Ride.countDocuments({ driver: req.user._id, status: { $in: BUSY.ACTIVE } }) > 1) {
      await handBack();
      return res.status(409).json({ success: false, code: 'driver_busy', message: BUSY_MSG });
    }
    /* 5 Nov 2026 15:05, Jeffery: "If either server cannot verify the driver's availability, the system must
       refuse a new assignment." The job is his only once MsouWout grants the lock (services/driverLock.js);
       a passenger ride taken meanwhile, or no answer, hands the job back. */
    const lk = await require('../services/driverLock').acquire(won, myProfile);
    if (!lk.ok && lk.reason === 'oavct_expired') {
      await handBack();
      return res.status(403).json({ success: false, code: 'oavct_expired', message: OAVCT_MSG });
    }
    if (!lk.ok) {
      await handBack();
      return res.status(409).json({ success: false, code: lk.reason === 'unverified' ? 'busy_unverified' : 'driver_busy',
        message: lk.reason === 'unverified' ? UNVERIFIED_MSG : BUSY_MSG });
    }

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
    if (ride.source === 'parcel') {
      sendPushToUser(ride.customer, 'Chofè jwenn pou koli ou', req.user.name + ' ap vin pran koli a.', { url: '/voye-koli.html?ride=' + ride._id }).catch(() => {});
    } else if (ride.type === 'delivery' && ride.order) {
      sendPushToUser(ride.customer, 'Chofè jwenn', req.user.name + ' ap ale chèche kòmand ou nan magazen an.', { url: '/order-status.html?id=' + ride.order }).catch(() => {});
      if (ride.store) {
        const Store = require('../models/Store');
        const st = await Store.findById(ride.store).select('owner');
        if (st) sendPushToUser(st.owner, 'Chofè ap vini', req.user.name + ' ap vin chèche kòmand lan. Mande l kòd ranmasaj li.', { url: '/merchant/orders.html' }).catch(() => {});
      }
    } else {
      sendPushToUser(ride.customer, 'Driver Found!', req.user.name + ' is on the way to pick you up', {
        url: '/rides-tracking.html?id=' + ride._id
      }).catch(() => {});
    }

    res.json({ success: true, ride: forDriver(populated) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/rides/my-offer - The delivery currently offered to THIS driver (30s window),
// plus any job they've already accepted and are still working on.
router.get('/my-offer', protect, driverAccess, async (req, res) => {
  try {
    const offer = await Ride.findOne({
      type: 'delivery',
      status: 'requested',
      offeredTo: req.user._id,
      offerExpiresAt: { $gt: new Date() }
    }).populate('customer', 'name phone').populate('store', 'name');

    let active = await Ride.findOne({
      driver: req.user._id,
      status: { $in: ['accepted', 'picking_up', 'in_progress'] }
    }).populate('customer', 'name phone').populate('store', 'name');

    // A shop delivery accepted before pickup codes existed (16 Oct 2026) gets
    // one now, once, so the shop can still hand it over.
    if (active && active.order && !active.pickupCode && ['accepted', 'picking_up'].includes(active.status)) {
      await Ride.updateOne({ _id: active._id, status: { $in: ['accepted', 'picking_up'] }, $or: [{ pickupCode: null }, { pickupCode: { $exists: false } }] },
        { $set: { pickupCode: String(Math.floor(1000 + Math.random() * 9000)) } });
      active = await Ride.findById(active._id).populate('customer', 'name phone').populate('store', 'name');
    }

    const offerOut = forDriver(offer);
    if (offerOut) delete offerOut.pickupCode;
    res.json({ success: true, data: { offer: offerOut || null, active: forDriver(active) || null } });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/rides/:id/decline - Driver declines an offer → auto re-offer to next closest
router.put('/:id/decline', protect, driverAccess, async (req, res) => {
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


/* The two rewards a completed ride/delivery has always paid, unchanged:
   the old driver-refers-driver ambassador bonus and the LajanMaker agent
   commission for whoever recruited the driver. Moved here (16 Oct 2026) so
   the shop-delivery path pays them exactly like the passenger path. */
async function rewardsAfterRide(reqUser, ride) {
  const req = { user: reqUser };
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


/* ═══ A SHOP DELIVERY, STEP BY STEP (16 Oct 2026) ════════════════════════════
   accepted   → picking_up   the driver says he is AT THE SHOP (the shop is told)
   picking_up → in_progress  NOT the driver: the SHOP types his pickup code
                             (POST /api/orders/:id/handover), so the wrong driver
                             cannot collect the parcel
   in_progress → delivered   only with the CUSTOMER's 4-digit code, checked here
                             on the server, 5 tries; completion goes through
                             services/orderLifecycle.js, which credits the shop
                             and the driver's 80% exactly once
   accepted / picking_up → cancelled  the driver drops it: the job goes back to
                             searching, never to him again                   */
/* A parcel's steps (27 Oct 2026). No shop, so no pickup code: the driver says
   when they are at the sender and when they have the package; the RECIPIENT's
   4-digit code finishes it (services/parcel.js complete).
     accepted    → picking_up   "I'm at the pickup"
     picking_up  → in_progress  "I have the package"
     in_progress → delivered    recipient's code
   Before the package is in hand the driver may give the job back - it goes to
   the next driver, like a shop delivery. After that only an admin can undo it. */
async function parcelStatus(req, res, ride, status) {
  const P = require('../services/parcel');
  const io = req.app.get('io');
  const next = { accepted: ['picking_up', 'cancelled'], picking_up: ['in_progress', 'cancelled'], in_progress: ['delivered'] };
  if (!next[ride.status] || next[ride.status].indexOf(status) === -1) {
    return res.status(400).json({ success: false, message: 'Cannot change from ' + ride.status + ' to ' + status });
  }
  if (status === 'cancelled') {
    const back = await require('../services/deliveryDispatch').returnToSearch(ride._id, req.user._id, String(req.body.reason || '').slice(0, 200), io);
    if (!back) return res.status(409).json({ success: false, message: 'This delivery can no longer be given back' });
    return res.json({ success: true, ride: forDriver(back) });
  }
  if (status === 'delivered') {
    const out = await P.complete(ride, req.user, req.body.pin);
    if (!out.ok) return res.status(out.code).json({ success: false, code: out.codeName, message: out.message });
    if (io) io.to('ride_' + ride._id).emit('ride_status', { rideId: ride._id, status: 'delivered' });
    sendPushToUser(ride.customer, 'Koli a livre ✅', 'Moun nan resevwa koli a.', { url: '/voye-koli.html?ride=' + ride._id }).catch(() => {});
    try { await rewardsAfterRide(req.user, out.ride); } catch (e) { /* rewards never block a delivery */ }
    return res.json({ success: true, ride: forDriver(out.ride), earned: out.ride.fare.driverEarning });
  }
  const set = { status: status };
  if (status === 'in_progress') set.pickedUpAt = new Date();
  const moved = await Ride.findOneAndUpdate({ _id: ride._id, status: ride.status, driver: req.user._id }, { $set: set }, { new: true });
  if (!moved) return res.status(409).json({ success: false, message: 'This delivery changed. Refresh.' });
  if (io) io.to('ride_' + ride._id).emit('ride_status', { rideId: ride._id, status: status });
  if (status === 'in_progress') {
    sendPushToUser(ride.customer, 'Koli a an wout', 'Chofè a pran koli a, l ap pote l bay moun nan.', { url: '/voye-koli.html?ride=' + ride._id }).catch(() => {});
  }
  return res.json({ success: true, ride: forDriver(moved) });
}

async function shopDeliveryStatus(req, res, ride, status) {
  const Order = require('../models/Order');
  const lifecycle = require('../services/orderLifecycle');
  const io = req.app.get('io');
  if (status === 'picking_up') {
    const r = await Ride.findOneAndUpdate({ _id: ride._id, driver: req.user._id, status: 'accepted' }, { $set: { status: 'picking_up' } }, { new: true });
    if (!r) return res.status(409).json({ success: false, message: 'Cannot change from ' + ride.status + ' to picking_up' });
    if (ride.store) {
      const Store = require('../models/Store');
      const st = await Store.findById(ride.store).select('owner');
      if (st) sendPushToUser(st.owner, 'Chofè a rive', req.user.name + ' rive pou kòmand lan. Mande l kòd ranmasaj li anvan ou ba li.', { url: '/merchant/orders.html' }).catch(() => {});
      if (io) io.to('store_' + ride.store).emit('driver_arrived', { orderId: ride.order, rideId: ride._id });
    }
    sendPushToUser(ride.customer, 'Chofè a nan magazen an', 'Chofè a rive nan magazen an pou pran kòmand ou.', { url: '/order-status.html?id=' + ride.order }).catch(() => {});
    return res.json({ success: true, ride: forDriver(r) });
  }
  if (status === 'in_progress') {
    return res.status(409).json({ success: false, code: 'shop_confirms_pickup', message: 'Show your pickup code to the shop. The shop confirms the pickup.' });
  }
  if (status === 'cancelled') {
    const r = await require('../services/deliveryDispatch').returnToSearch(ride._id, req.user._id, req.body.reason || 'driver cancelled', io);
    if (!r) return res.status(409).json({ success: false, message: 'You can only drop a delivery before you have picked it up' });
    await lifecycle.log(req.user, 'delivery.driver_dropped', await Order.findById(ride.order), { reason: req.body.reason || '' });
    return res.json({ success: true, message: 'The delivery goes back to the next driver' });
  }
  if (status === 'delivered') {
    if (ride.status !== 'in_progress') {
      return res.status(409).json({ success: false, message: 'The shop has not confirmed the pickup yet' });
    }
    const order = await Order.findById(ride.order);
    if (!order) return res.status(404).json({ success: false, message: 'Order not found' });
    const pin = await lifecycle.checkPin(order, req.body.pin);
    if (!pin.ok) return res.status(pin.code).json({ success: false, code: 'pin_required', message: pin.message });
    const out = await lifecycle.completeDelivery(order, { via: 'pin', ride: ride, actor: req.user });
    if (!out.ok) return res.status(out.code).json({ success: false, message: out.message });
    await DriverProfile.findOneAndUpdate({ user: req.user._id }, { $inc: { totalDeliveries: 1, totalEarnings: out.order.deliveryDriverCut || 0 } });
    await rewardsAfterRide(req.user, ride);
    const fresh = await Ride.findById(ride._id);
    if (io) io.to(`ride_${ride._id}`).emit('ride_status', { rideId: ride._id, status: 'delivered' });
    return res.json({ success: true, ride: forDriver(fresh), earned: out.order.deliveryDriverCut });
  }
  return res.status(400).json({ success: false, message: 'Unknown status' });
}

// PUT /api/rides/:id/status - Update ride status
router.put('/:id/status', protect, driverAccess, async (req, res) => {
  try {
    const { status } = req.body;
    const ride = await Ride.findById(req.params.id);

    if (!ride) {
      return res.status(404).json({ success: false, message: 'Ride not found' });
    }
    if (!ride.driver || ride.driver.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not your ride' });
    }
    /* 16 Oct 2026: a driver rejected or suspended after accepting cannot go on
       and be paid. */
    const myProf = await DriverProfile.findOne({ user: req.user._id }).select('status');
    if (!myProf || myProf.status !== 'approved') {
      return res.status(403).json({ success: false, message: 'Your driver account is not active' });
    }
    if (ride.type === 'delivery' && ride.order) {
      return shopDeliveryStatus(req, res, ride, status);
    }
    if (ride.source === 'parcel') {
      return parcelStatus(req, res, ride, status);
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
        description: 'Platform share (' + Math.round(require('../utils/fareCalculator').commissionRateFor(ride.type) * 100) + '%) from ' + ride.type
      });

      await rewardsAfterRide(req.user, ride);
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

    res.json({ success: true, ride: forDriver(ride) });
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
    /* A parcel: the sender can cancel freely before paying. Once paid, the
       money has to come back, and his rule is "Do not automatically issue
       refunds" - so a paid parcel is cancelled by a person, not by a button. */
    if (ride.source === 'parcel') {
      /* 5 Nov 2026: paid but NO driver has taken it yet - the sender may cancel; the money is
         recorded as a refund OWED, paid back by a person (services/parcel.js oweRefund). */
      if (ride.status === 'requested' && ride.paymentStatus === 'paid' && !ride.driver) {
        const P = require('../services/parcel');
        const c = await P.oweRefund(ride._id, ['requested'], 'sender_cancelled', 'customer', req.app.get('io'));
        if (!c) return res.status(409).json({ success: false, message: 'Yon chofè fèk pran koli a. Rafrechi paj la.' });
        const o = forCustomer(c); delete o.parcel;
        return res.json({ success: true, ride: o, refund: { amount: c.refund.amount, status: c.refund.status } });
      }
      if (ride.status !== 'awaiting_payment' || ride.paymentStatus === 'paid') {
        return res.status(409).json({ success: false, code: 'needs_support',
          message: 'Koli a deja peye. Pou anile l, ekri nou sou WhatsApp: n ap gade l avè w.' });
      }
      // Ask the gateway first: paid a second ago means it is already a delivery.
      const chk = await require('../services/parcel').checkPending(ride, req.app.get('io'), { source: 'cancel_check' });
      if (chk.paid) {
        return res.status(409).json({ success: false, code: 'needs_support', message: 'Koli a fèk peye, yon chofè ap vini. Pou anile l, ekri nou sou WhatsApp.' });
      }
      const c = await Ride.findOneAndUpdate({ _id: ride._id, status: 'awaiting_payment' },
        { $set: { status: 'cancelled', cancelledAt: new Date(), cancelledBy: 'customer', cancelReason: String(req.body.reason || '').slice(0, 200) } }, { new: true });
      if (!c) return res.status(409).json({ success: false, message: 'Koli a chanje. Rafrechi paj la.' });
      /* The payment attempts stay 'pending' on purpose: a gateway page left
         open in another tab can still be paid, and services/parcel.js tick
         must find that money and flag it for a refund by a person. */
      const o = forCustomer(c); delete o.parcel;
      return res.json({ success: true, ride: o });
    }
    // A shop delivery is cancelled by cancelling the ORDER, with its rules
    // (16 Oct 2026): before the shop starts preparing, and with a refund if paid.
    if (ride.order) {
      const Order = require('../models/Order');
      const order = await Order.findById(ride.order);
      const out = await require('../services/orderLifecycle').cancelOrder(order, { role: 'customer', reason: req.body.reason, actor: req.user, io: req.app.get('io') });
      if (!out.ok) return res.status(out.code || 409).json({ success: false, message: out.message });
      return res.json({ success: true, ride: forCustomer(await Ride.findById(ride._id)), refund: out.refund ? { amount: out.refund.amount, status: out.refund.status } : undefined });
    }

    ride.status = 'cancelled';
    ride.cancelledAt = new Date();
    ride.cancelledBy = 'customer';
    ride.cancelReason = req.body.reason || '';
    await ride.save();

    if (req.app.get('io')) {
      req.app.get('io').to(`ride_${ride._id}`).emit('ride_cancelled', { rideId: ride._id });
    }

    res.json({ success: true, ride: forCustomer(ride) });
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
    res.json({ success: true, ride: String(ride.customer) === String(req.user._id) ? forCustomer(ride) : forDriver(ride) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/rides - Get user's rides
router.get('/', protect, async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const query = {};

    // An admin or a shop owner can also be a driver (driver profile, own role
    // kept): they see the rides they drove AND the ones they ordered.
    const both = req.user.role !== 'driver' && await DriverProfile.exists({ user: req.user._id });
    if (req.user.role === 'driver') {
      query.driver = req.user._id;
    } else if (both) {
      query.$or = [{ driver: req.user._id }, { customer: req.user._id }];
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

    // 16 Oct 2026: a driver's own ride list carried the customer's delivery code
    const isDrv = req.user.role === 'driver';
    const me = String(req.user._id);
    const view = function (r) {
      if (isDrv) return forDriver(r);
      const d = r.driver && (r.driver._id || r.driver);
      return d && String(d) === me ? forDriver(r) : forCustomer(r);
    };
    res.json({ success: true, count: rides.length, total, page: parseInt(page), rides: rides.map(view) });
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
router.get('/available', protect, driverAccess, async (req, res) => {
  try {
    const myProfile = await DriverProfile.findOne({ user: req.user._id });
    if (!myProfile || myProfile.status !== 'approved') {
      return res.json({
        success: true, count: 0, rides: [],
        message: 'Your driver application has not been approved yet'
      });
    }

    /* 5 Nov 2026: a driver on a job (here or on MsouWout) is shown nothing new */
    if (await require('../services/driverBusy').isBusy(myProfile)) {
      return res.json({ success: true, count: 0, rides: [], busy: true });
    }
    const rides = await Ride.find({
      status: 'requested', needsDriverPay: { $ne: true },
      type: { $in: myProfile.services && myProfile.services.length ? myProfile.services : ['delivery'] }
    })
      .populate('customer', 'name phone')
      .sort({ createdAt: -1 })
      .limit(50);

    // a locked shop's job is not listed for drivers it is not reserved for
    const Store = require('../models/Store');
    const locked = await Store.find({ 'dispatchLock.drivers.0': { $exists: true } }).select('dispatchLock').lean();
    const me = String(req.user._id);
    const hidden = locked.filter(function (s) { return s.dispatchLock.drivers.map(String).indexOf(me) === -1; }).map(function (s) { return String(s._id); });
    // never the customer's delivery code, never another driver's pickup code
    const out = rides.filter(function (r) { return !r.store || hidden.indexOf(String(r.store)) === -1; })
      .map(function (r) { const o = forDriver(r); delete o.pickupCode; return o; });
    res.json({ success: true, count: out.length, rides: out });
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

    /* 🛑 15 Oct 2026: only the people on this ride may read it. It answered
       ANY logged-in user with the customer's name, phone, addresses, GPS and
       the delivery code. Allowed: the customer, the driver, an admin, and -
       for a delivery - the owner of the shop it is for. Same 404 as a missing
       ride, so it cannot be used to discover which rides exist.
       The delivery code goes ONLY to the customer: the driver must get it
       from the customer at the door, or it proves nothing. */
    const me = String(req.user._id);
    const isCustomer = ride.customer && String(ride.customer._id || ride.customer) === me;
    const isDriver = ride.driver && String(ride.driver._id || ride.driver) === me;
    let isShop = false;
    if (!isCustomer && !isDriver && req.user.role !== 'admin' && ride.order) {
      const Order = require('../models/Order'), Store = require('../models/Store');
      const o = await Order.findById(ride.order).select('store');
      const st = o && await Store.findById(o.store).select('owner');
      isShop = !!(st && String(st.owner) === me);
    }
    if (!isCustomer && !isDriver && !isShop && req.user.role !== 'admin') {
      return res.status(404).json({ success: false, message: 'Ride not found' });
    }
    const out = ride.toObject();
    if (!isCustomer && req.user.role !== 'admin') delete out.pin;
    if (!isDriver && req.user.role !== 'admin') delete out.pickupCode;
    res.json({ success: true, ride: out });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
