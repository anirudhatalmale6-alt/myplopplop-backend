const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const Koutye = require('../models/Koutye');
const KoutyeReferral = require('../models/KoutyeReferral');
const KoutyeCommission = require('../models/KoutyeCommission');
const KoutyePayout = require('../models/KoutyePayout');
const KoutyeWallet = require('../models/KoutyeWallet');
const User = require('../models/User');

const COMMISSION_WINDOW_DAYS = 365;
const MIN_PAYOUT_HTG = 500;

const COMMISSION_RATES = {
  '48hoursready': { rate: 0.10, type: 'percentage', label: '10% on packages' },
  'msouwout': { rate: 0.10, type: 'percentage', label: 'Recurring up to 12 months' },
  'myplopplop': { rate: 0.10, type: 'percentage', label: 'Recurring up to 12 months' },
  'utility': { rate: 0.05, type: 'per_transaction', label: 'Per transaction' },
  'sol': { rate: 0.03, type: 'per_activity', label: 'Per group/activity' },
  'prolakay': { rate: 0.10, type: 'percentage', label: 'Per referral' }
};

function generateKoutyeCode(name) {
  const clean = (name || 'KOUTYE').replace(/[^a-zA-Z]/g, '').substring(0, 3).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 7).toUpperCase();
  return 'KB-' + clean + rand;
}

