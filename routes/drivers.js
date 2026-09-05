const express = require('express');
const DriverProfile = require('../models/DriverProfile');
const User = require('../models/User');
const { protect, authorize } = require('../middleware/auth');
const upload = require('../middleware/upload');
const { notifySignup } = require('../utils/notify');
const { attachReferral } = require('../services/referral');

const router = express.Router();

const VALID_SERVICES = ['delivery', 'ride'];

/* What kind of driver is signing up.

   This arrives from a multipart form, so it can be a JSON array from one page
   ('["delivery"]'), a plain word from another ('delivery'), or the same field
   sent twice, which multer hands over as a real array. The old line was
   JSON.parse(services) with no guard: a form that sent the plain word threw
   SyntaxError into the outer catch, and the driver got "500 Server error" with
   no profile created and no clue why.

   Anything unrecognised falls back to delivery, because this endpoint is
   reached from myplopplop.com, and MyPlopPlop is deliveries. */
function parseServices(raw) {
  var list = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === 'string' && raw.trim()) {
    var s = raw.trim();
    if (s.charAt(0) === '[') {
      try { list = JSON.parse(s); } catch (e) { list = s.split(','); }
    } else {
      list = s.split(',');
    }
  }
  list = (list || [])
    .map(function (v) { return String(v).trim().toLowerCase(); })
    .filter(function (v) { return VALID_SERVICES.indexOf(v) !== -1; });

  // de-duplicate, keep a stable order
  var out = VALID_SERVICES.filter(function (v) { return list.indexOf(v) !== -1; });
  return out.length ? out : ['delivery'];
}

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

    const wanted = parseServices(services);

    const profile = await DriverProfile.create({
      user: req.user._id,
      vehicleType,
      vehiclePlate,
      vehicleModel,
      vehicleColor,
      licenseNumber,
      services: wanted,
      licensePhoto: req.files?.licensePhoto?.[0]?.path,
      insurancePhoto: req.files?.insurancePhoto?.[0]?.path,
      vehiclePhoto: req.files?.vehiclePhoto?.[0]?.path,
      idPhoto: req.files?.idPhoto?.[0]?.path
    });

    // Update user role to driver
    await User.findByIdAndUpdate(req.user._id, { role: 'driver' });

    // Credit the LajanMaker agent who recruited this driver, same 12-month
    // window as a customer or a merchant.
    const agentCode = req.body.koutyeCode || req.body.agentCode || req.body.ref;
    const refResult = await attachReferral({
      code: agentCode,
      platform: 'myplopplop',
      entityType: 'driver',
      user: req.user._id,
      name: req.user.name,
      phone: req.user.phone,
      source: 'Driver registration (' + wanted.join('+') + ')'
    });
    if (agentCode && !refResult.attached) {
      console.warn('Driver ' + req.user.phone + ' carried agent code "' + agentCode +
        '" but it was not attached: ' + refResult.reason);
    }

    notifySignup('driver', {
      name: req.user.name, phone: req.user.phone,
      vehicleType, plate: vehiclePlate,
      driverType: profile.driverType
    }).catch(() => {});

    res.status(201).json({
      success: true,
      profile,
      referredByAgent: refResult.attached ? refResult.referral.koutyeCode : null
    });
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
