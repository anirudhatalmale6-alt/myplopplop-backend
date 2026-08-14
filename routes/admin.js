const express = require('express');
const User = require('../models/User');
const DriverProfile = require('../models/DriverProfile');
const Ride = require('../models/Ride');
const Transaction = require('../models/Transaction');
const Order = require('../models/Order');
const Store = require('../models/Store');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// All admin routes require admin role
router.use(protect, authorize('admin'));

// GET /api/admin/dashboard - Dashboard stats
router.get('/dashboard', async (req, res) => {
  try {
    const [
      totalUsers,
      totalDrivers,
      pendingDrivers,
      totalRides,
      activeRides,
      completedRides
    ] = await Promise.all([
      User.countDocuments(),
      DriverProfile.countDocuments({ status: 'approved' }),
      DriverProfile.countDocuments({ status: 'pending' }),
      Ride.countDocuments(),
      Ride.countDocuments({ status: { $in: ['requested', 'accepted', 'picking_up', 'in_progress'] } }),
      Ride.countDocuments({ status: 'delivered' })
    ]);

    // Total revenue (commissions)
    const commissions = await Transaction.aggregate([
      { $match: { type: 'commission', status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    res.json({
      success: true,
      stats: {
        totalUsers,
        totalDrivers,
        pendingDrivers,
        totalRides,
        activeRides,
        completedRides,
        totalRevenue: commissions[0]?.total || 0
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/admin/drivers - List all driver applications
router.get('/drivers', async (req, res) => {
  try {
    const { status = 'pending' } = req.query;
    const drivers = await DriverProfile.find({ status })
      .populate('user', 'name phone email')
      .sort({ createdAt: -1 });

    res.json({ success: true, count: drivers.length, drivers });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/admin/drivers/:id/verify - Approve or reject a driver
router.put('/drivers/:id/verify', async (req, res) => {
  try {
    const { action, reason } = req.body; // action: 'approve' or 'reject'

    const profile = await DriverProfile.findById(req.params.id);
    if (!profile) {
      return res.status(404).json({ success: false, message: 'Driver not found' });
    }

    if (action === 'approve') {
      profile.status = 'approved';
      profile.verifiedBy = req.user._id;
      profile.verifiedAt = new Date();
    } else if (action === 'reject') {
      profile.status = 'rejected';
      profile.rejectionReason = reason || 'Documents not valid';
    } else {
      return res.status(400).json({ success: false, message: 'Action must be approve or reject' });
    }

    await profile.save();
    res.json({ success: true, profile });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/admin/rides - All rides with filters
router.get('/rides', async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const query = {};
    if (status) query.status = status;

    const rides = await Ride.find(query)
      .populate('customer', 'name phone')
      .populate('driver', 'name phone')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Ride.countDocuments(query);
    res.json({ success: true, count: rides.length, total, rides });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/admin/users - All users
router.get('/users', async (req, res) => {
  try {
    const { role, page = 1, limit = 50 } = req.query;
    const query = {};
    if (role) query.role = role;

    const users = await User.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await User.countDocuments(query);
    res.json({ success: true, count: users.length, total, users });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/admin/transactions - All transactions
router.get('/transactions', async (req, res) => {
  try {
    const { type, page = 1, limit = 50 } = req.query;
    const query = {};
    if (type) query.type = type;

    const transactions = await Transaction.find(query)
      .populate('user', 'name phone')
      .populate('ride')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Transaction.countDocuments(query);
    res.json({ success: true, count: transactions.length, total, transactions });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/admin/orders - Every marketplace order (the admin Orders screen had
// no endpoint to call, which is why it was still showing sample rows)
router.get('/orders', async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const query = {};
    if (status) query.status = status;

    const orders = await Order.find(query)
      .populate('customer', 'name phone')
      .populate('store', 'name phone')
      .populate('rider', 'name phone')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Order.countDocuments(query);
    res.json({ success: true, count: orders.length, total, orders });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/admin/stores - Every store, including suspended/pending ones that
// the public GET /api/stores deliberately hides
router.get('/stores', async (req, res) => {
  try {
    const { status, page = 1, limit = 100 } = req.query;
    const query = {};
    if (status) query.status = status;

    const stores = await Store.find(query)
      .populate('owner', 'name phone email')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const total = await Store.countDocuments(query);
    res.json({ success: true, count: stores.length, total, stores });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PATCH /api/admin/stores/:id - verify / unverify / suspend / activate
router.patch('/stores/:id', async (req, res) => {
  try {
    const store = await Store.findById(req.params.id);
    if (!store) return res.status(404).json({ success: false, message: 'Store not found' });

    const action = req.body.action;
    if (action === 'verify') store.isVerified = true;
    else if (action === 'unverify') store.isVerified = false;
    else if (action === 'suspend') store.status = 'suspended';
    else if (action === 'activate') store.status = 'active';
    else {
      if (req.body.isVerified !== undefined) store.isVerified = !!req.body.isVerified;
      if (req.body.status !== undefined) store.status = req.body.status;
    }

    await store.save();
    res.json({ success: true, data: store });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
