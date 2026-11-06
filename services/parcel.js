/* ═══ VOYE YON KOLI — a package from one person to another ══════════════════
 *
 * Jeffery, 27 Oct 2026: "Anyone should be able to send a package to another
 * person without purchasing anything from MyPlopPlop... Payment before
 * dispatch: MonCash, NatCash, or credit card. No driver assigned until
 * payment is confirmed... We are not building a new delivery platform. We're
 * completing the missing pieces of an existing system."
 *
 * So this file only holds what a parcel needs and a shop order does not:
 *   1. confirmPaid - the ONE place a parcel goes from 'awaiting_payment' to
 *      'requested' and is handed to the existing dispatcher
 *      (deliveryDispatch.offerToNextDriver, the same one shop orders use).
 *   2. checkPending / tick - the server asks the gateway itself, so a sender
 *      who paid and lost the connection on the way back is still served.
 *   3. complete - the recipient's code at the door, and the driver's 80%,
 *      held 24 h exactly like a shop delivery (orderLifecycle).
 *
 * ⛔ Nothing here ever charges anybody. It only READS the gateways.
 * ⛔ Nothing here refunds. A paid parcel that has to be undone goes to a
 *    person (his rule: "Do not automatically issue refunds"): since 5 Nov it is
 *    recorded as refund OWED (oweRefund) and listed in Jennifer's console.
 * ═══════════════════════════════════════════════════════════════════════════ */
const crypto = require('crypto');
const Ride = require('../models/Ride');
const Transaction = require('../models/Transaction');
const User = require('../models/User');
const DriverProfile = require('../models/DriverProfile');

const MAX_PIN_ATTEMPTS = 5;            // same as a shop order
const DRIVER_HOLD_HOURS = 24;          // same hold as a shop delivery's earning
const GIVE_UP_HOURS = 24;              // an unpaid parcel is closed after this
/* 5 Nov 2026: paid, and no driver has accepted it for this long -> cancelled, refund OWED. */
const NO_DRIVER_REFUND_MIN = Number(process.env.PARCEL_NO_DRIVER_MIN) || 30;

/* Haiti, generously: a coordinate outside this box is a typo or a trick. */
function inHaiti(lat, lng) {
  return isFinite(lat) && isFinite(lng) && lat > 17.9 && lat < 20.2 && lng > -74.6 && lng < -71.5;
}

function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function newPin() { return String(crypto.randomInt(1000, 10000)); }
function newTrackToken() { return crypto.randomBytes(16).toString('hex'); }

/* ─── 1. paid → dispatched ────────────────────────────────────────────────
   Two callers can race (the sender's page and the poller, or two taps): the
   transaction claim and the ride claim are both conditional single updates,
   so exactly one of them dispatches and the other gets already:true. */
async function confirmPaid(ride, txn, how, io) {
  const now = new Date();
  if (txn) {
    await Transaction.updateOne({ _id: txn._id, status: 'pending' }, { $set: { status: 'completed' } });
  }
  const won = await Ride.findOneAndUpdate(
    { _id: ride._id, source: 'parcel', status: 'awaiting_payment' },
    { $set: { status: 'requested', paymentStatus: 'paid', paidAt: now, searchingSince: now,
              paymentMethod: (txn && txn.method) || ride.paymentMethod,
              offeredTo: null, offerExpiresAt: null, noDriverFound: false } },
    { new: true });
  if (!won) return { ok: true, already: true };
  try {
    await require('../models/ActivityLog').create({ action: 'parcel.paid', targetType: 'Ride', targetId: won._id,
      targetLabel: 'Koli ' + String(won._id).slice(-6), detail: { amount: won.fare.total, via: how, method: won.paymentMethod } });
  } catch (e) { /* the log is not the payment */ }
  // The existing dispatcher: nearest approved, online delivery driver.
  try { await require('./deliveryDispatch').offerToNextDriver(won, io); }
  catch (e) { console.error('[PARCEL] dispatch after payment failed for ' + won._id + ':', e.message); }
  return { ok: true, ride: won };
}

/* A paid parcel that will not be delivered: cancel it (only if it is still in `fromStatuses`) and record
   the refund as OWED, once. Returns the updated ride, or null when it had already moved on. */
