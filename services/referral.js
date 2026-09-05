// One place where a LajanMaker agent code becomes a referral that pays.
//
// The agent engine was complete on this side: a 12-month window, a commission
// ledger, payouts, tiers, an agent dashboard - all sitting behind
// POST /api/koutye/referrals/track. Nothing on any site ever called it. So an
// agent could hand out his code all week, a shop could sign up with it in the
// address bar, and the platform wrote down nothing: no record that the agent
// brought them, and no commission, ever.
//
// Every registration path now calls attachReferral() rather than inventing its
// own handling, so there is exactly ONE definition of what a referral is and
// ONE place the 12-month window is decided.
//
// Rules that live here, so no caller can get them wrong:
//   - first agent wins. A person is referred once per platform, by whoever got
//     there first, no matter how many other codes they arrive with later.
//   - an agent cannot refer himself.
//   - a suspended or unknown code attaches nothing, and is NOT an error the
//     caller has to handle: a registration must never fail because a referral
//     code was mistyped.

const Koutye = require('../models/Koutye');
const KoutyeReferral = require('../models/KoutyeReferral');

// 12 months, then it expires unless renewed. Changing this number changes the
// window for every platform and every future referral - the ones already
// written down keep the expiry date they were given.
const REFERRAL_WINDOW_DAYS = 365;

const COMMISSION_RATES = {
  '48hoursready': { rate: 0.10, type: 'percentage', label: '10% on packages' },
  'msouwout':     { rate: 0.10, type: 'percentage', label: 'Recurring up to 12 months' },
  'myplopplop':   { rate: 0.10, type: 'percentage', label: 'Recurring up to 12 months' },
  'utility':      { rate: 0.05, type: 'per_transaction', label: 'Per transaction' },
  'sol':          { rate: 0.03, type: 'per_activity', label: 'Per group/activity' },
  'prolakay':     { rate: 0.10, type: 'percentage', label: 'Per referral' }
};

// Agents write their code on paper, on a wall, into a phone with a cracked
// screen. Accept it however it arrives; compare it the way it is stored.
function normalizeCode(code) {
  if (!code) return '';
  return String(code).trim().toUpperCase().replace(/\s+/g, '');
}

/* Attach a referral to somebody who just registered.

   Returns { attached, reason, referral } and NEVER throws: a registration is
   the thing that matters, and it must complete whether or not the code was
   any good. Callers log the reason and carry on.

   reason is one of:
     no_code | unknown_code | inactive_agent | self_referral |
     already_referred | bad_platform | error | ok                          */
