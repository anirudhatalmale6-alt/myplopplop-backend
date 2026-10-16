/* ═══ A MARKETPLACE ORDER, FROM PAYMENT TO MONEY - THE ONE PLACE IT HAPPENS ═══
 *
 * 16 Oct 2026. Jeffery approved the five must-fix areas from the delivery
 * audit. Until now an order's state and money were changed from five
 * different routes, each with its own idea of the rules: a merchant could
 * prepare an unpaid order, mark a delivery "delivered" without the driver or
 * the code, a cancelled order's delivery kept running and paid everyone, and a
 * driver who delivered was never credited at all.
 *
 * Every route now calls THIS file, and this file holds the rules:
 *
 *   confirmPayment   the server's own check with SolutionIP, covering EVERY
 *                    shop in the basket (one payment, one reference)
 *   merchantAdvance  pending -> confirmed -> preparing -> ready, PAID only,
 *                    one step at a time; "ready" dispatches a driver
 *   completeDelivery delivered ONLY with the customer's code (or an admin
 *                    exception with a written reason); credits the shop and
 *                    the driver's 80% EXACTLY ONCE, into held balances
 *   cancelOrder      who may cancel at which stage; stops the ride, restores
 *                    stock, takes back the agent commission, opens a refund
 *   releaseMatured   moves held earnings to withdrawable once the hold ends
 *   refunds          admin approve / paid-with-reference / reject, with history
 *
 * 🔑 IDEMPOTENT BY CONSTRUCTION. Every change is a single conditional update
 * ("set X where it is still Y"). A retry, a double tap, two servers or an
 * interrupted connection either make the change once or find it made.
 * ⛔ No payouts are sent from here: money only moves between wallet balances
 *    inside MyPlopPlop. Sending money out stays manual (routes/payouts.js).
 * ═════════════════════════════════════════════════════════════════════════ */
const Order = require('../models/Order');
const Store = require('../models/Store');
const User = require('../models/User');
const Ride = require('../models/Ride');
const Product = require('../models/Product');
const Transaction = require('../models/Transaction');
const Refund = require('../models/Refund');
const ActivityLog = require('../models/ActivityLog');

const DRIVER_HOLD_HOURS = 24;          // a delivery earning becomes withdrawable after this
const MAX_PIN_ATTEMPTS = 5;            // then only an admin exception can complete it

function push() {
  try { return require('../routes/notifications').sendPushToUser.apply(null, arguments).catch(function () {}); }
  catch (e) { return Promise.resolve(); }
}
function newCode() { return String(Math.floor(1000 + Math.random() * 9000)); }

/* Who did what, for the audit trail. Never allowed to fail a money step. */
async function log(actor, action, order, detail) {
  try {
    await ActivityLog.create({
      actor: actor && actor._id, actorName: actor && actor.name, actorRole: actor && actor.role,
      action: action, targetType: 'Order', targetId: order && order._id,
      targetLabel: order && order.orderNumber, detail: detail || {}
    });
  } catch (e) { console.error('[LIFECYCLE] audit log failed:', e.message); }
}

/* ═══ 1. PAYMENT ══════════════════════════════════════════════════════════ */

/* The orders one payment covers: the basket the customer checked out. */
async function basketOf(order) {
  const group = order.paymentGroup || order.orderNumber;
  const orders = await Order.find({ customer: order.customer, $or: [{ paymentGroup: group }, { orderNumber: group }] });
  return { group, orders: orders.length ? orders : [order] };
}

/* gw = SolutionIP's answer for the basket reference.
   Returns { ok, reason, confirmed: [orders newly marked paid] }. */
