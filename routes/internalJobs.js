/* Server-to-server (INTERNAL_SERVICE_KEY, mounted under /api/internal in server.js), 5 Nov 2026.
   1. GET  /driver-busy?msouwout_id=     MsouWout asks: is this driver on a MyPlopPlop job right now?
                                         ("A driver should only receive new requests when available.")
   2. GET  /parcel-refunds?status=       Jennifer's console (through haitibiznis-api): paid parcels to pay back.
   3. POST /parcel-refunds/:id/refunded  she paid it back: who, and the MonCash/NatCash/Stripe reference.
   4. GET  /driver-earnings?msouwout_id= MsouWout's Revni tab: his delivery + parcel earnings (read-only).
   5. POST /commission-status            Jennifer's console: payout status of the Ajan commission on given tickets.
   6. GET  /parcels-waiting              Jennifer's console: paid parcels still without a driver (red after 15 min). */
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

/* 6. GET /parcels-waiting  6 Nov 2026 (Koli option A): Jennifer's red alert. Paid parcels still without a driver, oldest
   first: minutes waiting, minutes before the automatic refund (30), whether the wider search is on, the sender, and
   the nearest eligible drivers she can CALL (approved, delivery, position in Haiti, within the wide radius; online or
   not, busy or not - shown, so she knows who to ask). Read-only. */
router.get('/parcels-waiting', async (req, res) => {
  try {
    const P = require('../services/parcel'), DD = require('../services/deliveryDispatch'), OA = require('../services/operatingAreas');
    const now = Date.now(), areas = await OA.get();
    const rides = await Ride.find({ source: 'parcel', status: 'requested', paymentStatus: 'paid', driver: null })
      .sort({ searchingSince: 1 }).limit(30).populate('customer', 'name phone').lean();
    const out = [];
    for (const r of rides) {
      const since = r.searchingSince || r.paidAt || r.createdAt, min = Math.floor((now - new Date(since)) / 60000);
      let near = [], pickupArea = '';
      const pc = r.pickup && r.pickup.coordinates && r.pickup.coordinates.coordinates;
      if (pc && pc.length === 2) pickupArea = OA.areaName(areas, pc[0], pc[1]);
      if (pc && pc.length === 2) {
        const ps = await DriverProfile.find({ status: 'approved', services: 'delivery', currentLocation: { $near: { $geometry: { type: 'Point', coordinates: pc }, $maxDistance: DD.WIDE_RADIUS_M } } })
          .limit(8).populate('user', 'name phone').lean();
        const busy = await require('../services/driverBusy').busyUsers(ps.filter(function (p) { return p.user; })).catch(function () { return new Set(); });
        /* only drivers the wider search may use: within the normal 15 km, or (pickup AND driver in an approved area) */
        near = ps.filter(function (p) {
          if (!p.user || !DD.inHaitiLngLat(p.currentLocation)) return false;
          const c = p.currentLocation.coordinates;
          return P.haversineKm(c[1], c[0], pc[1], pc[0]) <= DD.SEARCH_RADIUS_M / 1000 || (pickupArea && OA.inArea(areas, c[0], c[1]));
        }).slice(0, 5).map(function (p) {
          const c = p.currentLocation.coordinates;
          return { name: p.user.name || '', phone: p.user.phone || '', km: Math.round(P.haversineKm(c[1], c[0], pc[1], pc[0]) * 10) / 10,
            online: !!p.isOnline && !!p.locationUpdatedAt && (now - new Date(p.locationUpdatedAt)) < DD.LOCATION_FRESH_MS, busy: busy.has(String(p.user._id)) };
        });
      }
      const c = r.customer || {};
      out.push({ id: String(r._id), short: String(r._id).slice(-6).toUpperCase(), minutes: min, refundIn: Math.max(0, P.NO_DRIVER_REFUND_MIN - min),
        alert: min >= P.WIDE_AFTER_MIN, wide: !!r.wideSearchAt, pickupArea: pickupArea, amount: r.fare && r.fare.total, sender: { name: c.name || '', phone: c.phone || '' },
        pickup: r.pickup && r.pickup.address, dropoff: r.dropoff && r.dropoff.address, offeredNow: !!r.offeredTo, drivers: near });
    }
    res.json({ alertAfter: P.WIDE_AFTER_MIN, refundAfter: P.NO_DRIVER_REFUND_MIN, wideKm: DD.WIDE_RADIUS_M / 1000, normalKm: DD.SEARCH_RADIUS_M / 1000, areasKnown: areas.length,
      waiting: out, alerts: out.filter(function (x) { return x.alert; }).length });
  } catch (e) { res.status(500).json({ error: 'server' }); }
});

/* 5. POST /commission-status {transactionIds:[...]}  6 Nov 2026, Jeffery: "Make sure Jennifer can see the referring
   Ajan, confirmed payment, commission amount, and payout status." Tikè Lakay keeps the sale; the payout status of the
   Ajan's commission lives here. Read-only, at most 500 references per call. */
router.post('/commission-status', async (req, res) => {
  try {
    const KoutyeCommission = require('../models/KoutyeCommission');
    const ids = (Array.isArray(req.body && req.body.transactionIds) ? req.body.transactionIds : []).map(String).filter(Boolean).slice(0, 500);
    if (!ids.length) return res.json({ commissions: [] });
    const rows = await KoutyeCommission.find({ transactionId: { $in: ids } })
      .select('transactionId amount status platform commissionRate paidAt createdAt koutye').populate('koutye', 'koutyeCode').lean();
    res.json({ commissions: rows.map((c) => ({ transactionId: c.transactionId, amount: c.amount, status: c.status, platform: c.platform,
      rate: c.commissionRate, paidAt: c.paidAt || null, at: c.createdAt, koutyeCode: (c.koutye && c.koutye.koutyeCode) || '' })) });
  } catch (e) { res.status(500).json({ error: 'server' }); }
});

module.exports = router;
