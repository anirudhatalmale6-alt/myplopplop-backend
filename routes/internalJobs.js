/* Server-to-server (INTERNAL_SERVICE_KEY, mounted under /api/internal in server.js), 5 Nov 2026.
   1. GET  /driver-busy?msouwout_id=     MsouWout asks: is this driver on a MyPlopPlop job right now?
                                         ("A driver should only receive new requests when available.")
   2. GET  /parcel-refunds?status=       Jennifer's console (through haitibiznis-api): paid parcels to pay back.
   3. POST /parcel-refunds/:id/refunded  she paid it back: who, and the MonCash/NatCash/Stripe reference.
   4. GET  /driver-earnings?msouwout_id= MsouWout's Revni tab: his delivery + parcel earnings (read-only). */
const express = require('express');
const Ride = require('../models/Ride');
const DriverProfile = require('../models/DriverProfile');
const Transaction = require('../models/Transaction');
const { ACTIVE } = require('../services/driverBusy');
const router = express.Router();

router.get('/driver-busy', async (req, res) => {
  try {
    const id = String(req.query.msouwout_id || '').slice(0, 64);
    if (!id) return res.status(400).json({ error: 'msouwout_id' });
    const prof = await DriverProfile.findOne({ 'msouwout.driverId': id }).select('user').lean();
    if (!prof) return res.json({ busy: false, jobs: [] });
    const all = await Ride.find({ driver: prof.user, status: { $in: ACTIVE } }).select('type source status').lean();
    const job = all[0];
    /* jobs: the lock ids MsouWout may hold for him ("mpp:<ride id>"); a lock not in this list is over */
    res.json({ busy: !!job, job: job ? { kind: job.source === 'parcel' ? 'parcel' : 'delivery', status: job.status } : null,
      jobs: all.map(function (r) { return 'mpp:' + String(r._id); }) });
  } catch (e) { res.status(500).json({ error: 'server' }); }
});

/* 5 Nov 2026 15:05, Jeffery: "the driver's package earnings should be visible in the MsouWout earnings
   dashboard, even if ride and delivery balances are accounted for separately." MsouWout's server asks;
   read-only. Balances stay HERE (held 24 h, withdrawn from myplopplop.com/rider/wallet.html). */
function haitiMidnight(now) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Port-au-Prince', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const g = function (t) { return Number(p.find(function (x) { return x.type === t; }).value); };
  return new Date(now.getTime() - ((g('hour') * 60 + g('minute')) * 60 + g('second')) * 1000 - now.getMilliseconds());
}
router.get('/driver-earnings', async (req, res) => {
  try {
    const id = String(req.query.msouwout_id || '').slice(0, 64);
    if (!id) return res.status(400).json({ error: 'msouwout_id' });
    const prof = await DriverProfile.findOne({ 'msouwout.driverId': id }).select('user').lean();
    if (!prof) return res.json({ linked: false });
    const User = require('../models/User');
    const u = await User.findById(prof.user).select('wallet').lean();
    const now = new Date(), today = haitiMidnight(now), week = new Date(today.getTime() - 6 * 86400000);
    const base = { user: prof.user, type: 'earning', earningOf: 'driver', status: { $in: ['pending', 'completed'] } };
    const sum = async function (since) {
      const a = await Transaction.aggregate([{ $match: Object.assign({}, base, since ? { createdAt: { $gte: since } } : {}) },
        { $group: { _id: null, t: { $sum: '$amount' }, n: { $sum: 1 } } }]);
      return a[0] ? { amount: a[0].t, count: a[0].n } : { amount: 0, count: 0 };
    };
    const recent = await Transaction.find(base).sort({ createdAt: -1 }).limit(10).select('amount status releaseAt createdAt ride order').lean();
    const rides = await Ride.find({ _id: { $in: recent.map(function (t) { return t.ride; }).filter(Boolean) } }).select('source').lean();
    const src = {}; rides.forEach(function (r) { src[String(r._id)] = r.source; });
    res.json({
      linked: true,
      wallet: { held: (u && u.wallet && u.wallet.pending_balance) || 0, available: (u && u.wallet && u.wallet.available_balance) || 0 },
      today: await sum(today), week: await sum(week), total: await sum(null),
      recent: recent.map(function (t) {
        return { at: t.createdAt, amount: t.amount, held: t.status === 'pending', releaseAt: t.releaseAt,
          kind: t.ride && src[String(t.ride)] === 'parcel' ? 'parcel' : 'delivery' };
      })
    });
  } catch (e) { res.status(500).json({ error: 'server' }); }
});