async function confirmPayment(anyOrder, gw, opts) {
  const o = opts || {};
  if (!gw || gw.status !== true || gw.trans_status !== 'ok') return { ok: false, reason: 'not_paid' };
  const { group, orders } = await basketOf(anyOrder);
  const live = orders.filter(function (x) { return x.status !== 'cancelled'; });
  const needLive = live.reduce(function (s, x) { return s + (Number(x.total) || 0); }, 0);
  const needAll = orders.reduce(function (s, x) { return s + (Number(x.total) || 0); }, 0);
  const paid = Number(gw.montant);
  // ⛔ Never mark anything paid on less than it is worth, or on an unreadable amount.
  if (!isFinite(paid) || paid + 1 < needLive) {
    console.warn('[PAYMENT] ' + group + ': gateway reports ' + gw.montant + ', basket is ' + needLive);
    return { ok: false, reason: 'amount_mismatch', expected: needLive, paid: gw.montant };
  }
  const now = new Date();
  const confirmed = [];
  for (const x of live) {
    const r = await Order.findOneAndUpdate(
      { _id: x._id, paymentStatus: { $ne: 'paid' }, status: { $ne: 'cancelled' } },
      { $set: { paymentStatus: 'paid', paidAt: now, paymentRef: group, deliveryPin: x.deliveryPin || newCode() } },
      { new: true });
    if (r) confirmed.push(r);
  }
  for (const r of confirmed) await afterPaid(r, gw, o);
  // A shop's order cancelled BEFORE the payment arrived, but paid for anyway
  // (the basket total was charged): that money is owed back.
  if (paid + 1 >= needAll) {
    for (const x of orders.filter(function (y) { return y.status === 'cancelled' && y.paymentStatus !== 'paid' && !y.refund; })) {
      const got = await Order.findOneAndUpdate({ _id: x._id, paymentStatus: { $ne: 'paid' }, refund: null },
        { $set: { paymentStatus: 'paid', paidAt: now, paymentRef: group } }, { new: true });
      if (got) await openRefund(got, got.total, 'Order cancelled before the payment arrived', null);
    }
  }
  return { ok: true, group, confirmed };
}

/* What follows a payment: the pending transaction, the agent's commission,
   and the shop is told there is a REAL order to prepare. */
async function afterPaid(order, gw, o) {
  try {
    const pending = await Transaction.findOneAndUpdate(
      { reference: order.orderNumber, type: 'payment', status: 'pending' },
      { $set: { status: 'completed', method: (gw && gw.method) || order.paymentMethod } });
    if (!pending && order.paymentMethod !== 'wallet') {
      await Transaction.create({ user: order.customer, type: 'payment', amount: order.total, currency: 'HTG',
        method: order.paymentMethod || 'moncash', status: 'completed', reference: order.orderNumber,
        description: 'Payment for order ' + order.orderNumber, order: order._id });
    }
  } catch (e) { console.error('[PAYMENT] transaction record failed for ' + order.orderNumber + ':', e.message); }

  // The agent who signed up the SHOP earns now that the money is genuinely in.
  try {
    const referralService = require('./referral');
    const shop = await Store.findById(order.store).select('owner name');
    if (shop && shop.owner) {
      const mf = require('../utils/marketFees');
      const sp = order.sellerFeePct != null && order.sellerFeeRule !== 'legacy' ? order.sellerFeePct : 0;
      const ap = mf.agentOrderPct(sp), fp = mf.serviceFeePct() + sp;
      await referralService.payCommissionForUser(shop.owner, {
        platform: 'myplopplop', serviceType: 'marketplace',
        amount: ap ? order.subtotal : order.total,
        rates: ap ? { feeRate: fp / 100, koutyeRate: ap / fp, label: ap + '% of the product order value' } : undefined,
        transactionId: order.orderNumber,
        description: 'Order ' + order.orderNumber + ' at ' + shop.name
      });
    }
    if (shop) {
      push(shop.owner, 'Nouvo kòmand peye #' + order.orderNumber,
        'Yon kliyan peye ' + order.total + ' HTG. Prepare kòmand lan.', { url: '/merchant/orders.html' });
      if (o && o.io) o.io.to('store_' + order.store).emit('new_order', { orderId: order._id, orderNumber: order.orderNumber, total: order.total });
    }
  } catch (e) { console.error('[PAYMENT] commission/notify failed for ' + order.orderNumber + ':', e.message); }
  await log(null, 'order.paid', order, { group: order.paymentRef, method: (gw && gw.method) || order.paymentMethod, amount: order.total, source: o && o.source });
}

