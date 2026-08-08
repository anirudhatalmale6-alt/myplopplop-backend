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

// Find the nearest online, approved delivery driver not already tried.
async function findNearestDriver(pickupLngLat, excludeUserIds) {
  const profile = await DriverProfile.findOne({
    status: 'approved',
    isOnline: true,
    services: 'delivery',
    user: { $nin: excludeUserIds || [] },
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
  const pickupLngLat = [lng(ride.pickup.coordinates), lat(ride.pickup.coordinates)];
  const profile = await findNearestDriver(pickupLngLat, ride.attemptedDrivers);

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

  const pLng = lng(store.address && store.address.coordinates);
  const pLat = lat(store.address && store.address.coordinates);
  const dLng = lng(order.deliveryAddress && order.deliveryAddress.coordinates);
  const dLat = lat(order.deliveryAddress && order.deliveryAddress.coordinates);

  const distanceKm = haversineKm(pLat, pLng, dLat, dLng);
  const fareCalc = calculateFare('delivery', distanceKm);

  const pin = String(Math.floor(1000 + Math.random() * 9000));

  const ride = await Ride.create({
    type: 'delivery',
    customer: order.customer,
    order: order._id,
    store: store._id,
    recipient: order.recipient || undefined,
    pickup: {
      address: (store.address && store.address.street) || store.name,
      coordinates: (store.address && store.address.coordinates) || { type: 'Point', coordinates: [pLng, pLat] },
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
    pin: pin,
    attemptedDrivers: [],
    dispatchAttempts: 0
  });

  // Stamp the tracking + pin back on the order for the customer/store views
  order.rideId = ride._id;
  order.deliveryPin = pin;
  await order.save().catch(() => {});

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
    noDriverFound: true
  }).limit(25);

  for (const ride of stalled) {
    // after a full cycle with no takers, clear the tried list to reconsider everyone
    ride.attemptedDrivers = [];
    await ride.save();
    await offerToNextDriver(ride, io);
  }
}

module.exports = {
  createDeliveryRideForOrder,
  offerToNextDriver,
  declineOffer,
  dispatchTick,
  haversineKm,
  OFFER_WINDOW_MS
};
