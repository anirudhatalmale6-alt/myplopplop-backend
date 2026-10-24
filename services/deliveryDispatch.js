// Automatic delivery dispatch engine.
//
// When a store marks an order "ready", we create a delivery Ride and offer it to
// the single nearest online, approved, verified delivery driver. That driver has
// OFFER_WINDOW_MS (30s) to accept. If they decline or the window lapses, the job
// is automatically re-offered to the next closest driver — no human dispatching.
//
// A lightweight ticker (started in server.js) re-offers any timed-out offers.

const Ride = require('../models/Ride');
const Order = require('../models/Order');
const DriverProfile = require('../models/DriverProfile');
const { calculateFare } = require('../utils/fareCalculator');
const { sendPushToUser } = require('../routes/notifications');

const OFFER_WINDOW_MS = 30 * 1000; // 30 seconds to accept
const SEARCH_RADIUS_M = 15000;     // 15 km search radius for a driver
/* 16 Oct 2026: a driver whose app has not reported a position for this long
   is treated as gone (closed the app, no signal) and is not offered jobs. */
const LOCATION_FRESH_MS = 15 * 60 * 1000;
/* No driver has taken it for this long: tell the customer, the shop and the
   administrators (once), and keep searching. */
const NO_DRIVER_ALERT_MS = 10 * 60 * 1000;

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// [lng, lat] helpers (GeoJSON order)
function lng(coords) { return coords && coords.coordinates ? coords.coordinates[0] : 0; }
function lat(coords) { return coords && coords.coordinates ? coords.coordinates[1] : 0; }

// [0,0] is the schema default, not a place anyone shops from. Treat anything at
// or next to null island as "we do not know where this is".
function isRealPin(l, t) {
  return Number.isFinite(l) && Number.isFinite(t) && (Math.abs(l) > 0.01 || Math.abs(t) > 0.01);
}

// When there is no distance to price from, the delivery is worth what the
// customer was quoted and charged at checkout. The delivery split: 80% driver,
// 20% HaitiBiznis (utils/fareCalculator.js) - the same split the order records.
function fareFromQuote(quoted) {
  const { commissionRateFor, RATES } = require('../utils/fareCalculator');
  const total = Math.round(Number(quoted) > 0 ? Number(quoted) : RATES.delivery.minFare);
  const commission = Math.round(total * commissionRateFor('delivery'));
  return { totalFare: total, commission, driverEarning: total - commission };
}

/* The drivers a LOCKED shop's deliveries are reserved for (Store.dispatchLock),
   as strings, or null when the shop dispatches normally. */
async function lockedDrivers(storeId) {
  if (!storeId) return null;
  const Store = require('../models/Store');
  const st = await Store.findById(storeId).select('dispatchLock').lean();
  const list = st && st.dispatchLock && st.dispatchLock.drivers;
  return list && list.length ? list.map(String) : null;
}

// Find the nearest online, approved delivery driver not already tried.
// `only`: a locked shop - nobody outside this list, at any distance.
async function findNearestDriver(pickupLngLat, excludeUserIds, only) {
  if (only) {
    const ex = (excludeUserIds || []).map(String);
    return DriverProfile.findOne({
      status: 'approved',
      isOnline: true,
      services: 'delivery',
      user: { $in: only.filter(function (u) { return ex.indexOf(u) === -1; }) },
      locationUpdatedAt: { $gte: new Date(Date.now() - LOCATION_FRESH_MS) }
    }).populate('user', 'name phone');
  }
  const profile = await DriverProfile.findOne({
    status: 'approved',
    isOnline: true,
    services: 'delivery',
    user: { $nin: excludeUserIds || [] },
    locationUpdatedAt: { $gte: new Date(Date.now() - LOCATION_FRESH_MS) },
    currentLocation: {
      $near: {
        $geometry: { type: 'Point', coordinates: pickupLngLat },
        $maxDistance: SEARCH_RADIUS_M
      }
    }
  }).populate('user', 'name phone');
  return profile;
}