/* ═══ 2. MERCHANT STEPS ═══════════════════════════════════════════════════ */
const MERCHANT_NEXT = { pending: 'confirmed', confirmed: 'preparing', preparing: 'ready' };
const STAMP = { confirmed: 'confirmedAt', preparing: 'preparedAt' };

async function merchantAdvance(order, to, actor, io) {
  if (MERCHANT_NEXT[order.status] !== to) {
    return { ok: false, code: 409, message: 'An order goes pending → confirmed → preparing → ready, one step at a time.' };
  }
  if (order.paymentStatus !== 'paid') {
    return { ok: false, code: 409, message: 'This order is not paid yet. Do not prepare it until the payment is confirmed.' };
  }
  const set = { status: to };
  if (STAMP[to]) set[STAMP[to]] = new Date();
  const r = await Order.findOneAndUpdate({ _id: order._id, status: order.status, paymentStatus: 'paid' }, { $set: set }, { new: true });
  if (!r) return { ok: false, code: 409, message: 'The order changed meanwhile. Reload.' };
  await log(actor, 'order.' + to, r, { from: order.status });
  if (to === 'ready' && r.deliveryType === 'delivery' && !r.rideId) {
    const store = await Store.findById(r.store);
    try { await require('./deliveryDispatch').createDeliveryRideForOrder(r, store, io); }
    catch (e) { console.error('[DISPATCH] ' + r.orderNumber + ':', e.message); }
  }
  push(r.customer, 'Kòmand #' + r.orderNumber, { confirmed: 'Machann nan aksepte kòmand ou.', preparing: 'Kòmand ou ap prepare.', ready: r.deliveryType === 'delivery' ? 'Kòmand ou pare. N ap chèche yon chofè.' : 'Kòmand ou pare. Ou ka vin chèche l.' }[to] || to,
    { url: '/order-status.html?id=' + r._id });
  return { ok: true, order: r };
}

/* ═══ 3. COMPLETION (the only way an order becomes "delivered") ══════════ */

/* Checks the customer's code. Counts wrong tries; after MAX_PIN_ATTEMPTS the
   order can only be completed by an admin exception. */
async function checkPin(order, given) {
  if ((order.pinAttempts || 0) >= MAX_PIN_ATTEMPTS) return { ok: false, code: 423, message: 'Too many wrong codes. An administrator must check this delivery.' };
  if (!order.deliveryPin) return { ok: false, code: 409, message: 'This order has no delivery code yet.' };
  if (String(given || '').trim() !== String(order.deliveryPin)) {
    const r = await Order.findOneAndUpdate({ _id: order._id }, { $inc: { pinAttempts: 1 } }, { new: true });
    const left = Math.max(0, MAX_PIN_ATTEMPTS - (r.pinAttempts || 0));
    return { ok: false, code: 400, message: left ? 'Wrong code. Ask the customer for their 4-digit code. ' + left + ' tries left.' : 'Too many wrong codes. An administrator must check this delivery.' };
  }
  return { ok: true };
}