async function oweRefund(rideId, fromStatuses, reason, cancelledBy, io) {
  const now = new Date();
  const r = await Ride.findOne({ _id: rideId, source: 'parcel' }).select('fare paymentStatus status refund customer');
  if (!r || r.paymentStatus !== 'paid' || (r.refund && r.refund.status)) return null;
  const set = { 'refund.status': 'owed', 'refund.amount': Number(r.fare && r.fare.total) || 0, 'refund.reason': reason, 'refund.owedAt': now };
  const q = { _id: rideId, source: 'parcel', paymentStatus: 'paid', 'refund.status': { $exists: false } };
  if (fromStatuses) {
    q.status = { $in: fromStatuses };
    Object.assign(set, { status: 'cancelled', cancelledAt: now, cancelledBy: cancelledBy,
      cancelReason: reason === 'no_driver' ? 'No driver accepted within ' + NO_DRIVER_REFUND_MIN + ' minutes' : 'Cancelled by the sender before pickup',
      offeredTo: null, offerExpiresAt: null });
  }
  const done = await Ride.findOneAndUpdate(q, { $set: set }, { new: true });
  if (!done) return null;
  try {
    await require('../models/ActivityLog').create({ action: 'parcel.refund_owed', targetType: 'Ride', targetId: done._id,
      targetLabel: 'Koli ' + String(done._id).slice(-6), detail: { amount: done.refund.amount, reason: reason, method: done.paymentMethod } });
  } catch (e) { /* the log is not the refund */ }
  const msg = reason === 'no_driver'
    ? 'Pa gen chofè ki te pran koli ou a. N ap remèt ou ' + done.refund.amount + ' HTG.'
    : 'Koli a anile. N ap remèt ou ' + done.refund.amount + ' HTG.';
  try { await require('../routes/notifications').sendPushToUser(done.customer, 'Ranbousman koli', msg, { url: '/voye-koli.html?ride=' + done._id }); } catch (e) { /* push is best effort */ }
  try {
    const admins = await User.find({ role: 'admin' }).select('_id').limit(20);
    for (const a of admins) require('../routes/notifications').sendPushToUser(a._id, 'Koli pou ranbouse', done.refund.amount + ' HTG · ' + reason, { url: '/admin/dashboard.html' }).catch(function () {});
  } catch (e) { /* idem */ }
  return done;
}

/* Paid, still searching, nobody took it for NO_DRIVER_REFUND_MIN minutes. A driver who accepts in the
   same second wins: the update only matches a parcel that is still 'requested' with no driver. */
async function noDriverSweep(io, now) {
  const t = now || new Date();
  const old = await Ride.find({ source: 'parcel', status: 'requested', paymentStatus: 'paid', driver: null,
    searchingSince: { $lt: new Date(t.getTime() - NO_DRIVER_REFUND_MIN * 60000) } }).select('_id').limit(50);
  let n = 0;
  for (const r of old) {
    const done = await Ride.findOneAndUpdate({ _id: r._id, status: 'requested', driver: null }, { $set: { offeredTo: null, offerExpiresAt: null } });
    if (!done) continue;
    if (await oweRefund(r._id, ['requested'], 'no_driver', 'admin', io)) n++;
  }
  return n;
}

/* Does the gateway say THIS attempt was paid, in full? Unreachable is NOT
   "not paid" - it answers false and the caller asks again later. */
async function gatewaySaysPaid(txn, opts) {
  const o = opts || {};
  try {
    if (txn.method === 'card') {
      if (!txn.stripeSessionId) return false;
      const stripe = o.stripe || require('../utils/stripe');
      const c = await stripe.confirmCheckout(txn.stripeSessionId, txn.amount, 'htg');
      return !!(c && c.ok && c.paid);
    }
    const verify = o.verify || require('../routes/payments').verifySolutionIPPayment;
    const gw = await verify(txn.reference);
    const paidAmount = Number(gw && gw.montant);
    return !!(gw && gw.status === true && gw.trans_status === 'ok' && isFinite(paidAmount) && paidAmount + 1 >= Number(txn.amount));
  } catch (e) { return false; }
}

/* ─── 2. ask the gateway ──────────────────────────────────────────────────
   Returns { paid, ride } for the parcel. Every pending payment attempt of this
   parcel is checked (the sender may have tried MonCash, come back, then paid
   by card). The amount must match: a payment for less settles nothing. */