function view(r, pays) {
  const c = r.customer || {};
  return {
    id: String(r._id), short: String(r._id).slice(-6).toUpperCase(),
    amount: r.refund && r.refund.amount, reason: r.refund && r.refund.reason, status: r.refund && r.refund.status,
    owedAt: r.refund && r.refund.owedAt, refundedAt: r.refund && r.refund.refundedAt, by: r.refund && r.refund.by,
    reference: r.refund && r.refund.reference, note: r.refund && r.refund.note,
    method: r.paymentMethod, sender: { name: c.name || '', phone: c.phone || '' },
    pickup: r.pickup && r.pickup.address, dropoff: r.dropoff && r.dropoff.address, createdAt: r.createdAt,
    payments: (pays || []).map(function (t) { return { method: t.method, amount: t.amount, reference: t.reference }; })
  };
}

router.get('/parcel-refunds', async (req, res) => {
  try {
    const st = String(req.query.status || 'owed');
    const q = { source: 'parcel', 'refund.status': st === 'all' ? { $in: ['owed', 'refunded'] } : (st === 'refunded' ? 'refunded' : 'owed') };
    const rides = await Ride.find(q).sort({ 'refund.owedAt': -1 }).limit(200).populate('customer', 'name phone').lean();
    const pays = await Transaction.find({ ride: { $in: rides.map(function (r) { return r._id; }) }, type: 'payment', status: 'completed' })
      .select('ride method amount reference').lean();
    const by = {}; pays.forEach(function (t) { (by[String(t.ride)] = by[String(t.ride)] || []).push(t); });
    const owed = await Ride.aggregate([{ $match: { source: 'parcel', 'refund.status': 'owed' } }, { $group: { _id: null, n: { $sum: 1 }, total: { $sum: '$refund.amount' } } }]);
    res.json({ refunds: rides.map(function (r) { return view(r, by[String(r._id)]); }),
      owed: owed[0] ? { count: owed[0].n, total: owed[0].total } : { count: 0, total: 0 } });
  } catch (e) { res.status(500).json({ error: 'server' }); }
});

router.post('/parcel-refunds/:id/refunded', async (req, res) => {
  try {
    const by = String((req.body && req.body.by) || '').trim().slice(0, 80);
    const reference = String((req.body && req.body.reference) || '').trim().slice(0, 120);
    if (!by) return res.status(400).json({ error: 'by_required', message: 'Ki moun ki ranbouse l?' });
    if (!reference) return res.status(400).json({ error: 'reference_required', message: 'Mete referans tranzaksyon MonCash/NatCash/kat la.' });
    const done = await Ride.findOneAndUpdate({ _id: req.params.id, source: 'parcel', 'refund.status': 'owed' },
      { $set: { 'refund.status': 'refunded', 'refund.refundedAt': new Date(), 'refund.by': by, 'refund.reference': reference,
                'refund.note': String((req.body && req.body.note) || '').slice(0, 300), paymentStatus: 'refunded' } }, { new: true })
      .populate('customer', 'name phone');
    if (!done) return res.status(409).json({ error: 'not_owed', message: 'Ranbousman sa a pa an atant (deja fèt?).' });
    try {
      await require('../models/ActivityLog').create({ action: 'parcel.refunded', targetType: 'Ride', targetId: done._id, actorName: by,
        targetLabel: 'Koli ' + String(done._id).slice(-6), detail: { amount: done.refund.amount, reference: reference } });
    } catch (e) { /* the log is not the refund */ }
    try { await require('./notifications').sendPushToUser(done.customer._id, 'Ranbousman fèt', 'Nou remèt ou ' + done.refund.amount + ' HTG pou koli a. Ref: ' + reference, {}); } catch (e) {}
    res.json({ ok: true, refund: view(done.toObject()) });
  } catch (e) { res.status(500).json({ error: 'server' }); }
});

module.exports = router;