async function completeDelivery(order, opts) {
  const via = opts.via;                       // 'pin' | 'pickup_pin' | 'admin_exception'
  const now = new Date();
  const store = await Store.findById(order.store);
  const vendorAgeMs = store && store.createdAt ? Date.now() - store.createdAt.getTime() : 0;
  const holdHours = (vendorAgeMs < 30 * 24 * 3600 * 1000 ? 72 : 24) + (order.isDiasporaOrder ? 24 : 0);
  const done = await Order.findOneAndUpdate(
    { _id: order._id, status: { $nin: ['delivered', 'cancelled'] }, paymentStatus: 'paid' },
    { $set: { status: 'delivered', deliveredAt: now, deliveredVia: via, payoutStatus: 'pending',
              payoutAvailableAt: new Date(now.getTime() + holdHours * 3600 * 1000) } },
    { new: true });
  if (!done) return { ok: false, code: 409, message: 'This order is already delivered, cancelled, or not paid.' };

  // The shop: its settlement, held, ONCE.
  if (store && done.merchantEarning > 0) {
    const m = await Order.findOneAndUpdate({ _id: done._id, merchantCreditedAt: null }, { $set: { merchantCreditedAt: now } });
    if (m) {
      await User.updateOne({ _id: store.owner }, { $inc: { 'wallet.pending_balance': done.merchantEarning } });
      await Store.updateOne({ _id: store._id }, { $inc: { 'stats.totalRevenue': done.merchantEarning } });
      await Transaction.create({ user: store.owner, type: 'earning', amount: done.merchantEarning, currency: 'HTG', method: 'wallet',
        status: 'pending', reference: done.orderNumber, order: done._id, earningOf: 'merchant', releaseAt: done.payoutAvailableAt,
        description: 'Sale ' + done.orderNumber + ' (after seller fee)' });
    }
  }
  // The driver: exactly the 80% stored on the order when it was paid, ONCE.
  const driverId = (opts.ride && opts.ride.driver) || done.rider;
  if (done.deliveryType === 'delivery' && driverId && done.deliveryDriverCut > 0) {
    const d = await Order.findOneAndUpdate({ _id: done._id, driverCreditedAt: null },
      { $set: { driverCreditedAt: now, driverCreditUser: driverId } });
    if (d) {
      await User.updateOne({ _id: driverId }, { $inc: { 'wallet.pending_balance': done.deliveryDriverCut } });
      await Transaction.create({ user: driverId, type: 'earning', amount: done.deliveryDriverCut, currency: 'HTG', method: 'wallet',
        status: 'pending', reference: done.orderNumber, order: done._id, ride: opts.ride && opts.ride._id, earningOf: 'driver',
        releaseAt: new Date(now.getTime() + DRIVER_HOLD_HOURS * 3600 * 1000),
        description: 'Delivery ' + done.orderNumber + ' (80% of ' + done.deliveryFee + ' HTG)' });
    }
  }
  if (done.rideId) {
    await Ride.updateOne({ _id: done.rideId, status: { $nin: ['delivered', 'cancelled'] } },
      { $set: { status: 'delivered', deliveredAt: now, paymentStatus: 'paid' } });
  }
  await log(opts.actor, via === 'admin_exception' ? 'order.delivered_by_exception' : 'order.delivered', done,
    { via: via, reason: opts.reason, merchant: done.merchantEarning, driver: done.deliveryDriverCut });
  push(done.customer, 'Kòmand #' + done.orderNumber + ' livre', 'Mèsi pou kòmand ou!', { url: '/order-status.html?id=' + done._id });
  return { ok: true, order: done };
}

/* ═══ 4. CANCELLATION ═════════════════════════════════════════════════════
   Who may cancel, by stage. ⛔ Nobody cancels a delivered order: a problem
   after delivery is a REFUND (openRefundForDelivered), not a cancel. */
const CANCEL_STAGES = {
  customer: ['pending', 'confirmed'],
  merchant: ['pending', 'confirmed', 'preparing', 'ready'],
  admin: ['pending', 'confirmed', 'preparing', 'ready', 'picked_up', 'delivering'],
  system: ['pending']
};