async function checkPending(ride, io, opts) {
  const o = opts || {};
  if (ride.status !== 'awaiting_payment') return { paid: ride.paymentStatus === 'paid', ride };
  const txns = await Transaction.find({ ride: ride._id, type: 'payment', status: 'pending' }).sort({ createdAt: -1 }).limit(5);
  for (const txn of txns) {
    const ok = await gatewaySaysPaid(txn, o);
    if (ok) {
      const out = await confirmPaid(ride, txn, o.source || 'check', io);
      return { paid: true, ride: out.ride || await Ride.findById(ride._id) };
    }
  }
  return { paid: false, ride };
}

/* Every minute: unpaid parcels younger than a day, on a widening schedule
   (each minute for the first half hour, then every ten). After a day: one last
   look, then the parcel is closed so it can never be dispatched late. */
async function tick(io, opts) {
  const now = (opts && opts.now) || new Date();
  const since = new Date(now.getTime() - GIVE_UP_HOURS * 3600 * 1000);
  const open = await Ride.find({ source: 'parcel', status: 'awaiting_payment', createdAt: { $gte: since } }).limit(200);
  let confirmed = 0;
  for (const ride of open) {
    const ageMin = (now - ride.createdAt) / 60000;
    if (ageMin > 30 && now.getMinutes() % 10 !== 0) continue;
    const hasTry = await Transaction.exists({ ride: ride._id, type: 'payment', status: 'pending' });
    if (!hasTry) continue;
    const r = await checkPending(ride, io, Object.assign({ source: 'server_poller' }, opts || {}));
    if (r.paid) confirmed++;
  }
  /* Cancelled by the sender before paying - but a gateway page left open can
     still be paid. Money found here is NOT dispatched (the sender said no) and
     NOT refunded automatically: it is recorded and flagged for a person. */
  const late = await Ride.find({ source: 'parcel', status: 'cancelled', cancelledBy: 'customer', paymentStatus: { $ne: 'paid' },
    createdAt: { $gte: since } }).limit(100);
  let paidAfterCancel = 0;
  for (const ride of late) {
    if ((now - ride.cancelledAt) > 30 * 60000 && now.getMinutes() % 10 !== 0) continue;
    const txns = await Transaction.find({ ride: ride._id, type: 'payment', status: 'pending' }).limit(5);
    for (const txn of txns) {
      if (!(await gatewaySaysPaid(txn, opts))) continue;
      const t = await Transaction.findOneAndUpdate({ _id: txn._id, status: 'pending' }, { $set: { status: 'completed' } });
      if (!t) continue;
      await Ride.updateOne({ _id: ride._id }, { $set: { paymentStatus: 'paid', paidAt: now } });
      await oweRefund(ride._id, null, 'paid_after_cancel', null, io);
      try {
        await require('../models/ActivityLog').create({ action: 'parcel.paid_after_cancel', targetType: 'Ride', targetId: ride._id,
          targetLabel: 'Koli ' + String(ride._id).slice(-6), detail: { amount: txn.amount, method: txn.method, reference: txn.reference, needsRefund: true } });
      } catch (e) { /* still counted below */ }
      console.warn('[PARCEL] paid AFTER the sender cancelled - refund needed by a person: ride ' + ride._id + ', ' + txn.amount + ' HTG');
      paidAfterCancel++;
      break;
    }
  }

  const stale = await Ride.find({ source: 'parcel', status: 'awaiting_payment', createdAt: { $lt: since } }).limit(100);
  let expired = 0;
  for (const ride of stale) {
    const r = await checkPending(ride, io, Object.assign({ source: 'server_poller_final' }, opts || {}));
    if (r.paid) { confirmed++; continue; }
    const c = await Ride.updateOne({ _id: ride._id, status: 'awaiting_payment' },
      { $set: { status: 'cancelled', cancelledAt: now, cancelledBy: 'admin', cancelReason: 'Not paid within ' + GIVE_UP_HOURS + ' hours' } });
    if (c.modifiedCount) {
      await Transaction.updateMany({ ride: ride._id, type: 'payment', status: 'pending' }, { $set: { status: 'failed' } });
      expired++;
    }
  }
  // Cancelled more than a day ago and never paid: those attempts are dead.
  await Transaction.updateMany({ type: 'payment', status: 'pending', createdAt: { $lt: since },
    ride: { $in: (await Ride.find({ source: 'parcel', status: 'cancelled', createdAt: { $lt: since } }).select('_id').limit(500)).map(function (r) { return r._id; }) } },
    { $set: { status: 'failed' } });
  const noDriverRefunds = await noDriverSweep(io, now);
  return { confirmed, expired, paidAfterCancel, noDriverRefunds };
}

