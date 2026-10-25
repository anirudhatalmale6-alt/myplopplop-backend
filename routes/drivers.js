const express = require('express');
const DriverProfile = require('../models/DriverProfile');
const User = require('../models/User');
const { protect, authorize, driverAccess } = require('../middleware/auth');
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

    /* 23 Oct 2026: a plain customer account becomes a driver account, as
       before. Any other account (admin, merchant, ...) KEEPS its role: the
       profile above is what makes it a driver now (middleware driverAccess).
       Overwriting the role silently took the owner's admin dashboard away. */
    if (!req.user.role || req.user.role === 'customer') {
      await User.findByIdAndUpdate(req.user._id, { role: 'driver' });
    }

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

/* POST /api/drivers/link-msouwout {pin} - "I am already a MsouWout driver".
   24 Oct 2026, Jeffery: ONE DRIVER, ONE REGISTRATION. No form: the signed-in
   MyPlopPlop account proves it holds the MsouWout driver account with the SAME
   phone by giving THAT account's PIN (checked and counted by MsouWout). The
   delivery profile is built from the MsouWout record and starts PENDING - an
   administrator still approves deliveries, with the MsouWout documents in
   front of him. The account keeps its role (an admin stays admin). */
router.post('/link-msouwout', protect, async (req, res) => {
  try {
    const link = require('../utils/msouwoutLink');
    const pin = String((req.body && req.body.pin) || '').trim();
    if (!/^\d{4,8}$/.test(pin)) return res.status(400).json({ success: false, code: 'pin_required', message: 'Enter your MsouWout PIN' });
    const r = await link.verify(req.user.phone, pin);
    const e = r.data && r.data.error;
    if (r.status !== 200) {
      const map = {
        no_driver: [404, 'No MsouWout driver has this phone number'],
        several_drivers: [409, 'Several MsouWout drivers share this phone number - an administrator must check'],
        no_pin: [409, 'Your MsouWout account has no PIN yet. Open the MsouWout driver app, set your PIN, then come back'],
        pin_wrong: [401, 'Wrong MsouWout PIN' + (r.data.remaining != null ? ' (' + r.data.remaining + ' tries left)' : '')],
        pin_locked: [429, 'Too many wrong PINs. Try again in ' + (r.data.minutes || 15) + ' minutes'],
        link_not_configured: [503, 'The link to MsouWout is not configured'],
        msouwout_unreachable: [504, 'MsouWout did not answer. Try again in a minute']
      };
      const m = map[e] || [502, 'MsouWout could not check this account'];
      return res.status(m[0]).json({ success: false, code: e || 'error', message: m[1], remaining: r.data.remaining });
    }
    const d = r.data.driver || {};
    if (d.status !== 'approved' || d.is_active === false) {
      return res.status(409).json({ success: false, code: 'msouwout_not_approved',
        message: 'Your MsouWout driver profile is not approved (' + d.status + '). It must be approved on MsouWout first.' });
    }
    const facts = {
      driverId: String(d.id), linkedAt: new Date(), fullName: d.full_name, phone: d.phone, status: d.status,
      licenseNumber: d.license_number || '',
      vehicle: [d.vehicle_make, d.vehicle_model, d.vehicle_year].filter(Boolean).join(' '),
      documents: r.data.documents || [], nameMatches: link.sameName(req.user.name, d.full_name)
    };
    const taken = await DriverProfile.findOne({ 'msouwout.driverId': facts.driverId, user: { $ne: req.user._id } }).select('_id');
    if (taken) return res.status(409).json({ success: false, code: 'linked_elsewhere', message: 'This MsouWout driver is already linked to another MyPlopPlop account' });

    let profile = await DriverProfile.findOne({ user: req.user._id });
    if (profile) {
      if (profile.msouwout && profile.msouwout.driverId && profile.msouwout.driverId !== facts.driverId) {
        return res.status(409).json({ success: false, code: 'linked_other', message: 'This account is already linked to another MsouWout driver' });
      }
      profile.msouwout = facts;
      if ((profile.services || []).indexOf('delivery') === -1) profile.services = (profile.services || []).concat('delivery');
      await profile.save();
    } else {
      profile = await DriverProfile.create({
        user: req.user._id,
        vehicleType: link.VEHICLE[String(d.vehicle_type || '').toLowerCase()] || 'moto',
        vehiclePlate: d.license_plate || ('MW-' + d.id),
        vehicleModel: [d.vehicle_make, d.vehicle_model].filter(Boolean).join(' '),
        vehicleColor: d.vehicle_color || '',
        licenseNumber: d.license_number || ('MW-' + d.id),
        services: ['delivery'],
        status: 'pending',
        msouwout: facts
      });
      if (!req.user.role || req.user.role === 'customer') {
        await User.findByIdAndUpdate(req.user._id, { role: 'driver' });
      }
    }
    require('../services/activity').record(req, 'driver.link_msouwout', { targetType: 'DriverProfile', targetId: profile._id,
      targetLabel: profile.vehiclePlate, detail: { msouwoutId: facts.driverId, nameMatches: facts.nameMatches } });
    res.json({ success: true, profile });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/drivers/profile - Get own driver profile
router.get('/profile', protect, driverAccess, async (req, res) => {
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
router.put('/location', protect, driverAccess, async (req, res) => {
  try {
    const { longitude, latitude } = req.body;
    await DriverProfile.findOneAndUpdate(
      { user: req.user._id },
      {
        currentLocation: {
          type: 'Point',
          coordinates: [Number(longitude), Number(latitude)]
        },
        // 16 Oct 2026: dispatch only offers jobs to drivers who reported recently
        locationUpdatedAt: new Date()
      }
    );
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/drivers/online - Toggle online status
router.put('/online', protect, driverAccess, async (req, res) => {
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
    }).select('currentLocation vehicleType').limit(20);

    /* 🛑 15 Oct 2026: PUBLIC, so it says only how many drivers are near and
       roughly where (about 1 km). It returned each driver's name, phone,
       licence number, the paths of their ID and licence photos, and their
       exact live GPS position to anyone. No page needs more than this. */
    res.json({ success: true, count: drivers.length, drivers: drivers.map(d => ({
      vehicleType: d.vehicleType,
      approxLocation: (d.currentLocation && d.currentLocation.coordinates || []).map(c => Math.round(c * 100) / 100)
    })) });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/drivers/stats - Driver stats
router.get('/stats', protect, driverAccess, async (req, res) => {
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