async function cancelOrder(order, opts) {
  const role = opts.role;
  const stages = CANCEL_STAGES[role] || [];
  const now = new Date();
  const c = await Order.findOneAndUpdate({ _id: order._id, status: { $in: stages } },
    { $set: { status: 'cancelled', cancelledBy: role === 'admin' ? 'admin' : role, cancelReason: String(opts.reason || '').slice(0, 300), cancelledAt: now } },
    { new: true });
  if (!c) {
    return { ok: false, code: 409, message: order.status === 'delivered'
      ? 'A delivered order cannot be cancelled. Ask an administrator for a refund.'
      : 'This order can no longer be cancelled at this stage (' + order.status + ').' };
  }
  // Stop the delivery: no driver may continue a cancelled order.
  if (c.rideId) {
    const ride = await Ride.findOneAndUpdate({ _id: c.rideId, status: { $nin: ['delivered', 'cancelled'] } },
      { $set: { status: 'cancelled', cancelledAt: now, cancelledBy: role === 'customer' ? 'customer' : 'admin', cancelReason: 'Order cancelled', offeredTo: null, offerExpiresAt: null } },
      { new: true });
    if (ride && ride.driver) push(ride.driver, 'Livrezon anile', 'Kòmand #' + c.orderNumber + ' anile. Pa ale chèche l.', { url: '/driver-delivery.html' });
  }
  // Put the stock back (only for products whose stock is tracked).
  for (const it of c.items || []) {
    await Product.updateOne({ _id: it.product, stockQuantity: { $gte: 0 } },
      { $inc: { stockQuantity: it.quantity, orderCount: -it.quantity }, $set: { inStock: true } }).catch(function () {});
  }
  // The agent's commission on this sale is taken back (unpaid lines only).
  try { await require('./referral').reverseCommission({ transactionId: c.orderNumber, reason: 'order cancelled' }); }
  catch (e) { console.error('[CANCEL] commission reversal failed for ' + c.orderNumber + ':', e.message); }
  let refund = null;
  if (c.paymentStatus === 'paid') refund = await openRefund(c, c.total, 'Order cancelled by ' + role + (opts.reason ? ': ' + opts.reason : ''), opts.actor);
  await log(opts.actor, 'order.cancelled', c, { by: role, reason: opts.reason, wasPaid: c.paymentStatus === 'paid', refund: refund && refund._id });
  push(c.customer, 'Kòmand #' + c.orderNumber + ' anile',
    c.paymentStatus === 'paid' ? 'Lajan ou ap ranbouse: yon administratè ap trete l.' : 'Kòmand ou anile.', { url: '/order-status.html?id=' + c._id });
  if (role !== 'merchant') {
    const store = await Store.findById(c.store).select('owner');
    if (store) push(store.owner, 'Kòmand #' + c.orderNumber + ' anile', 'Pa prepare li.', { url: '/merchant/orders.html' });
  }
  return { ok: true, order: c, refund };
}

/* ═══ 5. REFUNDS ══════════════════════════════════════════════════════════ */
async function openRefund(order, amount, reason, actor, adj) {
  const existing = await Refund.findOne({ order: order._id, status: { $in: ['pending_approval', 'approved'] } });
  if (existing) return existing;
  const r = await Refund.create({
    order: order._id, orderNumber: order.orderNumber, customer: order.customer,
    amount: Math.round(Number(amount) || 0), reason: String(reason || '').slice(0, 300),
    method: order.paymentMethod || 'moncash', paymentRef: order.paymentRef || order.orderNumber,
    merchantAdjustment: (adj && adj.merchant) || 0, driverAdjustment: (adj && adj.driver) || 0,
    history: [{ by: actor && actor._id, byName: actor ? actor.name : 'system', action: 'opened', note: reason }]
  });
  await Order.updateOne({ _id: order._id }, { $set: { refund: r._id } });
  await log(actor, 'refund.opened', order, { refund: r._id, amount: r.amount, reason: reason });
  return r;
}

/* A problem AFTER delivery (wrong, damaged, missing): an admin opens a refund
   and says how much comes back from the shop (and the driver, rarely). */
async function openRefundForDelivered(order, admin, body) {
  if (order.status !== 'delivered' || order.paymentStatus !== 'paid') return { ok: false, code: 409, message: 'Only a paid, delivered order can be refunded this way.' };
  const amount = Math.round(Number(body.amount));
  if (!(amount > 0) || amount > order.total) return { ok: false, code: 400, message: 'Amount must be between 1 and ' + order.total + ' HTG.' };
  const reason = String(body.reason || '').trim();
  if (reason.length < 10) return { ok: false, code: 400, message: 'Write the reason (at least 10 characters).' };
  const merchant = body.merchantAdjustment != null ? Math.round(Number(body.merchantAdjustment)) : Math.min(amount, order.merchantEarning || 0);
  const driver = body.driverAdjustment != null ? Math.round(Number(body.driverAdjustment)) : 0;
  if (merchant < 0 || merchant > (order.merchantEarning || 0) || driver < 0 || driver > (order.deliveryDriverCut || 0)) {
    return { ok: false, code: 400, message: 'Adjustments cannot exceed what the shop or driver earned on this order.' };
  }
  const r = await openRefund(order, amount, reason, admin, { merchant, driver });
  return { ok: true, refund: r };
}