// Offer a ride to the next closest driver. Returns true if an offer was sent.
async function offerToNextDriver(ride, io) {
  if (ride.needsDriverPay) return null;
  const pickupLngLat = [lng(ride.pickup.coordinates), lat(ride.pickup.coordinates)];
  // never re-offer to a driver who already accepted this job and dropped it
  const profile = await findNearestDriver(pickupLngLat, (ride.attemptedDrivers || []).concat(ride.droppedBy || []),
    await lockedDrivers(ride.store));

  if (!profile || !profile.user) {
    ride.offeredTo = null;
    ride.offerExpiresAt = null;
    ride.noDriverFound = true; // no one available right now; ticker will retry
    await ride.save();
    if (io) io.to('store_' + ride.store).emit('dispatch_searching', { rideId: ride._id, orderId: ride.order });
    return false;
  }

  ride.offeredTo = profile.user._id;
  ride.offerExpiresAt = new Date(Date.now() + OFFER_WINDOW_MS);
  ride.noDriverFound = false;
  ride.dispatchAttempts = (ride.dispatchAttempts || 0) + 1;
  await ride.save();

  const distKm = haversineKm(lat(profile.currentLocation), lng(profile.currentLocation),
    lat(ride.pickup.coordinates), lng(ride.pickup.coordinates));

  // Real-time offer to the driver + push
  if (io) {
    io.to('driver_' + profile.user._id).emit('delivery_offer', {
      rideId: ride._id,
      orderId: ride.order,
      pickup: ride.pickup,
      dropoff: ride.dropoff,
      fare: ride.fare,
      distanceToPickupKm: Math.round(distKm * 10) / 10,
      expiresAt: ride.offerExpiresAt
    });
  }
  sendPushToUser(profile.user._id, 'New delivery — accept now',
    'Pickup at ' + (ride.pickup.address || 'store') + ' · You earn ' + (ride.fare.driverEarning || 0) + ' HTG',
    { url: '/driver-delivery.html?ride=' + ride._id }).catch(() => {});

  return true;
}

// Build a delivery Ride from a marketplace order and kick off dispatch.
async function createDeliveryRideForOrder(order, store, io) {
  // Guard: don't create a second ride for the same order
  const existing = await Ride.findOne({ order: order._id });
  if (existing) return existing;
  /* 16 Oct 2026: ⛔ never send a driver for an order that is not PAID (the
     server's own confirmation) or that was cancelled. */
  const fresh = await Order.findById(order._id);
  if (!fresh || fresh.paymentStatus !== 'paid' || fresh.status === 'cancelled') {
    console.warn('Dispatch refused for order ' + order.orderNumber + ': not paid or cancelled');
    return null;
  }
  order = fresh;

  let pLng = lng(store.address && store.address.coordinates);
  let pLat = lat(store.address && store.address.coordinates);
  const dLng = lng(order.deliveryAddress && order.deliveryAddress.coordinates);
  const dLat = lat(order.deliveryAddress && order.deliveryAddress.coordinates);

  // No page has ever asked a shop for its GPS, so every store sits at the schema
  // default [0,0] — a point in the Atlantic off Africa. Measured from there a
  // 6 km delivery came out as 8148 km and 203,808 HTG, and the search for a
  // driver "within 15 km of the shop" looked in the ocean and found nobody,
  // with a rider standing 6 km away. Never price or dispatch from [0,0].
  const hasShopPin = isRealPin(pLng, pLat);
  const hasCustomerPin = isRealPin(dLng, dLat);

  let distanceKm = 0;
  let fareCalc;
  if (hasShopPin && hasCustomerPin) {
    distanceKm = haversineKm(pLat, pLng, dLat, dLng);
    fareCalc = calculateFare('delivery', distanceKm);
  } else {
    // Fall back to the price the customer was actually quoted and charged at
    // checkout rather than inventing one from a distance we do not have.
    console.warn('Dispatch for order ' + order.orderNumber + ': shop has no GPS' +
      (hasCustomerPin ? '' : ' and neither has the customer') +
      ' - using the quoted delivery fee instead of a distance.');
    fareCalc = fareFromQuote(order.deliveryFee);
    // Look for a driver near the customer instead of near a shop we cannot place.
    if (!hasShopPin && hasCustomerPin) {
      pLng = dLng;
      pLat = dLat;
    }
  }

  /* The customer's own code, made when the payment was confirmed and shown
     only to them. One code from payment to door. */
  const pin = order.deliveryPin || String(Math.floor(1000 + Math.random() * 9000));
  /* 16 Oct 2026: the driver is offered exactly what the order stores as his
     80% of the delivery fee the customer PAID - never a fare recalculated
     from a distance, which could differ from what was charged. */
  fareCalc = { totalFare: Number(order.deliveryFee) || 0, commission: Number(order.deliveryPlatformCut) || 0, driverEarning: Number(order.deliveryDriverCut) || 0 };

  // routes/orders.js stores `recipient: null` on every ordinary (non-diaspora)
  // order. `recipient` is a NESTED PATH, so mongoose hands back a truthy wrapper
  // for it even then — `order.recipient || undefined` keeps the null, Ride
  // validation rejects it, and the whole dispatch throws into a catch that only
  // logs. The order still went to "ready", so nothing looked wrong. Rebuild it
  // as a plain object, or leave the key out altogether.
  const rcp = order.recipient && order.recipient.name
    ? { name: order.recipient.name, phone: order.recipient.phone, address: order.recipient.address }
    : null;

  const ride = await Ride.create(Object.assign({
    type: 'delivery',
    customer: order.customer,
    order: order._id,
    store: store._id,
    pickup: {
      address: (store.address && store.address.street) || store.name,
      // pLng/pLat, not store.address.coordinates: for a shop with no GPS those
      // are [0,0], and offerToNextDriver searches around exactly this point.
      coordinates: { type: 'Point', coordinates: [pLng, pLat] },
      notes: 'Ranmase komann #' + order.orderNumber
    },
    dropoff: {
      address: (order.deliveryAddress && (order.deliveryAddress.street || order.deliveryAddress.city)) || 'Adrès livrezon',
      coordinates: (order.deliveryAddress && order.deliveryAddress.coordinates) || { type: 'Point', coordinates: [dLng, dLat] }
    },
    items: (order.items || []).map(function (i) { return { name: i.name, quantity: i.quantity, price: i.price, store: store.name }; }),
    distanceKm: Math.round(distanceKm * 10) / 10,
    fare: { total: fareCalc.totalFare, commission: fareCalc.commission, driverEarning: fareCalc.driverEarning },
    paymentMethod: order.paymentMethod || 'cash',
    paymentStatus: order.paymentStatus === 'paid' ? 'paid' : 'pending',
    status: 'requested',
    needsDriverPay: !(fareCalc.driverEarning > 0),
    pin: pin,
    attemptedDrivers: [],
    dispatchAttempts: 0,
    searchingSince: new Date()
  }, rcp ? { recipient: rcp } : {}));

  // Stamp the tracking + pin back on the order for the customer/store views
  order.rideId = ride._id;
  order.deliveryPin = pin;
  await order.save().catch(() => {});

  if (ride.needsDriverPay) {
    // ⛔ never ask a driver to work for 0: an admin sets the pay first.
    const ActivityLog = require('../models/ActivityLog'), User = require('../models/User');
    await ActivityLog.create({ action: 'delivery.needs_driver_pay', targetType: 'Order', targetId: order._id,
      detail: { orderNumber: order.orderNumber, rideId: String(ride._id), deliveryFee: order.deliveryFee || 0 } }).catch(() => {});
    const admins = await User.find({ role: 'admin' }).select('_id');
    for (const a of admins) sendPushToUser(a._id, 'Livrezon san peman chofè', 'Kòmand #' + order.orderNumber + ': fikse peman chofè a anvan nou voye l.', { url: '/admin/dashboard.html' }).catch(() => {});
    return ride;
  }
  await offerToNextDriver(ride, io);
  return ride;
}