/* ─── 3. at the door ──────────────────────────────────────────────────────
   The recipient's code completes it - wrong tries are counted, and after five
   only an administrator can finish it. The driver's 80% is credited ONCE
   (driverCreditedAt claim) and held 24 h, exactly like a shop delivery. */
async function complete(ride, driverUser, pin) {
  if ((ride.pinAttempts || 0) >= MAX_PIN_ATTEMPTS) {
    return { ok: false, code: 423, codeName: 'pin_locked', message: 'Twòp kòd ki pa bon. Yon administratè dwe tcheke livrezon sa a.' };
  }
  if (String(pin || '').trim() !== String(ride.pin)) {
    await Ride.updateOne({ _id: ride._id }, { $inc: { pinAttempts: 1 } });
    return { ok: false, code: 400, codeName: 'pin_required', message: 'Kòd la pa bon. Mande moun k ap resevwa a kòd 4 chif pa l la.' };
  }
  const now = new Date();
  const done = await Ride.findOneAndUpdate(
    { _id: ride._id, source: 'parcel', status: 'in_progress', driver: driverUser._id, paymentStatus: 'paid', driverCreditedAt: null },
    { $set: { status: 'delivered', deliveredAt: now, driverCreditedAt: now } },
    { new: true });
  if (!done) return { ok: false, code: 409, message: 'This delivery is already finished or not yours.' };
  const cut = Number(done.fare.driverEarning) || 0;
  if (cut > 0) {
    await User.updateOne({ _id: driverUser._id }, { $inc: { 'wallet.pending_balance': cut } });
    await Transaction.create({ user: driverUser._id, ride: done._id, type: 'earning', amount: cut, currency: 'HTG', method: 'wallet',
      status: 'pending', earningOf: 'driver', releaseAt: new Date(now.getTime() + DRIVER_HOLD_HOURS * 3600 * 1000),
      reference: 'koli_' + String(done._id).slice(-8), description: 'Parcel delivery (80% of ' + done.fare.total + ' HTG)' });
  }
  await Transaction.create({ user: driverUser._id, ride: done._id, type: 'commission', amount: Number(done.fare.commission) || 0,
    status: 'completed', description: 'Platform share (20%) from parcel' });
  await DriverProfile.updateOne({ user: driverUser._id }, { $inc: { totalDeliveries: 1, totalEarnings: cut } });
  try {
    await require('../models/ActivityLog').create({ action: 'parcel.delivered', targetType: 'Ride', targetId: done._id,
      targetLabel: 'Koli ' + String(done._id).slice(-6), detail: { driver: driverUser._id, driverCut: cut } });
  } catch (e) { /* the log is not the delivery */ }
  return { ok: true, ride: done };
}

/* What the PUBLIC tracking link may show. No phone numbers, no code, no
   photo, nobody's surname: whoever holds the link sees where the package is
   and who is bringing it, nothing they could misuse. */
/* driverLngLat: the driver's live position comes from their DriverProfile
   (the driver page sends it there every minute), not from the ride. */
function publicView(ride, driverLngLat) {
  const first = function (n) { return String(n || '').trim().split(/\s+/)[0] || ''; };
  const d = ride.driver && ride.driver.name ? ride.driver : null;
  const moving = ['accepted', 'picking_up', 'in_progress'].indexOf(ride.status) !== -1;
  const loc = driverLngLat;
  return {
    status: ride.status,
    paid: ride.paymentStatus === 'paid',
    pickup: ride.pickup && ride.pickup.address,
    dropoff: ride.dropoff && ride.dropoff.address,
    recipient: first(ride.recipient && ride.recipient.name),
    sender: first(ride.customer && ride.customer.name),
    description: ride.parcel && ride.parcel.description,
    driver: d ? first(d.name) : null,
    driverLocation: moving && loc && (loc[0] || loc[1]) ? { lat: loc[1], lng: loc[0] } : null,
    acceptedAt: ride.acceptedAt, pickedUpAt: ride.pickedUpAt, deliveredAt: ride.deliveredAt,
    updatedAt: ride.updatedAt
  };
}

module.exports = { inHaiti, haversineKm, newPin, newTrackToken, confirmPaid, checkPending, gatewaySaysPaid, tick, complete, publicView,
  oweRefund, noDriverSweep, NO_DRIVER_REFUND_MIN,
  MAX_PIN_ATTEMPTS, DRIVER_HOLD_HOURS, GIVE_UP_HOURS };