// POST /api/koutye/register - Become a Koutye ambassador
router.post('/register', protect, async (req, res) => {
  try {
    const existing = await Koutye.findOne({ user: req.user._id });
    if (existing) {
      return res.status(400).json({ success: false, message: 'Ou deja yon Koutye!' });
    }

    const { whatsapp, bio, payoutMethod, payoutDetails } = req.body;

    let koutyeCode;
    let attempts = 0;
    do {
      koutyeCode = generateKoutyeCode(req.user.name);
      const exists = await Koutye.findOne({ koutyeCode });
      if (!exists) break;
      attempts++;
    } while (attempts < 10);

    const koutye = await Koutye.create({
      user: req.user._id,
      koutyeCode,
      whatsapp: whatsapp || req.user.phone,
      bio,
      payoutMethod: payoutMethod || 'moncash',
      payoutDetails: payoutDetails || { phone: req.user.phone }
    });

    await KoutyeWallet.create({ koutye: koutye._id });

    res.status(201).json({
      success: true,
      data: {
        koutyeCode: koutye.koutyeCode,
        referralLink: `haitibiznis.com?ref=${koutye.koutyeCode}`,
        tier: koutye.tier,
        status: koutye.status
      }
    });
  } catch (err) {
    console.error('Koutye register error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/koutye/dashboard - Koutye dashboard data
router.get('/dashboard', protect, async (req, res) => {
  try {
    const koutye = await Koutye.findOne({ user: req.user._id });
    if (!koutye) {
      return res.status(404).json({ success: false, message: 'Koutye profile not found' });
    }

    const activeReferrals = await KoutyeReferral.countDocuments({
      koutye: koutye._id,
      status: 'active',
      expiryDate: { $gt: new Date() }
    });

    const pendingCommissions = await KoutyeCommission.aggregate([
      { $match: { koutye: koutye._id, status: 'pending' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    const approvedCommissions = await KoutyeCommission.aggregate([
      { $match: { koutye: koutye._id, status: 'approved' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    const recentCommissions = await KoutyeCommission.find({ koutye: koutye._id })
      .sort({ createdAt: -1 })
      .limit(10)
      .populate('referral', 'platform referredEntity.name');

    const platformStats = await KoutyeCommission.aggregate([
      { $match: { koutye: koutye._id, status: { $in: ['pending', 'approved', 'paid'] } } },
      { $group: { _id: '$platform', total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);

    const pendingPayouts = await KoutyePayout.aggregate([
      { $match: { koutye: koutye._id, status: { $in: ['pending', 'processing'] } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    koutye.stats.activeReferrals = activeReferrals;
    koutye.stats.pendingEarnings = (pendingCommissions[0]?.total || 0) + (approvedCommissions[0]?.total || 0);
    koutye.updateTier();
    await koutye.save();

    res.json({
      success: true,
      data: {
        koutyeCode: koutye.koutyeCode,
        referralLink: `haitibiznis.com?ref=${koutye.koutyeCode}`,
        tier: koutye.tier,
        status: koutye.status,
        stats: {
          totalReferrals: koutye.stats.totalReferrals,
          activeReferrals,
          totalEarnings: koutye.stats.totalEarnings,
          pendingEarnings: koutye.stats.pendingEarnings,
          paidEarnings: koutye.stats.paidEarnings,
          availableForPayout: (approvedCommissions[0]?.total || 0) - (pendingPayouts[0]?.total || 0)
        },
        platformStats: platformStats.reduce((acc, s) => {
          acc[s._id] = { total: s.total, count: s.count };
          return acc;
        }, {}),
        recentCommissions: recentCommissions.map(c => ({
          id: c._id,
          platform: c.platform,
          amount: c.amount,
          status: c.status,
          description: c.description,
          date: c.createdAt,
          referralName: c.referral?.referredEntity?.name
        })),
        payoutMethod: koutye.payoutMethod,
        lastPayoutDate: koutye.lastPayoutDate
      }
    });
  } catch (err) {
    console.error('Koutye dashboard error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/koutye/referrals - List all referrals
router.get('/referrals', protect, async (req, res) => {
  try {
    const koutye = await Koutye.findOne({ user: req.user._id });
    if (!koutye) {
      return res.status(404).json({ success: false, message: 'Koutye profile not found' });
    }

    const { platform, status, page = 1, limit = 20 } = req.query;
    const query = { koutye: koutye._id };
    if (platform) query.platform = platform;
    if (status) query.status = status;

    const total = await KoutyeReferral.countDocuments(query);
    const referrals = await KoutyeReferral.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit));

    const now = new Date();
    const enriched = referrals.map(r => ({
      id: r._id,
      platform: r.platform,
      referredEntity: {
        type: r.referredEntity.type,
        name: r.referredEntity.name
      },
      status: r.expiryDate < now && r.status === 'active' ? 'expired' : r.status,
      commissionRate: r.commissionRate,
      totalCommissionEarned: r.totalCommissionEarned,
      commissionCount: r.commissionCount,
      startDate: r.startDate,
      expiryDate: r.expiryDate,
      daysRemaining: Math.max(0, Math.ceil((r.expiryDate - now) / (1000 * 60 * 60 * 24))),
      lastCommissionDate: r.lastCommissionDate
    }));

    res.json({
      success: true,
      data: enriched,
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('Koutye referrals error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/koutye/referrals/track - Record a new referral
router.post('/referrals/track', async (req, res) => {
  try {
    const { koutyeCode, platform, entityType, entityName, entityPhone, entityEmail, userId } = req.body;

    if (!koutyeCode || !platform) {
      return res.status(400).json({ success: false, message: 'koutyeCode and platform required' });
    }

    const koutye = await Koutye.findOne({ koutyeCode, status: 'active' });
    if (!koutye) {
      return res.status(404).json({ success: false, message: 'Invalid or inactive Koutye code' });
    }

    if (!COMMISSION_RATES[platform]) {
      return res.status(400).json({ success: false, message: 'Invalid platform' });
    }

    if (userId) {
      const existingRef = await KoutyeReferral.findOne({
        koutye: koutye._id,
        'referredEntity.userId': userId,
        platform
      });
      if (existingRef) {
        return res.status(400).json({ success: false, message: 'Referral already exists for this user on this platform' });
      }
    }

    const rate = COMMISSION_RATES[platform];
    const startDate = new Date();
    const expiryDate = new Date(startDate);
    expiryDate.setDate(expiryDate.getDate() + COMMISSION_WINDOW_DAYS);

    const referral = await KoutyeReferral.create({
      koutye: koutye._id,
      koutyeCode,
      platform,
      referredEntity: {
        type: entityType || 'customer',
        name: entityName,
        phone: entityPhone,
        email: entityEmail,
        userId: userId || undefined
      },
      commissionRate: rate.rate,
      commissionType: rate.type,
      startDate,
      expiryDate,
      sourceDescription: rate.label
    });

    koutye.stats.totalReferrals += 1;
    koutye.stats.activeReferrals += 1;
    const pb = koutye.platformBreakdown[platform];
    if (pb) pb.referrals += 1;
    koutye.updateTier();
    await koutye.save();

    res.status(201).json({
      success: true,
      data: {
        referralId: referral._id,
        platform,
        commissionRate: rate.rate,
        commissionType: rate.type,
        expiryDate,
        daysValid: COMMISSION_WINDOW_DAYS
      }
    });
  } catch (err) {
    console.error('Koutye referral track error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/koutye/commissions/record - Record a commission from a transaction
router.post('/commissions/record', async (req, res) => {
  try {
    const { referralId, sourceAmount, description, sourceTransaction } = req.body;

    if (!referralId || !sourceAmount) {
      return res.status(400).json({ success: false, message: 'referralId and sourceAmount required' });
    }

    const referral = await KoutyeReferral.findById(referralId);
    if (!referral) {
      return res.status(404).json({ success: false, message: 'Referral not found' });
    }

    if (referral.isExpired()) {
      referral.status = 'expired';
      await referral.save();
      return res.status(400).json({ success: false, message: 'Referral expired (12-month window passed)' });
    }

    if (referral.status !== 'active') {
      return res.status(400).json({ success: false, message: 'Referral is not active' });
    }

    const commissionAmount = Math.round(sourceAmount * referral.commissionRate);
    if (commissionAmount <= 0) {
      return res.status(400).json({ success: false, message: 'Commission amount too small' });
    }

    const commission = await KoutyeCommission.create({
      koutye: referral.koutye,
      referral: referral._id,
      platform: referral.platform,
      sourceAmount,
      commissionRate: referral.commissionRate,
      amount: commissionAmount,
      description: description || `Commission from ${referral.platform}`,
      sourceTransaction,
      status: 'pending'
    });

    referral.totalCommissionEarned += commissionAmount;
    referral.commissionCount += 1;
    referral.lastCommissionDate = new Date();
    await referral.save();

    const koutye = await Koutye.findById(referral.koutye);
    if (koutye) {
      koutye.stats.totalEarnings += commissionAmount;
      koutye.stats.pendingEarnings += commissionAmount;
      const pb = koutye.platformBreakdown[referral.platform];
      if (pb) pb.earnings += commissionAmount;
      koutye.updateTier();
      await koutye.save();
    }

    res.status(201).json({
      success: true,
      data: {
        commissionId: commission._id,
        amount: commissionAmount,
        platform: referral.platform,
        status: 'pending'
      }
    });
  } catch (err) {
    console.error('Koutye commission record error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/koutye/commissions/:id/approve - Admin approve commission
router.put('/commissions/:id/approve', protect, authorize('admin'), async (req, res) => {
  try {
    const commission = await KoutyeCommission.findById(req.params.id);
    if (!commission) {
      return res.status(404).json({ success: false, message: 'Commission not found' });
    }
    if (commission.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Commission already ${commission.status}` });
    }

    commission.status = 'approved';
    commission.approvedAt = new Date();
    await commission.save();

    res.json({ success: true, data: { id: commission._id, status: 'approved' } });
  } catch (err) {
    console.error('Commission approve error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/koutye/commissions/:id/reject - Admin reject commission
router.put('/commissions/:id/reject', protect, authorize('admin'), async (req, res) => {
  try {
    const commission = await KoutyeCommission.findById(req.params.id);
    if (!commission) {
      return res.status(404).json({ success: false, message: 'Commission not found' });
    }

    const koutye = await Koutye.findById(commission.koutye);
    if (koutye) {
      koutye.stats.totalEarnings -= commission.amount;
      koutye.stats.pendingEarnings -= commission.amount;
      const pb = koutye.platformBreakdown[commission.platform];
      if (pb) pb.earnings -= commission.amount;
      await koutye.save();
    }

    commission.status = 'rejected';
    commission.rejectionReason = req.body.reason || 'Rejected by admin';
    await commission.save();

    res.json({ success: true, data: { id: commission._id, status: 'rejected' } });
  } catch (err) {
    console.error('Commission reject error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/koutye/commissions - Commission history for a Koutye
router.get('/commissions', protect, async (req, res) => {
  try {
    const koutye = await Koutye.findOne({ user: req.user._id });
    if (!koutye) {
      return res.status(404).json({ success: false, message: 'Koutye profile not found' });
    }

    const { platform, status, page = 1, limit = 20 } = req.query;
    const query = { koutye: koutye._id };
    if (platform) query.platform = platform;
    if (status) query.status = status;

    const total = await KoutyeCommission.countDocuments(query);
    const commissions = await KoutyeCommission.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('referral', 'platform referredEntity.name');

    res.json({
      success: true,
      data: commissions.map(c => ({
        id: c._id,
        platform: c.platform,
        sourceAmount: c.sourceAmount,
        commissionRate: c.commissionRate,
        amount: c.amount,
        status: c.status,
        description: c.description,
        date: c.createdAt,
        referralName: c.referral?.referredEntity?.name
      })),
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('Koutye commissions error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/koutye/wallet - Koutye wallet balances
router.get('/wallet', protect, async (req, res) => {
  try {
    const koutye = await Koutye.findOne({ user: req.user._id });
    if (!koutye) {
      return res.status(404).json({ success: false, message: 'Koutye profile not found' });
    }

    let wallet = await KoutyeWallet.findOne({ koutye: koutye._id });
    if (!wallet) {
      wallet = await KoutyeWallet.create({ koutye: koutye._id });
    }

    const pendingComm = await KoutyeCommission.aggregate([
      { $match: { koutye: koutye._id, status: 'pending' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const validatedComm = await KoutyeCommission.aggregate([
      { $match: { koutye: koutye._id, status: { $in: ['validated', 'approved'] } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const paidComm = await KoutyeCommission.aggregate([
      { $match: { koutye: koutye._id, status: 'paid' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const paidThisMonth = await KoutyeCommission.aggregate([
      { $match: { koutye: koutye._id, status: 'paid', paidAt: { $gte: monthStart } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    const pendingPayouts = await KoutyePayout.aggregate([
      { $match: { koutye: koutye._id, status: { $in: ['pending', 'approved'] } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    const available = (validatedComm[0]?.total || 0) - (pendingPayouts[0]?.total || 0);

    wallet.available_balance = Math.max(0, available);
    wallet.pending_balance = pendingComm[0]?.total || 0;
    wallet.paid_balance = paidComm[0]?.total || 0;
    wallet.lifetime_earnings = (pendingComm[0]?.total || 0) + (validatedComm[0]?.total || 0) + (paidComm[0]?.total || 0);
    await wallet.save();

    res.json({
      success: true,
      data: {
        available_balance: wallet.available_balance,
        pending_balance: wallet.pending_balance,
        paid_balance: wallet.paid_balance,
        paid_this_month: paidThisMonth[0]?.total || 0,
        lifetime_earnings: wallet.lifetime_earnings,
        currency: wallet.currency
      }
    });
  } catch (err) {
    console.error('Koutye wallet error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/koutye/payout/request - Request a payout
router.post('/payout/request', protect, async (req, res) => {
  try {
    const koutye = await Koutye.findOne({ user: req.user._id });
    if (!koutye) {
      return res.status(404).json({ success: false, message: 'Koutye profile not found' });
    }
    if (koutye.status !== 'active') {
      return res.status(400).json({ success: false, message: 'Koutye account is not active' });
    }

    const validatedTotal = await KoutyeCommission.aggregate([
      { $match: { koutye: koutye._id, status: { $in: ['validated', 'approved'] } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const available = validatedTotal[0]?.total || 0;

    const pendingPayouts = await KoutyePayout.aggregate([
      { $match: { koutye: koutye._id, status: { $in: ['pending', 'approved'] } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    const pendingTotal = pendingPayouts[0]?.total || 0;
    const withdrawable = available - pendingTotal;

    const { amount, method, destinationAccount, notes } = req.body;
    const requestAmount = amount || withdrawable;

    if (requestAmount < MIN_PAYOUT_HTG) {
      return res.status(400).json({
        success: false,
        message: `Minimum payout: ${MIN_PAYOUT_HTG} HTG. Disponib: ${withdrawable} HTG`
      });
    }
    if (requestAmount > withdrawable) {
      return res.status(400).json({
        success: false,
        message: `Balans disponib: ${withdrawable} HTG`
      });
    }

    const payoutMethod = method || koutye.payoutMethod;
    const payout = await KoutyePayout.create({
      koutye: koutye._id,
      amount: requestAmount,
      method: payoutMethod,
      destinationAccount: destinationAccount || koutye.payoutDetails?.phone,
      details: koutye.payoutDetails,
      adminNote: notes
    });

    res.status(201).json({
      success: true,
      data: {
        payoutId: payout._id,
        amount: requestAmount,
        method: payoutMethod,
        status: 'pending',
        message: 'Payout request submitted. Processing: 24-48h.'
      }
    });
  } catch (err) {
    console.error('Koutye payout request error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/koutye/payout/history - Payout history (payouts list)
router.get('/payout/history', protect, async (req, res) => {
  try {
    const koutye = await Koutye.findOne({ user: req.user._id });
    if (!koutye) {
      return res.status(404).json({ success: false, message: 'Koutye profile not found' });
    }

    const payouts = await KoutyePayout.find({ koutye: koutye._id })
      .sort({ createdAt: -1 })
      .limit(50);

    res.json({
      success: true,
      data: payouts.map(p => ({
        id: p._id,
        amount: p.amount,
        method: p.method,
        status: p.status,
        destinationAccount: p.destinationAccount,
        requestDate: p.requestedAt || p.createdAt,
        approvedAt: p.approvedAt,
        paidAt: p.paidAt,
        rejectedAt: p.rejectedAt,
        reference: p.providerReference || p.reference,
        rejectionReason: p.rejectionReason,
        adminNote: p.adminNote
      }))
    });
  } catch (err) {
    console.error('Payout history error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH /api/koutye/admin/payouts/:id/approve - Admin approve payout
router.patch('/admin/payouts/:id/approve', protect, authorize('admin'), async (req, res) => {
  try {
    const payout = await KoutyePayout.findById(req.params.id);
    if (!payout) {
      return res.status(404).json({ success: false, message: 'Payout not found' });
    }
    if (payout.status !== 'pending') {
      return res.status(400).json({ success: false, message: `Cannot approve payout with status: ${payout.status}` });
    }

    payout.status = 'approved';
    payout.approvedAt = new Date();
    payout.approvedBy = req.user._id;
    if (req.body.adminNote) payout.adminNote = req.body.adminNote;
    await payout.save();

    res.json({ success: true, data: { id: payout._id, status: 'approved' } });
  } catch (err) {
    console.error('Payout approve error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH /api/koutye/admin/payouts/:id/reject - Admin reject payout
router.patch('/admin/payouts/:id/reject', protect, authorize('admin'), async (req, res) => {
  try {
    const payout = await KoutyePayout.findById(req.params.id);
    if (!payout) {
      return res.status(404).json({ success: false, message: 'Payout not found' });
    }
    if (!['pending', 'approved'].includes(payout.status)) {
      return res.status(400).json({ success: false, message: `Cannot reject payout with status: ${payout.status}` });
    }

    payout.status = 'rejected';
    payout.rejectedAt = new Date();
    payout.rejectionReason = req.body.reason || 'Rejected by admin';
    payout.processedBy = req.user._id;
    if (req.body.adminNote) payout.adminNote = req.body.adminNote;
    await payout.save();

    res.json({ success: true, data: { id: payout._id, status: 'rejected' } });
  } catch (err) {
    console.error('Payout reject error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH /api/koutye/admin/payouts/:id/mark-paid - Admin mark payout as paid
router.patch('/admin/payouts/:id/mark-paid', protect, authorize('admin'), async (req, res) => {
  try {
    const payout = await KoutyePayout.findById(req.params.id);
    if (!payout) {
      return res.status(404).json({ success: false, message: 'Payout not found' });
    }
    if (!['pending', 'approved'].includes(payout.status)) {
      return res.status(400).json({ success: false, message: `Cannot mark-paid payout with status: ${payout.status}` });
    }

    const commissions = await KoutyeCommission.find({
      koutye: payout.koutye,
      status: { $in: ['validated', 'approved'] }
    }).sort({ createdAt: 1 });

    let remaining = payout.amount;
    for (const c of commissions) {
      if (remaining <= 0) break;
      c.status = 'paid';
      c.paidAt = new Date();
      remaining -= c.amount;
      await c.save();
    }

    payout.status = 'paid';
    payout.paidAt = new Date();
    payout.processedBy = req.user._id;
    payout.providerReference = req.body.reference || req.body.providerReference;
    if (req.body.adminNote) payout.adminNote = req.body.adminNote;
    if (!payout.approvedAt) {
      payout.approvedAt = new Date();
      payout.approvedBy = req.user._id;
    }
    await payout.save();

    const koutye = await Koutye.findById(payout.koutye);
    if (koutye) {
      koutye.stats.paidEarnings += payout.amount;
      koutye.stats.pendingEarnings = Math.max(0, koutye.stats.pendingEarnings - payout.amount);
      koutye.stats.totalPayouts += 1;
      koutye.lastPayoutDate = new Date();
      await koutye.save();
    }

    res.json({
      success: true,
      data: {
        id: payout._id,
        status: 'paid',
        paidAt: payout.paidAt,
        reference: payout.providerReference
      }
    });
  } catch (err) {
    console.error('Payout mark-paid error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/koutye/settings - Update Koutye settings
router.put('/settings', protect, async (req, res) => {
  try {
    const koutye = await Koutye.findOne({ user: req.user._id });
    if (!koutye) {
      return res.status(404).json({ success: false, message: 'Koutye profile not found' });
    }

    const { whatsapp, bio, payoutMethod, payoutDetails } = req.body;
    if (whatsapp) koutye.whatsapp = whatsapp;
    if (bio !== undefined) koutye.bio = bio;
    if (payoutMethod) koutye.payoutMethod = payoutMethod;
    if (payoutDetails) koutye.payoutDetails = { ...koutye.payoutDetails, ...payoutDetails };
    await koutye.save();

    res.json({
      success: true,
      data: {
        whatsapp: koutye.whatsapp,
        bio: koutye.bio,
        payoutMethod: koutye.payoutMethod,
        payoutDetails: koutye.payoutDetails
      }
    });
  } catch (err) {
    console.error('Koutye settings error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/koutye/validate/:code - Validate a Koutye code (public)
router.get('/validate/:code', async (req, res) => {
  try {
    const koutye = await Koutye.findOne({
      koutyeCode: req.params.code.toUpperCase(),
      status: 'active'
    }).populate('user', 'name');

    if (!koutye) {
      return res.json({ success: true, valid: false });
    }

    res.json({
      success: true,
      valid: true,
      data: {
        koutyeCode: koutye.koutyeCode,
        name: koutye.user?.name,
        tier: koutye.tier
      }
    });
  } catch (err) {
    console.error('Koutye validate error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/koutye/link - Get referral link
router.get('/link', protect, async (req, res) => {
  try {
    const koutye = await Koutye.findOne({ user: req.user._id });
    if (!koutye) {
      return res.status(404).json({ success: false, message: 'Koutye profile not found' });
    }

    res.json({
      success: true,
      data: {
        koutyeCode: koutye.koutyeCode,
        links: {
          general: `haitibiznis.com?ref=${koutye.koutyeCode}`,
          '48hoursready': `48hoursready.com?ref=${koutye.koutyeCode}`,
          msouwout: `msouwout.com?ref=${koutye.koutyeCode}`,
          myplopplop: `myplopplop.com?ref=${koutye.koutyeCode}`,
        }
      }
    });
  } catch (err) {
    console.error('Koutye link error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/koutye/expire-check - Cron job to expire old referrals
router.post('/expire-check', async (req, res) => {
  try {
    const now = new Date();
    const expired = await KoutyeReferral.updateMany(
      { status: 'active', expiryDate: { $lt: now } },
      { $set: { status: 'expired' } }
    );

    res.json({
      success: true,
      data: { expiredCount: expired.modifiedCount }
    });
  } catch (err) {
    console.error('Expire check error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/koutye/admin/overview - Admin dashboard for Koutye program
router.get('/admin/overview', protect, authorize('admin'), async (req, res) => {
  try {
    const totalKoutyes = await Koutye.countDocuments();
    const activeKoutyes = await Koutye.countDocuments({ status: 'active' });
    const totalReferrals = await KoutyeReferral.countDocuments();
    const activeReferrals = await KoutyeReferral.countDocuments({
      status: 'active',
      expiryDate: { $gt: new Date() }
    });

    const totalCommissions = await KoutyeCommission.aggregate([
      { $match: { status: { $in: ['pending', 'approved', 'paid'] } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    const pendingPayouts = await KoutyePayout.aggregate([
      { $match: { status: { $in: ['pending', 'processing'] } } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);

    const platformBreakdown = await KoutyeCommission.aggregate([
      { $match: { status: { $in: ['pending', 'approved', 'paid'] } } },
      { $group: { _id: '$platform', total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);

    const topKoutyes = await Koutye.find({ status: 'active' })
      .sort({ 'stats.totalEarnings': -1 })
      .limit(10)
      .populate('user', 'name phone');

    const tierDistribution = await Koutye.aggregate([
      { $group: { _id: '$tier', count: { $sum: 1 } } }
    ]);

    res.json({
      success: true,
      data: {
        summary: {
          totalKoutyes,
          activeKoutyes,
          totalReferrals,
          activeReferrals,
          totalCommissionsPaid: totalCommissions[0]?.total || 0,
          pendingPayoutsAmount: pendingPayouts[0]?.total || 0,
          pendingPayoutsCount: pendingPayouts[0]?.count || 0
        },
        platformBreakdown: platformBreakdown.reduce((acc, p) => {
          acc[p._id] = { total: p.total, count: p.count };
          return acc;
        }, {}),
        topKoutyes: topKoutyes.map(k => ({
          koutyeCode: k.koutyeCode,
          name: k.user?.name,
          phone: k.user?.phone,
          tier: k.tier,
          totalReferrals: k.stats.totalReferrals,
          totalEarnings: k.stats.totalEarnings
        })),
        tierDistribution: tierDistribution.reduce((acc, t) => {
          acc[t._id] = t.count;
          return acc;
        }, {})
      }
    });
  } catch (err) {
    console.error('Koutye admin overview error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/koutye/admin/koutyes - List all Koutyes (admin)
router.get('/admin/koutyes', protect, authorize('admin'), async (req, res) => {
  try {
    const { status, tier, page = 1, limit = 20 } = req.query;
    const query = {};
    if (status) query.status = status;
    if (tier) query.tier = tier;

    const total = await Koutye.countDocuments(query);
    const koutyes = await Koutye.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate('user', 'name phone email');

    res.json({
      success: true,
      data: koutyes.map(k => ({
        id: k._id,
        koutyeCode: k.koutyeCode,
        name: k.user?.name,
        phone: k.user?.phone,
        tier: k.tier,
        status: k.status,
        stats: k.stats,
        payoutMethod: k.payoutMethod,
        joinedAt: k.createdAt
      })),
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('Admin koutyes list error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/koutye/admin/:id/suspend - Suspend a Koutye
router.put('/admin/:id/suspend', protect, authorize('admin'), async (req, res) => {
  try {
    const koutye = await Koutye.findById(req.params.id);
    if (!koutye) {
      return res.status(404).json({ success: false, message: 'Koutye not found' });
    }

    koutye.status = 'suspended';
    koutye.suspendedReason = req.body.reason || 'Suspended by admin';
    koutye.suspendedAt = new Date();
    await koutye.save();

    res.json({ success: true, data: { id: koutye._id, status: 'suspended' } });
  } catch (err) {
    console.error('Koutye suspend error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PUT /api/koutye/admin/:id/activate - Reactivate a Koutye
router.put('/admin/:id/activate', protect, authorize('admin'), async (req, res) => {
  try {
    const koutye = await Koutye.findById(req.params.id);
    if (!koutye) {
      return res.status(404).json({ success: false, message: 'Koutye not found' });
    }

    koutye.status = 'active';
    koutye.suspendedReason = undefined;
    koutye.suspendedAt = undefined;
    await koutye.save();

    res.json({ success: true, data: { id: koutye._id, status: 'active' } });
  } catch (err) {
    console.error('Koutye activate error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/koutye/admin/payouts - All pending payouts (admin)
router.get('/admin/payouts', protect, authorize('admin'), async (req, res) => {
  try {
    const { status = 'pending', page = 1, limit = 20 } = req.query;
    const query = {};
    if (status !== 'all') query.status = status;

    const total = await KoutyePayout.countDocuments(query);
    const payouts = await KoutyePayout.find(query)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .populate({
        path: 'koutye',
        populate: { path: 'user', select: 'name phone' }
      });

    res.json({
      success: true,
      data: payouts.map(p => ({
        id: p._id,
        amount: p.amount,
        method: p.method,
        details: p.details,
        status: p.status,
        koutyeCode: p.koutye?.koutyeCode,
        koutyeName: p.koutye?.user?.name,
        koutyePhone: p.koutye?.user?.phone,
        requestDate: p.createdAt,
        processedAt: p.processedAt
      })),
      pagination: {
        total,
        page: parseInt(page),
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('Admin payouts error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
