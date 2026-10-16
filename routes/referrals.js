const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const referralService = require('../services/referral');

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

    // Apply referral with timestamp for 3-month platform fee window
    user.referredBy = referrer._id;
    user.referredAt = new Date();
    await user.save();

    // Increment referrer's count
    referrer.referralCount = (referrer.referralCount || 0) + 1;
    await referrer.save();

    res.json({
      success: true,
      message: 'Referral code applied! ' + referrer.name + ' earns 10% on 48HR packages + 10% platform fees (first 3 months).',
      referrerName: referrer.name
    });
  } catch (error) {
    console.error('Apply referral error:', error);
    res.status(500).json({ success: false, message: 'Failed to apply referral code' });
  }
});

// ─── Validate referral code (check if it exists) ───
/* 🚨🚨 12 Oct 2026 — THIS REJECTED ALL 19 REAL AGENTS.
 *
 * There are TWO referral-code systems in this service:
 *   1. the Koutye engine - `koutyes.koutyeCode`, 19 active agents, the 12-month
 *      window, the commission ledger, the wallets. The real one.
 *   2. an older field on the user record - `users.referralCode`. Three users
 *      have one. None of them is an agent.
 *
 * This endpoint read (2). So asking it about @FREY25 - a live, active agent -
 * answered "Invalid referral code". Every one of the 19 failed.
 *
 * Nothing on the website called it yet, so it was blocking nobody; but it is
 * the obvious call for a QR landing page to make ("is this code real?"), and
 * Jeffery has 12 more agents starting. It would have told every one of them
 * their code was invalid.
 *
 * 🔑 Same shape as the acRank bug in MsouWout the day before: the right answer
 *    computed in one place, and a second place that does not know about it.
 *
 * ⛔ The Koutye engine is now the authority. The old user field is still
 *    accepted as a fallback so the three existing codes do not break, but it
 *    is checked SECOND and the response says which kind was matched.
 */
const Koutye = require('../models/Koutye');

