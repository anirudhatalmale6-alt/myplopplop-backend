const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const User = require('../models/User');
const Transaction = require('../models/Transaction');

// ─── Get my referral info ───
// GET /api/referrals/me
router.get('/me', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);

    // Generate referral code if driver doesn't have one yet
    if (user.role === 'driver' && !user.referralCode) {
      var namePart = user.name.replace(/[^a-zA-Z]/g, '').substring(0, 4).toUpperCase();
      var randPart = Math.random().toString(36).substring(2, 6).toUpperCase();
      user.referralCode = 'PP' + namePart + randPart;
      await user.save();
    }

    // Get list of referred drivers
    const referrals = await User.find({ referredBy: user._id })
      .select('name phone createdAt')
      .sort({ createdAt: -1 })
      .limit(50);

    // Get referral transactions
    const referralTransactions = await Transaction.find({
      user: user._id,
      type: 'referral'
    }).sort({ createdAt: -1 }).limit(20);

    res.json({
      success: true,
      referralCode: user.referralCode || null,
      referralCount: user.referralCount || 0,
      referralEarnings: user.referralEarnings || 0,
      referrals: referrals,
      recentEarnings: referralTransactions
    });
  } catch (error) {
    console.error('Referral info error:', error);
    res.status(500).json({ success: false, message: 'Failed to get referral info' });
  }
});

// ─── Apply referral code during driver signup ───
// POST /api/referrals/apply
router.post('/apply', protect, async (req, res) => {
  try {
    const { referralCode } = req.body;
    if (!referralCode) {
      return res.status(400).json({ success: false, message: 'Referral code required' });
    }

    const user = await User.findById(req.user._id);

    // Can't refer yourself
    if (user.referralCode === referralCode.toUpperCase()) {
      return res.status(400).json({ success: false, message: 'Cannot use your own referral code' });
    }

    // Already has a referrer
    if (user.referredBy) {
      return res.status(400).json({ success: false, message: 'Referral code already applied' });
    }

    // Find the referrer
    const referrer = await User.findOne({
      referralCode: referralCode.toUpperCase()
    });

    if (!referrer) {
      return res.status(404).json({ success: false, message: 'Invalid referral code' });
    }

    // Apply referral
    user.referredBy = referrer._id;
    await user.save();

    // Increment referrer's count
    referrer.referralCount = (referrer.referralCount || 0) + 1;
    await referrer.save();

    res.json({
      success: true,
      message: 'Referral code applied! ' + referrer.name + ' will earn 2.5% of commission on your rides.',
      referrerName: referrer.name
    });
  } catch (error) {
    console.error('Apply referral error:', error);
    res.status(500).json({ success: false, message: 'Failed to apply referral code' });
  }
});

// ─── Validate referral code (check if it exists) ───
// GET /api/referrals/validate/:code
router.get('/validate/:code', async (req, res) => {
  try {
    const referrer = await User.findOne({
      referralCode: req.params.code.toUpperCase()
    }).select('name');

    if (!referrer) {
      return res.status(404).json({ success: false, message: 'Invalid referral code' });
    }

    res.json({
      success: true,
      referrerName: referrer.name
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Validation failed' });
  }
});

// ─── Admin: View all referral stats ───
// GET /api/referrals/admin/stats
router.get('/admin/stats', protect, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Admin only' });
    }

    const topReferrers = await User.find({
      referralCount: { $gt: 0 }
    })
    .select('name phone referralCode referralCount referralEarnings')
    .sort({ referralCount: -1 })
    .limit(20);

    const totalReferrals = await User.countDocuments({ referredBy: { $ne: null } });
    const totalPaidOut = await Transaction.aggregate([
      { $match: { type: 'referral', status: 'completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    res.json({
      success: true,
      totalReferrals: totalReferrals,
      totalPaidOut: totalPaidOut.length > 0 ? totalPaidOut[0].total : 0,
      topReferrers: topReferrers
    });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to get stats' });
  }
});

module.exports = router;