async function attachReferral(opts) {
  const o = opts || {};
  const code = normalizeCode(o.code);
  const platform = o.platform || 'myplopplop';

  if (!code) return { attached: false, reason: 'no_code' };
  if (!COMMISSION_RATES[platform]) return { attached: false, reason: 'bad_platform' };

  try {
    // Stored codes are upper-case ('KB-ABC12'), but a code typed into a phone
    // arrives in any case at all, so match without regard to it.
    const koutye = await Koutye.findOne({
      koutyeCode: new RegExp('^' + code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i')
    });
    if (!koutye) return { attached: false, reason: 'unknown_code' };
    if (koutye.status !== 'active') return { attached: false, reason: 'inactive_agent' };

    if (o.user && String(koutye.user) === String(o.user)) {
      return { attached: false, reason: 'self_referral' };
    }

    // First agent wins. Deliberately NOT scoped to this agent: the old check
    // asked "has THIS agent already referred them", which let a second agent
    // claim the same shop and be paid for it too.
    if (o.user) {
      const already = await KoutyeReferral.findOne({
        'referredEntity.userId': o.user,
        platform: platform
      });
      if (already) {
        return { attached: false, reason: 'already_referred', referral: already };
      }
    }

    const rate = COMMISSION_RATES[platform];
    const startDate = new Date();
    const expiryDate = new Date(startDate);
    expiryDate.setDate(expiryDate.getDate() + REFERRAL_WINDOW_DAYS);

    const referral = await KoutyeReferral.create({
      koutye: koutye._id,
      koutyeCode: koutye.koutyeCode,
      platform: platform,
      referredEntity: {
        type: o.entityType || 'customer',
        name: o.name,
        phone: o.phone,
        email: o.email,
        userId: o.user || undefined
      },
      commissionRate: rate.rate,
      commissionType: rate.type,
      startDate: startDate,
      expiryDate: expiryDate,
      sourceDescription: o.source || rate.label
    });

    koutye.stats.totalReferrals = (koutye.stats.totalReferrals || 0) + 1;
    koutye.stats.activeReferrals = (koutye.stats.activeReferrals || 0) + 1;
    const pb = koutye.platformBreakdown && koutye.platformBreakdown[platform];
    if (pb) pb.referrals = (pb.referrals || 0) + 1;
    koutye.updateTier();
    await koutye.save();

    return { attached: true, reason: 'ok', referral: referral };
  } catch (err) {
    // A referral is a bonus on top of a registration. If writing it down fails,
    // say so in the log and let the person finish signing up.
    console.error('attachReferral failed for code ' + code + ':', err.message);
    return { attached: false, reason: 'error' };
  }
}

// Is this person currently earning their agent a commission? Used by the
// payment paths so nothing pays out on a referral that has run past 12 months.
async function activeReferralFor(userId, platform) {
  if (!userId) return null;
  const ref = await KoutyeReferral.findOne({
    'referredEntity.userId': userId,
    platform: platform || 'myplopplop',
    status: 'active'
  });
  if (!ref) return null;
  if (ref.isExpired()) {
    ref.status = 'expired';
    await ref.save().catch(function () {});
    return null;
  }
  return ref;
}

// What share of a transaction reaches the agent. The agent is paid a share of
// OUR platform fee, not of the whole sale, so the merchant and the driver are
// never paid less because a customer arrived on an agent's link.
const PLATFORM_FEES = {
  '48hoursready': { feeRate: 1.00, koutyeRate: 0.10, label: '10% of package price' },
  'msouwout':     { feeRate: 0.25, koutyeRate: 0.10, label: '10% of 25% platform fee' },
  'myplopplop':   { feeRate: 0.10, koutyeRate: 0.10, label: '10% of 10% platform fee' },
  'utility':      { feeRate: 0.05, koutyeRate: 0.10, label: '10% of 5% service fee' },
  'sol':          { feeRate: 0.02, koutyeRate: 0.10, label: '10% of 2% cycle fee' },
  'prolakay':     { feeRate: 0.15, koutyeRate: 0.10, label: '10% of 15% platform fee' }
};

/* Pay the agent who introduced THIS person, for something that person just did.

   The commission engine already existed, but the only way in was
   POST /api/koutye-payments/commission/trigger, which takes an agent CODE and
   then picks that agent's most recently created referral for the platform. So
   a sale by the customer an agent signed up in January was credited against
   whichever shop he happened to sign up last - the right agent, but the wrong
   referral, and therefore the wrong expiry date and the wrong figures on his
   own dashboard. Worse, nothing in the ordinary order or ride path ever called
   it at all, so in practice no commission was ever earned on either.

   This works the other way round and the right way round: start from the person
   who spent the money, find THEIR referral, and pay the agent attached to it -
   but only while that referral is inside its 12 months.

   Returns { commissioned, reason, amount } and never throws: a commission must
   not be able to fail somebody's order.                                       */
async function payCommissionForUser(userId, opts) {
  const o = opts || {};
  const platform = o.platform || 'myplopplop';
  const amount = Number(o.amount);

  if (!userId) return { commissioned: false, reason: 'no_user' };
  if (!isFinite(amount) || amount <= 0) return { commissioned: false, reason: 'no_amount' };

  const fees = PLATFORM_FEES[platform];
  if (!fees) return { commissioned: false, reason: 'bad_platform' };

  try {
    const referral = await activeReferralFor(userId, platform);
    if (!referral) return { commissioned: false, reason: 'no_active_referral' };

    const Koutye = require('../models/Koutye');
    const KoutyeCommission = require('../models/KoutyeCommission');

    const koutye = await Koutye.findById(referral.koutye);
    if (!koutye) return { commissioned: false, reason: 'agent_missing' };
    if (koutye.status !== 'active') return { commissioned: false, reason: 'agent_inactive' };

    // Never pay the same agent twice for the same order or the same ride. The
    // status pipeline can be re-driven (a retry, a double tap on "delivered"),
    // and each pass would otherwise mint a fresh commission out of nothing.
    if (o.transactionId) {
      const seen = await KoutyeCommission.findOne({
        referral: referral._id, transactionId: o.transactionId
      });
      if (seen) return { commissioned: false, reason: 'already_paid', amount: seen.amount };
    }

    const platformFee = Math.round(amount * fees.feeRate * 100) / 100;
    const commissionAmount = Math.round(platformFee * fees.koutyeRate * 100) / 100;
    if (commissionAmount <= 0) return { commissioned: false, reason: 'too_small' };

    const commission = await KoutyeCommission.create({
      koutye: koutye._id,
      referral: referral._id,
      platform: platform,
      transactionId: o.transactionId,
      serviceType: o.serviceType || 'marketplace',
      sourceAmount: amount,
      platformFee: platformFee,
      commissionRate: fees.koutyeRate,
      amount: commissionAmount,
      status: 'pending',
      description: o.description || fees.label,
      expiresAt: referral.expiryDate
    });

    koutye.stats.totalEarnings = (koutye.stats.totalEarnings || 0) + commissionAmount;
    koutye.stats.pendingEarnings = (koutye.stats.pendingEarnings || 0) + commissionAmount;
    const pb = koutye.platformBreakdown && koutye.platformBreakdown[platform];
    if (pb) pb.earnings = (pb.earnings || 0) + commissionAmount;
    koutye.updateTier();
    await koutye.save();

    referral.totalCommissionEarned = (referral.totalCommissionEarned || 0) + commissionAmount;
    referral.commissionCount = (referral.commissionCount || 0) + 1;
    referral.lastCommissionDate = new Date();
    await referral.save();

    return {
      commissioned: true, reason: 'ok', amount: commissionAmount,
      koutyeCode: koutye.koutyeCode, commissionId: commission._id
    };
  } catch (err) {
    console.error('payCommissionForUser failed for ' + userId + ':', err.message);
    return { commissioned: false, reason: 'error' };
  }
}

module.exports = {
  attachReferral,
  activeReferralFor,
  payCommissionForUser,
  normalizeCode,
  REFERRAL_WINDOW_DAYS,
  COMMISSION_RATES,
  PLATFORM_FEES
};