// GET /api/referrals/validate/:code
router.get('/validate/:code', async (req, res) => {
  try {
    const raw = String(req.params.code || '').trim();
    if (!raw) {
      return res.status(404).json({ success: false, message: 'Invalid referral code' });
    }

    /* Agents write their code on paper and into cracked phones. Match the way
       attachReferral() does - case-insensitively, with the regex characters
       escaped - or validate and attach would disagree about the same code,
       which is the fault this is fixing. */
    const esc = raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const koutye = await Koutye.findOne({ koutyeCode: new RegExp('^' + esc + '$', 'i') })
      .populate('user', 'name');

    if (koutye) {
      /* ⛔ An inactive agent is a REAL code that must not be used. Saying
         "invalid" would send somebody hunting for a typo that is not there. */
      if (koutye.status !== 'active') {
        return res.status(409).json({
          success: false, kind: 'koutye', active: false,
          message: 'This agent code is not active at the moment.'
        });
      }
      return res.json({
        success: true, kind: 'koutye',
        code: koutye.koutyeCode,
        referrerName: (koutye.user && koutye.user.name) || null,
        /* Enterprise partner the agent recruits for ('' = independent). Lets a
           signup form on another service record BOTH the agent and the
           organisation without a second lookup. */
        organization: koutye.organization || ''
      });
    }

    const referrer = await User.findOne({ referralCode: raw.toUpperCase() }).select('name');
    if (referrer) {
      return res.json({ success: true, kind: 'user', referrerName: referrer.name });
    }

    return res.status(404).json({ success: false, message: 'Invalid referral code' });
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


/* ═══ TIKE LAKAY -> THE COMMISSION ENGINE ═══════════════════════════════════
   Tickets live in haitibiznis-backend and the agent engine lives here: two
   services, two databases, so one has to call the other. This is that door,
   and it is deliberately the only one.

   🔑 Called ONCE PER TICKET, when the ticket is confirmed PAID - never when
   the order is merely created. An unpaid ticket must never earn anybody
   anything.

   ⛔ NOT a public endpoint. It writes money into the agent ledger, and the
   agent codes are printed on flyers, so anybody who could post here could mint
   commissions. It is locked to a shared key that only the two servers hold.
   If the key is not configured the door is CLOSED, not open - a missing
   setting must never become an open till.                                     */
router.post('/ticket-sale', async (req, res) => {
  const expected = process.env.INTERNAL_SERVICE_KEY;
  if (!expected) {
    console.warn('[TIKELAKAY] refused: INTERNAL_SERVICE_KEY is not configured');
    return res.status(503).json({ success: false, message: 'Service link not configured' });
  }
  const given = req.get('x-internal-key') || '';
  /* Compared in constant time so the key cannot be guessed a character at a
     time by measuring how long the answer takes. */
  const crypto = require('crypto');
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  try {
    const { koutyeCode, phone, name, email, amount, transactionId, description } = req.body || {};
    const out = await referralService.commissionForTicketSale({
      koutyeCode, phone, name, email,
      amount: amount,
      transactionId: transactionId,
      serviceType: 'ticket',
      description: description || 'Tike Lakay ticket'
    });
    /* Always 200. The caller is a ticket that has already been paid for; it
       must log what happened and carry on, never retry in a loop or fail the
       buyer's confirmation because an agent code was mistyped. */
    res.json({ success: true, result: out });
  } catch (err) {
    console.error('[TIKELAKAY] ticket-sale failed:', err.message);
    res.json({ success: true, result: { commissioned: false, reason: 'error' } });
  }
});

/* ═══ OTHER SERVICES -> "THIS PERSON WAS RECRUITED BY THIS AGENT" ═══════════
   15 Oct 2026. MsouWout keeps its drivers in its own database, so until now a
   driver recruited by an Ajan was recorded nowhere the agent engine could see:
   the Ajan's dashboard showed nothing and no organisation could count them.

   Same lock as /ticket-sale above: only the two servers hold the key, and a
   missing key means the door is CLOSED. ⛔ Never make this public - agent
   codes are printed on flyers, and anybody who could post here could pin
   other people's phone numbers to an agent and take them under first-agent-
   wins.

   Records the attribution ONLY. No money is written here; commissions are
   earned later on paid activity, through the existing payment paths.      */
function internalKeyOk(req) {
  const expected = process.env.INTERNAL_SERVICE_KEY;
  if (!expected) return null;               // not configured -> closed
  const crypto = require('crypto');
  const a = Buffer.from(String(req.get('x-internal-key') || ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const ATTACH_PLATFORMS = ['msouwout', 'myplopplop', 'tikelakay', '48hoursready', 'prolakay'];
const ATTACH_TYPES = ['driver', 'customer', 'merchant', 'business', 'professional'];

router.post('/attach', async (req, res) => {
  const ok = internalKeyOk(req);
  if (ok === null) return res.status(503).json({ success: false, message: 'Service link not configured' });
  if (!ok) return res.status(401).json({ success: false, message: 'Unauthorized' });

  const b = req.body || {};
  const platform = String(b.platform || '');
  const entityType = String(b.entityType || '');
  if (ATTACH_PLATFORMS.indexOf(platform) < 0) return res.status(400).json({ success: false, message: 'bad platform' });
  if (ATTACH_TYPES.indexOf(entityType) < 0) return res.status(400).json({ success: false, message: 'bad entityType' });

  /* attachReferral never throws and enforces every rule already: unknown or
     inactive agent, self-referral, first-agent-wins by phone. */
  const out = await referralService.attachReferral({
    code: b.code, platform, entityType,
    name: String(b.name || '').slice(0, 120),
    phone: String(b.phone || '').slice(0, 40),
    source: String(b.source || '').slice(0, 120) || undefined
  });
  const r = out.referral;
  res.json({
    success: true,
    attached: !!out.attached,
    reason: out.reason,
    /* Whoever the person belongs to now - which, under first-agent-wins, may
       be an EARLIER agent than the one whose code came with this signup. */
    koutyeCode: r ? r.koutyeCode : null,
    organization: r ? (r.organization || '') : null
  });
});

/* ═══ MSOUWOUT -> "THIS RIDE IS COMPLETED AND PAID" (15 Oct 2026) ══════════
   Same lock as /attach and /ticket-sale: only the servers hold the key, and a
   missing key means CLOSED. MsouWout decides eligibility (completed, paid,
   approved driver, not a test ride); this pays the driver's Ajan 3% of the
   fare once per ride. Always 200 with the outcome - the caller records it and
   retries only on a transport failure. */
router.post('/ride-commission', async (req, res) => {
  const ok = internalKeyOk(req);
  if (ok === null) return res.status(503).json({ success: false, message: 'Service link not configured' });
  if (!ok) return res.status(401).json({ success: false, message: 'Unauthorized' });
  try {
    const b = req.body || {};
    const out = await referralService.rideCommission({
      driverPhone: b.driverPhone, passengerPhone: b.passengerPhone,
      fare: b.fare, rideRef: b.rideRef
    });
    res.json({ success: true, result: out });
  } catch (err) {
    console.error('[MSOUWOUT] ride-commission failed:', err.message);
    res.json({ success: true, result: { commissioned: false, reason: 'error' } });
  }
});

/* ═══ ANY PLATFORM -> "THAT SALE WAS CANCELLED / REFUNDED" (15 Oct 2026) ════
   Takes back every unpaid commission line for the transaction. Locked the same
   way: anyone who could call it could wipe out an Ajan's earnings. */
router.post('/reverse', async (req, res) => {
  const ok = internalKeyOk(req);
  if (ok === null) return res.status(503).json({ success: false, message: 'Service link not configured' });
  if (!ok) return res.status(401).json({ success: false, message: 'Unauthorized' });
  try {
    const b = req.body || {};
    if (!b.transactionId) return res.status(400).json({ success: false, message: 'transactionId required' });
    const out = await referralService.reverseCommission({ transactionId: b.transactionId, reason: b.reason });
    res.json({ success: true, result: out });
  } catch (err) {
    console.error('[REVERSE] failed:', err.message);
    res.status(500).json({ success: false, message: 'Reverse failed' });
  }
});

module.exports = router;
