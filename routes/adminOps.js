/* ═══ ADMIN: REFUNDS AND DELIVERIES THAT NEED A PERSON (16 Oct 2026) ═════════
   SolutionIP cannot refund, so every refund is approved and sent by an
   administrator here, with a reference, and every step is kept in the
   refund's history and the audit log (services/orderLifecycle.js).
   ⛔ Admin role only - the route is mounted behind protect + authorize. */
const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const Refund = require('../models/Refund');
const Order = require('../models/Order');
const Ride = require('../models/Ride');
const lifecycle = require('../services/orderLifecycle');

router.use(protect, authorize('admin'));

router.get('/refunds', async (req, res) => {
  try {
    const q = {};
    if (req.query.status) q.status = String(req.query.status);
    const list = await Refund.find(q).sort({ createdAt: -1 }).limit(200)
      .populate('customer', 'name phone').populate('order', 'orderNumber total status paymentMethod paymentRef');
    res.json({ success: true, data: list });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

async function act(req, res, fn) {
  try {
    const r = await Refund.findById(req.params.id);
    if (!r) return res.status(404).json({ success: false, message: 'Refund not found' });
    const out = await fn(r);
    if (!out.ok) return res.status(out.code || 409).json({ success: false, message: out.message });
    res.json({ success: true, data: out.refund, shortfall: out.shortfall });
  } catch (e) { console.error('[REFUND]', e.message); res.status(500).json({ success: false, message: 'Server error' }); }
}
router.post('/refunds/:id/approve', (req, res) => act(req, res, r => lifecycle.approveRefund(r, req.user, req.body && req.body.note)));
router.post('/refunds/:id/paid', (req, res) => act(req, res, r => lifecycle.markRefundPaid(r, req.user, req.body && req.body.reference)));
router.post('/refunds/:id/reject', (req, res) => act(req, res, r => lifecycle.rejectRefund(r, req.user, req.body && req.body.reason)));

/* What a person must look at now. */
router.get('/attention', async (req, res) => {
  try {
    const now = Date.now();
    const [noDriver, locked, delayed, unpaidReady, refunds, noPay] = await Promise.all([
      Ride.find({ type: 'delivery', status: 'requested', noDriverAlertedAt: { $ne: null } }).sort({ searchingSince: 1 }).limit(50)
        .populate('order', 'orderNumber total').populate('store', 'name'),
      Order.find({ pinAttempts: { $gte: lifecycle.MAX_PIN_ATTEMPTS }, status: { $nin: ['delivered', 'cancelled'] } }).limit(50).select('orderNumber status pinAttempts rider'),
      Ride.find({ type: 'delivery', status: { $in: ['accepted', 'picking_up', 'in_progress'] }, acceptedAt: { $lt: new Date(now - 2 * 3600 * 1000) } })
        .limit(50).populate('order', 'orderNumber').populate('driver', 'name phone'),
      Order.find({ paymentStatus: 'paid', status: { $in: ['pending', 'confirmed'] }, paidAt: { $lt: new Date(now - 30 * 60 * 1000) } }).limit(50).select('orderNumber status paidAt store'),
      Refund.countDocuments({ status: { $in: ['pending_approval', 'approved'] } }),
      Ride.find({ type: 'delivery', status: 'requested', needsDriverPay: true }).limit(50)
        .populate('order', 'orderNumber total deliveryFee paymentGroup').populate('store', 'name')
    ]);
    res.json({ success: true, data: {
      waitingForDriver: noDriver, pinLocked: locked, delayedDeliveries: delayed,
      paidButNotAccepted: unpaidReady, refundsOpen: refunds, needsDriverPay: noPay } });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

/* Set the driver's pay on a delivery that carries none (free delivery, or a
   second shop in one basket). HaitiBiznis pays it; WHO, HOW MUCH and WHY are
   logged. Then it is offered to drivers like any other. */
router.post('/rides/:id/driver-pay', async (req, res) => {
  try {
    const amount = Math.round(Number(req.body && req.body.driverEarning));
    const reason = String((req.body && req.body.reason) || '').trim();
    if (!(amount > 0) || amount > 5000) return res.status(400).json({ success: false, message: 'Driver pay must be between 1 and 5,000 HTG.' });
    if (reason.length < 10) return res.status(400).json({ success: false, message: 'Write the reason (at least 10 characters).' });
    const ride = await Ride.findOneAndUpdate({ _id: req.params.id, status: 'requested', needsDriverPay: true },
      { $set: { needsDriverPay: false, 'fare.driverEarning': amount, searchingSince: new Date(), noDriverAlertedAt: null } }, { new: true });
    if (!ride) return res.status(409).json({ success: false, message: 'This delivery does not need its pay set.' });
    const order = ride.order ? await Order.findOneAndUpdate({ _id: ride.order }, { $set: { deliveryDriverCut: amount } }, { new: true }) : null;
    await lifecycle.log(req.user, 'delivery.driver_pay_set', order, { rideId: String(ride._id), driverEarning: amount, reason, paidBy: 'HaitiBiznis' });
    const dispatch = require('../services/deliveryDispatch');
    await dispatch.offerToNextDriver(ride, req.app.get('io'));
    res.json({ success: true, data: { rideId: ride._id, driverEarning: amount } });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

/* The audit trail of one order: who did what, in order. */
router.get('/orders/:id/history', async (req, res) => {
  try {
    const ActivityLog = require('../models/ActivityLog');
    const list = await ActivityLog.find({ targetType: 'Order', targetId: req.params.id }).sort({ createdAt: 1 }).limit(200);
    const refunds = await Refund.find({ order: req.params.id });
    res.json({ success: true, data: { log: list, refunds } });
  } catch (e) { res.status(500).json({ success: false, message: 'Server error' }); }
});

module.exports = router;
