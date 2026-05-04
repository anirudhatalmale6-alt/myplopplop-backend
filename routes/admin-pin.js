const express = require('express');
const router = express.Router();
const User = require('../models/User');
const DriverProfile = require('../models/DriverProfile');
const Ride = require('../models/Ride');
const Order = require('../models/Order');
const Store = require('../models/Store');
const Transaction = require('../models/Transaction');

let Koutye, KoutyeReferral;
try { Koutye = require('../models/Koutye'); } catch(e) { Koutye = null; }
try { KoutyeReferral = require('../models/KoutyeReferral'); } catch(e) { KoutyeReferral = null; }

const ADMIN_PIN = process.env.ADMIN_PIN || 'hb2026admin';

function requirePin(req, res, next) {
  const pin = req.headers['x-admin-pin'] || req.query.pin;
  if (pin !== ADMIN_PIN) return res.status(403).json({ error: 'Invalid PIN' });
  next();
}

router.use(requirePin);

router.get('/dashboard', async (req, res) => {
  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const queries = [
      User.countDocuments(),
      User.countDocuments({ createdAt: { $gte: today } }),
      User.countDocuments({ role: 'customer' }),
      User.countDocuments({ role: 'driver' }),
      User.countDocuments({ role: 'merchant' }),
      DriverProfile.countDocuments(),
      DriverProfile.countDocuments({ status: 'approved' }),
      DriverProfile.countDocuments({ status: 'pending' }),
      Ride.countDocuments(),
      Ride.countDocuments({ status: { $in: ['requested', 'accepted', 'picking_up', 'in_progress'] } }),
      Ride.countDocuments({ status: 'delivered' }),
      Order.countDocuments(),
      Order.countDocuments({ status: { $in: ['pending', 'confirmed', 'preparing', 'ready'] } }),
      Order.countDocuments({ status: 'delivered' }),
      Order.countDocuments({ payoutStatus: 'held' }),
      Store.countDocuments(),
      Store.countDocuments({ status: 'active' }),
      Transaction.aggregate([
        { $match: { type: 'commission', status: 'completed' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]),
      Order.aggregate([
        { $match: { paymentStatus: 'paid' } },
        { $group: { _id: null, total: { $sum: '$total' }, commission: { $sum: '$commission' } } }
      ])
    ];

    if (Koutye) {
      queries.push(Koutye.countDocuments());
      queries.push(Koutye.countDocuments({ status: 'active' }));
    }
    if (KoutyeReferral) {
      queries.push(KoutyeReferral.countDocuments());
    }

    const results = await Promise.all(queries);

    const commissionRev = results[17][0] || { total: 0 };
    const orderRev = results[18][0] || { total: 0, commission: 0 };

    const stats = {
      totalUsers: results[0],
      todayUsers: results[1],
      customers: results[2],
      drivers: results[3],
      merchants: results[4],
      totalDriverProfiles: results[5],
      approvedDrivers: results[6],
      pendingDrivers: results[7],
      totalRides: results[8],
      activeRides: results[9],
      completedRides: results[10],
      totalOrders: results[11],
      activeOrders: results[12],
      completedOrders: results[13],
      heldOrders: results[14],
      totalStores: results[15],
      activeStores: results[16],
      commissionRevenue: commissionRev.total,
      orderRevenue: orderRev.total,
      orderCommission: orderRev.commission,
      totalKoutye: Koutye ? results[19] : 0,
      activeKoutye: Koutye ? results[20] : 0,
      totalReferrals: KoutyeReferral ? results[21] : 0
    };

    const recent = [];

    const recentUsers = await User.find().sort({ createdAt: -1 }).limit(5).select('name phone role createdAt email').lean();
    recentUsers.forEach(u => recent.push({
      type: 'user', date: u.createdAt,
      label: u.name + ' (' + u.role + ')',
      detail: u.phone || u.email || '',
      phone: u.phone
    }));

    const recentOrders = await Order.find().sort({ createdAt: -1 }).limit(5).populate('store', 'name').lean();
    recentOrders.forEach(o => recent.push({
      type: 'order', date: o.createdAt,
      label: '#' + (o.orderNumber || o._id.toString().slice(-6)) + ' — ' + (o.store?.name || 'Unknown'),
      detail: o.total + ' HTG · ' + o.status,
      status: o.status
    }));

    const recentRides = await Ride.find().sort({ createdAt: -1 }).limit(5).populate('customer', 'name phone').lean();
    recentRides.forEach(r => recent.push({
      type: 'ride', date: r.createdAt,
      label: (r.customer?.name || 'Unknown') + ' — ' + r.type,
      detail: (r.pickup?.address || '') + ' → ' + (r.dropoff?.address || ''),
      status: r.status,
      phone: r.customer?.phone
    }));

    recent.sort((a, b) => new Date(b.date) - new Date(a.date));

    res.json({ success: true, stats, recent: recent.slice(0, 15) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/users', async (req, res) => {
  try {
    const { role, search, page = 1 } = req.query;
    const limit = 20;
    const filter = {};
    if (role) filter.role = role;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { email: { $regex: search, $options: 'i' } }
      ];
    }
    const total = await User.countDocuments(filter);
    const users = await User.find(filter).select('-password').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean();
    res.json({ success: true, users, page: +page, pages: Math.ceil(total / limit), total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/drivers', async (req, res) => {
  try {
    const { status, search, page = 1 } = req.query;
    const limit = 20;
    const filter = {};
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { vehiclePlate: { $regex: search, $options: 'i' } },
        { vehicleModel: { $regex: search, $options: 'i' } }
      ];
    }
    const total = await DriverProfile.countDocuments(filter);
    const drivers = await DriverProfile.find(filter).populate('user', 'name phone email').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean();
    res.json({ success: true, drivers, page: +page, pages: Math.ceil(total / limit), total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/rides', async (req, res) => {
  try {
    const { status, search, page = 1 } = req.query;
    const limit = 20;
    const filter = {};
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { 'pickup.address': { $regex: search, $options: 'i' } },
        { 'dropoff.address': { $regex: search, $options: 'i' } }
      ];
    }
    const total = await Ride.countDocuments(filter);
    const rides = await Ride.find(filter).populate('customer', 'name phone').populate('driver', 'name phone').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean();
    res.json({ success: true, rides, page: +page, pages: Math.ceil(total / limit), total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/orders', async (req, res) => {
  try {
    const { status, search, page = 1 } = req.query;
    const limit = 20;
    const filter = {};
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { orderNumber: { $regex: search, $options: 'i' } },
        { 'recipient.name': { $regex: search, $options: 'i' } },
        { 'recipient.phone': { $regex: search, $options: 'i' } }
      ];
    }
    const total = await Order.countDocuments(filter);
    const orders = await Order.find(filter).populate('customer', 'name phone').populate('store', 'name').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean();
    res.json({ success: true, orders, page: +page, pages: Math.ceil(total / limit), total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stores', async (req, res) => {
  try {
    const { status, search, page = 1 } = req.query;
    const limit = 20;
    const filter = {};
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { 'address.city': { $regex: search, $options: 'i' } }
      ];
    }
    const total = await Store.countDocuments(filter);
    const stores = await Store.find(filter).populate('owner', 'name phone').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean();
    res.json({ success: true, stores, page: +page, pages: Math.ceil(total / limit), total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/koutye', async (req, res) => {
  try {
    if (!Koutye) return res.json({ success: true, koutye: [], total: 0, page: 1, pages: 0 });
    const { status, search, page = 1 } = req.query;
    const limit = 20;
    const filter = {};
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { koutyeCode: { $regex: search, $options: 'i' } },
        { whatsapp: { $regex: search, $options: 'i' } }
      ];
    }
    const total = await Koutye.countDocuments(filter);
    const koutye = await Koutye.find(filter).populate('user', 'name phone').sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean();
    res.json({ success: true, koutye, page: +page, pages: Math.ceil(total / limit), total });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