/* Take money back from a wallet: from the held balance first, then the
   withdrawable one. Never below zero; whatever could not be taken is
   returned so the admin sees it. */
async function takeBack(userId, amount, preferHeld) {
  if (!(amount > 0)) return 0;
  const u = await User.findById(userId).select('wallet role');
  if (!u) return amount;
  const buckets = preferHeld ? ['pending_balance', u.role === 'driver' ? 'balance' : 'available_balance'] : [u.role === 'driver' ? 'balance' : 'available_balance', 'pending_balance'];
  let left = amount;
  for (const b of buckets) {
    if (left <= 0) break;
    const have = (u.wallet && u.wallet[b]) || 0;
    const take = Math.min(have, left);
    if (take > 0) {
      const ok = await User.updateOne({ _id: userId, ['wallet.' + b]: { $gte: take } }, { $inc: { ['wallet.' + b]: -take } });
      if (ok.modifiedCount) left -= take;
    }
  }
  return left;
}

async function approveRefund(refund, admin, note) {
  const r = await Refund.findOneAndUpdate({ _id: refund._id, status: 'pending_approval' },
    { $set: { status: 'approved' }, $push: { history: { by: admin._id, byName: admin.name, action: 'approved', note: note } } }, { new: true });
  if (!r) return { ok: false, code: 409, message: 'This refund is not waiting for approval.' };
  const order = await Order.findById(r.order);
  const shortfall = {};
  if (order && r.merchantAdjustment > 0) {
    const store = await Store.findById(order.store).select('owner');
    if (store) shortfall.merchant = await takeBack(store.owner, r.merchantAdjustment, true);
  }
  if (order && r.driverAdjustment > 0 && order.driverCreditUser) shortfall.driver = await takeBack(order.driverCreditUser, r.driverAdjustment, true);
  // A refund of the products undoes the sale for the agent too.
  if (order && order.status === 'delivered' && r.amount >= (order.subtotal || 0)) {
    try { await require('./referral').reverseCommission({ transactionId: order.orderNumber, reason: 'refunded' }); } catch (e) {}
  }
  if (r.method === 'wallet') {
    // A wallet payment goes straight back to the wallet: nothing to send by hand.
    await User.updateOne({ _id: r.customer }, { $inc: { 'wallet.balance': r.amount } });
    await Transaction.create({ user: r.customer, type: 'refund', amount: r.amount, currency: 'HTG', method: 'wallet', status: 'completed',
      reference: 'REFUND-' + r.orderNumber, order: r.order, description: 'Refund for order ' + r.orderNumber });
    await Refund.updateOne({ _id: r._id }, { $set: { status: 'paid', payoutReference: 'WALLET' }, $push: { history: { by: admin._id, byName: admin.name, action: 'paid', note: 'returned to the customer wallet' } } });
  }
  if (order && r.amount >= order.total) await Order.updateOne({ _id: order._id }, { $set: { paymentStatus: 'refunded', payoutStatus: order.status === 'delivered' ? 'refunded' : order.payoutStatus } });
  await log(admin, 'refund.approved', order, { refund: r._id, amount: r.amount, merchantAdjustment: r.merchantAdjustment, driverAdjustment: r.driverAdjustment, shortfall: shortfall, note: note });
  return { ok: true, refund: await Refund.findById(r._id), shortfall };
}

async function markRefundPaid(refund, admin, reference) {
  const ref = String(reference || '').trim();
  if (ref.length < 4) return { ok: false, code: 400, message: 'Type the MonCash/NatCash transfer reference.' };
  const r = await Refund.findOneAndUpdate({ _id: refund._id, status: 'approved' },
    { $set: { status: 'paid', payoutReference: ref }, $push: { history: { by: admin._id, byName: admin.name, action: 'paid', note: 'transfer reference ' + ref } } }, { new: true });
  if (!r) return { ok: false, code: 409, message: 'Only an approved refund can be marked paid.' };
  await Transaction.create({ user: r.customer, type: 'refund', amount: r.amount, currency: 'HTG', method: r.method === 'card' ? 'card' : r.method,
    status: 'completed', reference: ref, order: r.order, description: 'Refund for order ' + r.orderNumber + ' sent by ' + r.method });
  const order = await Order.findById(r.order);
  await log(admin, 'refund.paid', order, { refund: r._id, amount: r.amount, reference: ref });
  push(r.customer, 'Ranbousman voye', r.amount + ' HTG voye pou kòmand #' + r.orderNumber + '. Referans: ' + ref, { url: '/orders.html' });
  return { ok: true, refund: r };
}