// Called by a driver declining an offer → immediately move to the next driver.
async function declineOffer(ride, driverUserId, io) {
  if (!ride.attemptedDrivers.map(String).includes(String(driverUserId))) {
    ride.attemptedDrivers.push(driverUserId);
  }
  ride.offeredTo = null;
  ride.offerExpiresAt = null;
  await ride.save();
  return offerToNextDriver(ride, io);
}

/* A driver who ACCEPTED and then cancels (or is suspended mid-job): the job
   goes back to searching, never to him again, and everyone is told. One
   conditional update, so it cannot happen twice or race a completion. */
async function returnToSearch(rideId, driverUserId, reason, io) {
  const now = new Date();
  const ride = await Ride.findOneAndUpdate(
    { _id: rideId, driver: driverUserId, status: { $in: ['accepted', 'picking_up'] } },
    { $set: { status: 'requested', driver: null, acceptedAt: null, pickupCode: null, offeredTo: null, offerExpiresAt: null,
              noDriverFound: false, searchingSince: now, noDriverAlertedAt: null },
      $addToSet: { droppedBy: driverUserId, attemptedDrivers: driverUserId } },
    { new: true });
  if (!ride) return null;
  if (ride.order) await Order.updateOne({ _id: ride.order, rider: driverUserId }, { $unset: { rider: 1 } });
  sendPushToUser(ride.customer, 'Nou chèche yon lòt chofè', 'Chofè a pa ka fè livrezon an. N ap chèche yon lòt.', { url: '/orders.html' }).catch(() => {});
  if (io && ride.store) io.to('store_' + ride.store).emit('dispatch_searching', { rideId: ride._id, orderId: ride.order, reason: reason });
  await offerToNextDriver(ride, io);
  return ride;
}

