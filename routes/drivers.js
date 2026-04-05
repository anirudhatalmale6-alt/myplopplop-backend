const express = require('express');
const DriverProfile = require('../models/DriverProfile');
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');
const upload = require('../middleware/upload');

const router = express.Router();

// POST /api/drivers/onboard - Driver submits application
router.post('/onboard', protect, upload.fields([
  { name: 'licensePhoto', maxCount: 1 },
  { name: 'insurancePhoto', maxCount: 1 },
  { name: 'vehiclePhoto', maxCount: 1 },
  { name: 'idPhoto', maxCount: 1 }
]), async (req, res) => {
  try {
    const existing = await DriverProfile.findOne({ user: req.user._id });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Driver profile already exists' });
    }

    const { vehicleType, vehiclePlate, vehicleModel, vehicleColor, licenseNumber, services, referralCode } = req.body;

    // Apply referral code if provided during driver onboarding
    if (referralCode) {
      const referrer = await User.findOne({ referralCode: referralCode.toUpperCase() });
      if (referrer) {
        await User.findByIdAndUpdate(req.user._id, { referredBy: referrer._id });
        referrer.referralCount = (referrer.referralCount || 0) + 1;
        await referrer.save();
      }
    }

    const profile = await DriverProfile.create({
      user: req.user._id,
      vehicleType,
      vehiclePlate,
      vehicleModel,
      vehicleColor,
      licenseNumber,
      services: services ? JSON.parse(services) : ['delivery'],
      licensePhoto: req.files?.licensePhoto?.[0]?.path,
      insurancePhoto: req.files?.insurancePhoto?.[0]?.path,
      vehiclePhoto: req.files?.vehiclePhoto?.[0]?.path,
      idPhoto: req.files?.idPhoto?.[0]?.path
    });

    // Update user role to driver
    await User.findByIdAndUpdate(req.user._id, { role: 'driver' });

    res.status(201).json({ success: true, profile });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/drivers/profile - Get own driver profile
router.get('/profile', protect, authorize('driver'), async (req, res) => {
  try {
    const profile = await DriverProfile.findOne({ user: req.user._id }).populate('user', 'name phone');
    if (!profile) {
      return res.status(404).json({ success: false, message: 'Driver profile not found' });
    }
    res.json({ success: true, profile });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/drivers/location - Update driver location
router.put('/location', protect, authorize('driver'), async (req, res) => {
  try {
    const { longitude, latitude } = req.body;
    await DriverProfile.findOneAndUpdate(
      { user: req.user._id },
      {
        currentLocation: {
          type: 'Point',
          coordinates: [longitude, latitude]
        }
      }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/drivers/online - Toggle online status
router.put('/online', protect, authorize('driver'), async (req, res) => {
  try {
    const { isOnline } = req.body;
    const profile = await DriverProfile.findOneAndUpdate(
      { user: req.user._id },
      { isOnline },
      { new: true }
    );
    res.json({ success: true, isOnline: profile.isOnline });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/drivers/nearby - Find nearby drivers
router.get('/nearby', async (req, res) => {
  try {
    const { longitude, latitude, maxDistance = 10000, type = 'delivery' } = req.query;

    const drivers = await DriverProfile.find({
      status: 'approved',
      isOnline: true,
      services: type,
      currentLocation: {
        $near: {
          $geometry: {
            type: 'Point',
            coordinates: [parseFloat(longitude), parseFloat(latitude)]
          },
          $maxDistance: parseInt(maxDistance) // meters
        }
      }
    }).populate('user', 'name phone').limit(20);

    res.json({ success: true, count: drivers.length, drivers });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/drivers/stats - Driver stats
router.get('/stats', protect, authorize('driver'), async (req, res) => {
  try {
    const profile = await DriverProfile.findOne({ user: req.user._id });
    if (!profile) {
      return res.status(404).json({ success: false, message: 'Profile not found' });
    }
    res.json({
      success: true,
      stats: {
        totalRides: profile.totalRides,
        totalDeliveries: profile.totalDeliveries,
        totalEarnings: profile.totalEarnings,
        rating: profile.rating,
        grade: profile.grade,
        status: profile.status,
        isOnline: profile.isOnline
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
