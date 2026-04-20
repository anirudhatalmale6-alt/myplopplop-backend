const express = require('express');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const { protect } = require('../middleware/auth');

const router = express.Router();

// POST /api/auth/register
// Accepts either 'password' or 'pin' field (frontend uses 4-digit PIN)
router.post('/register', [
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('phone').trim().notEmpty().withMessage('Phone is required')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    const { name, phone, email, role, language, isDiaspora, country, referralCode } = req.body;
    // Accept either 'pin' or 'password' field
    const password = req.body.pin || req.body.password;

    if (!password || password.length < 4) {
      return res.status(400).json({ success: false, message: 'PIN must be at least 4 digits' });
    }

    // Check if phone already exists
    const existing = await User.findOne({ phone });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Phone number already registered' });
    }

    // Look up referrer if referral code provided
    let referredBy = null;
    if (referralCode) {
      const referrer = await User.findOne({ referralCode: referralCode.toUpperCase() });
      if (referrer) {
        referredBy = referrer._id;
        referrer.referralCount = (referrer.referralCount || 0) + 1;
        await referrer.save();
      }
    }

    const user = await User.create({
      name, phone, email, password,
      role: role || 'customer',
      language: language || 'fr',
      isDiaspora: isDiaspora || false,
      country,
      referredBy,
      referredAt: referredBy ? new Date() : undefined
    });

    const token = user.getSignedJwtToken();

    res.status(201).json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        phone: user.phone,
        role: user.role,
        language: user.language,
        wallet: user.wallet,
        referralCode: user.referralCode
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/auth/login
// Accepts either 'password' or 'pin' field
router.post('/login', [
  body('phone').trim().notEmpty()
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    const { phone } = req.body;
    const password = req.body.pin || req.body.password;

    if (!password) {
      return res.status(400).json({ success: false, message: 'PIN is required' });
    }

    const user = await User.findOne({ phone }).select('+password');
    if (!user) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    const isMatch = await user.matchPassword(password);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Invalid credentials' });
    }

    user.lastLogin = new Date();
    await user.save();

    const token = user.getSignedJwtToken();

    res.json({
      success: true,
      token,
      user: {
        id: user._id,
        name: user.name,
        phone: user.phone,
        role: user.role,
        language: user.language,
        wallet: user.wallet,
        referralCode: user.referralCode
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// GET /api/auth/me
router.get('/me', protect, async (req, res) => {
  const user = await User.findById(req.user._id);
  res.json({
    success: true,
    user: {
      id: user._id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      role: user.role,
      language: user.language,
      isDiaspora: user.isDiaspora,
      country: user.country,
      wallet: user.wallet,
      avatar: user.avatar,
      referralCode: user.referralCode,
      referralEarnings: user.referralEarnings,
      referralCount: user.referralCount,
      createdAt: user.createdAt,
      lastLogin: user.lastLogin
    }
  });
});

// PUT /api/auth/profile (update profile)
router.put('/profile', protect, async (req, res) => {
  try {
    const updates = {};
    if (req.body.name) updates.name = req.body.name;
    if (req.body.email) updates.email = req.body.email;
    if (req.body.language) updates.language = req.body.language;
    if (req.body.avatar) updates.avatar = req.body.avatar;

    const user = await User.findByIdAndUpdate(req.user._id, updates, { new: true });

    res.json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        phone: user.phone,
        email: user.email,
        role: user.role,
        language: user.language,
        wallet: user.wallet
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/auth/forgot-pin — reset PIN by phone number
// Since no SMS service is configured yet, this resets PIN directly
// In production, this should send an OTP via SMS first
router.post('/forgot-pin', [
  body('phone').trim().notEmpty().withMessage('Phone number is required'),
  body('newPin').isLength({ min: 4, max: 4 }).withMessage('PIN must be exactly 4 digits')
    .isNumeric().withMessage('PIN must be numeric')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    const { phone, newPin } = req.body;
    const user = await User.findOne({ phone }).select('+password');
    if (!user) {
      return res.status(404).json({ success: false, message: 'No account found with this phone number' });
    }

    user.password = newPin;
    await user.save();

    const token = user.getSignedJwtToken();

    res.json({
      success: true,
      message: 'PIN reset successfully',
      token,
      user: {
        id: user._id,
        name: user.name,
        phone: user.phone,
        role: user.role,
        language: user.language,
        wallet: user.wallet,
        referralCode: user.referralCode
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// PUT /api/auth/change-pin
router.put('/change-pin', protect, [
  body('currentPin').notEmpty().withMessage('Current PIN is required'),
  body('newPin').isLength({ min: 4 }).withMessage('New PIN must be at least 4 digits')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ success: false, errors: errors.array() });
  }

  try {
    const user = await User.findById(req.user._id).select('+password');
    const isMatch = await user.matchPassword(req.body.currentPin);
    if (!isMatch) {
      return res.status(401).json({ success: false, message: 'Current PIN is incorrect' });
    }

    user.password = req.body.newPin;
    await user.save();

    res.json({ success: true, message: 'PIN updated successfully' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