/* Ten minutes without a driver: tell the customer, the shop and every admin,
   once, and keep looking. */
async function alertNoDriver(ride, io) {
  const r = await Ride.findOneAndUpdate({ _id: ride._id, noDriverAlertedAt: null }, { $set: { noDriverAlertedAt: new Date() } });
  if (!r) return;
  const User = require('../models/User');
  const Store = require('../models/Store');
  const order = ride.order ? await Order.findById(ride.order) : null;
  if (order) await Order.updateOne({ _id: order._id }, { $set: { noDriverAlertedAt: new Date() } });
  const label = order ? '#' + order.orderNumber : String(ride._id);
  sendPushToUser(ride.customer, 'Pa gen chofè disponib pou kounye a', 'Kòmand ' + label + ': n ap kontinye chèche. Ou ka anile si ou vle.', { url: '/orders.html' }).catch(() => {});
  if (ride.store) {
    const st = await Store.findById(ride.store).select('owner');
    if (st) sendPushToUser(st.owner, 'Pa gen chofè ankò', 'Kòmand ' + label + ' ap tann yon chofè depi 10 minit.', { url: '/merchant/orders.html' }).catch(() => {});
  }
  const admins = await User.find({ role: 'admin' }).select('_id').limit(20);
  for (const a of admins) sendPushToUser(a._id, 'Livrezon san chofè', 'Kòmand ' + label + ' pa jwenn chofè depi 10 minit.', { url: '/admin/dashboard.html' }).catch(() => {});
  try {
    await require('../models/ActivityLog').create({ action: 'delivery.no_driver', targetType: 'Order', targetId: order && order._id, targetLabel: label, detail: { ride: ride._id, since: ride.searchingSince } });
  } catch (e) {}
}

// Ticker: re-offer any offers that timed out, and retry rides that found no driver.
async function dispatchTick(io) {
  const now = new Date();
  // 1) Timed-out offers → mark that driver as tried, re-offer to next closest
  const timedOut = await Ride.find({
    type: 'delivery',
    status: 'requested',
    offeredTo: { $ne: null },
    offerExpiresAt: { $lt: now }
  }).limit(25);

  for (const ride of timedOut) {
    if (ride.offeredTo && !ride.attemptedDrivers.map(String).includes(String(ride.offeredTo))) {
      ride.attemptedDrivers.push(ride.offeredTo);
    }
    ride.offeredTo = null;
    ride.offerExpiresAt = null;
    await ride.save();
    await offerToNextDriver(ride, io);
  }

  // 2) Rides that couldn't find any driver earlier → retry (drivers may have come online).
  //    Reset attempted list after everyone was exhausted so newly-online drivers are reconsidered.
  const stalled = await Ride.find({
    type: 'delivery',
    status: 'requested',
    offeredTo: null,
    noDriverFound: true,
    needsDriverPay: { $ne: true }
  }).limit(25);

  for (const ride of stalled) {
    // A cancelled order's ride is closed, never re-offered.
    if (ride.order) {
      const o = await Order.findById(ride.order).select('status paymentStatus');
      if (!o || o.status === 'cancelled' || o.paymentStatus !== 'paid') {
        await Ride.updateOne({ _id: ride._id, status: 'requested' }, { $set: { status: 'cancelled', cancelledAt: now, cancelledBy: 'admin', cancelReason: 'Order cancelled or unpaid' } });
        continue;
      }
    }
    // after a full cycle with no takers, clear the tried list to reconsider
    // everyone - except drivers who accepted and dropped it (droppedBy stays)
    ride.attemptedDrivers = [];
    await ride.save();
    await offerToNextDriver(ride, io);
  }

  // 3) Nobody for ten minutes: alert once.
  const longWait = await Ride.find({
    type: 'delivery', status: 'requested', noDriverAlertedAt: null,
    searchingSince: { $lt: new Date(now.getTime() - NO_DRIVER_ALERT_MS) }
  }).limit(25);
  for (const ride of longWait) await alertNoDriver(ride, io);
}

module.exports = {
  lockedDrivers,
  createDeliveryRideForOrder,
  returnToSearch,
  alertNoDriver,
  LOCATION_FRESH_MS,
  NO_DRIVER_ALERT_MS,
  offerToNextDriver,
  declineOffer,
  dispatchTick,
  haversineKm,
  OFFER_WINDOW_MS
};