async function rejectRefund(refund, admin, reason) {
  const why = String(reason || '').trim();
  if (why.length < 5) return { ok: false, code: 400, message: 'Write why the refund is refused.' };
  const r = await Refund.findOneAndUpdate({ _id: refund._id, status: 'pending_approval' },
    { $set: { status: 'rejected' }, $push: { history: { by: admin._id, byName: admin.name, action: 'rejected', note: why } } }, { new: true });
  if (!r) return { ok: false, code: 409, message: 'Only a refund waiting for approval can be rejected.' };
  await log(admin, 'refund.rejected', await Order.findById(r.order), { refund: r._id, reason: why });
  return { ok: true, refund: r };
}

/* ═══ 6. RELEASE HELD EARNINGS ════════════════════════════════════════════ */
async function releaseMatured(now) {
  const t = now || new Date();
  let shops = 0, drivers = 0;
  // Shops: an order's settlement, once its hold is over and nothing undid it.
  const due = await Order.find({ payoutStatus: 'pending', payoutAvailableAt: { $lte: t }, status: 'delivered', paymentStatus: 'paid', merchantCreditedAt: { $ne: null } }).limit(200);
  for (const o of due) {
    const flip = await Order.findOneAndUpdate({ _id: o._id, payoutStatus: 'pending' }, { $set: { payoutStatus: 'available' } });
    if (!flip) continue;
    const store = await Store.findById(o.store).select('owner');
    if (!store) continue;
    const tx = await Transaction.findOneAndUpdate({ order: o._id, earningOf: 'merchant', status: 'pending' }, { $set: { status: 'completed' } });
    const amt = tx ? tx.amount : o.merchantEarning;
    const moved = await User.updateOne({ _id: store.owner, 'wallet.pending_balance': { $gte: amt } },
      { $inc: { 'wallet.pending_balance': -amt, 'wallet.available_balance': amt } });
    if (!moved.modifiedCount) {
      // part of it was taken back by a refund meanwhile: release what is there
      const u = await User.findById(store.owner).select('wallet');
      const part = Math.max(0, Math.min(amt, (u && u.wallet && u.wallet.pending_balance) || 0));
      if (part > 0) await User.updateOne({ _id: store.owner }, { $inc: { 'wallet.pending_balance': -part, 'wallet.available_balance': part } });
    }
    shops++;
  }
  // Drivers: each delivery earning, once its hold is over.
  const txs = await Transaction.find({ earningOf: 'driver', status: 'pending', releaseAt: { $lte: t } }).limit(500);
  for (const tx of txs) {
    const flip = await Transaction.findOneAndUpdate({ _id: tx._id, status: 'pending' }, { $set: { status: 'completed' } });
    if (!flip) continue;
    const u = await User.findById(tx.user).select('wallet');
    const part = Math.max(0, Math.min(tx.amount, (u && u.wallet && u.wallet.pending_balance) || 0));
    if (part > 0) await User.updateOne({ _id: tx.user, 'wallet.pending_balance': { $gte: part } }, { $inc: { 'wallet.pending_balance': -part, 'wallet.balance': part } });
    drivers++;
  }
  return { shops, drivers };
}

module.exports = {
  confirmPayment, basketOf, merchantAdvance, checkPin, completeDelivery, cancelOrder,
  openRefund, openRefundForDelivered, approveRefund, markRefundPaid, rejectRefund, releaseMatured,
  log, newCode, CANCEL_STAGES, MERCHANT_NEXT, MAX_PIN_ATTEMPTS, DRIVER_HOLD_HOURS
};
