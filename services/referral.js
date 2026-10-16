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

/* What an Ajan is SHOWN as their rate on each referral. 15 Oct 2026, Jeffery:
   "These commissions must never be silently reduced or calculated using
   incorrect percentages... correct the incorrect commission labels."
   These used to say 10% for MsouWout and MyPlopPlop while the engine paid 1%
   of a MyPlopPlop order and nothing at all on a ride. They now say what is
   ACTUALLY paid today, as a share of what the customer bought. ⛔ Change a
   number here only in the same commit that changes what PLATFORM_FEES below
   pays - the two must never disagree again.
   (The only thing that ever used `rate` for money was the admin manual-record
   button, which is disabled - routes/koutye.js.)                            */
const COMMISSION_RATES = {
  '48hoursready': { rate: 0.10, type: 'percentage', label: '10% of the package price' },
  'msouwout':     { rate: 0,    type: 'percentage', label: 'Not active yet: 3% of the completed, paid ride fare to the driver\'s Ajan, from activation' },
  'myplopplop':   { rate: 0.01, type: 'percentage', label: '1% of the order today (3% approved, from activation)' },
  'utility':      { rate: 0,    type: 'per_transaction', label: 'Not active yet' },
  'sol':          { rate: 0,    type: 'per_activity', label: 'Not active yet' },
  'prolakay':     { rate: 0,    type: 'percentage', label: 'Not active yet' },
  'tikelakay':    { rate: 0.03, type: 'percentage', label: '3% of the ticket price' }
};

// Agents write their code on paper, on a wall, into a phone with a cracked
// screen. Accept it however it arrives; compare it the way it is stored.
function normalizeCode(code) {
  if (!code) return '';
  return String(code).trim().toUpperCase().replace(/\s+/g, '');
}

/* A ticket buyer has NO ACCOUNT. Tikè Lakay asks for a name and a telephone
   number and nothing else, so the telephone number is the only thing that
   identifies the same person coming back a second time.

   ⚠️ This MUST match haitibiznis-backend/utils/ticketDelivery.js phoneKey()
   exactly, or the same buyer is two different people to the two services and
   the 12-month window silently never applies. Last eight digits: that is the
   part that identifies a Haitian subscriber whether or not whoever typed it
   included the 509. */
function phoneKey(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  if (!d) return '';
  return d.length > 8 ? d.slice(-8) : d;
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

    /* The same rule for somebody who has no account at all. A ticket buyer is
       only ever a telephone number, so without this a second agent's code on
       her next ticket would quietly take her off the first agent. */
    const pk = phoneKey(o.phone);
    if (!o.user && pk) {
      const already = await KoutyeReferral.findOne({
        'referredEntity.phoneKey': pk,
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
        phoneKey: phoneKey(o.phone) || undefined,
        email: o.email,
        userId: o.user || undefined
      },
      commissionRate: rate.rate,
      commissionType: rate.type,
      startDate: startDate,
      expiryDate: expiryDate,
      sourceDescription: o.source || rate.label,
      /* Stamped now, never recomputed - see the model. */
      organization: koutye.organization || ''
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
  return liveOrExpire(await KoutyeReferral.findOne({
    'referredEntity.userId': userId,
    platform: platform || 'myplopplop',
    status: 'active'
  }));
}

/* The same question for somebody with no account - a ticket buyer. */
async function activeReferralForPhone(phone, platform) {
  const pk = phoneKey(phone);
  if (!pk) return null;
  return liveOrExpire(await KoutyeReferral.findOne({
    'referredEntity.phoneKey': pk,
    platform: platform || 'tikelakay',
    status: 'active'
  }));
}

/* 12 months is 12 months. A referral that has run out is closed here, the
   first time anybody asks about it, rather than being left to pay for ever. */
async function liveOrExpire(ref) {
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
/* feeRate   = what the platform keeps out of the transaction
   koutyeRate = the agent's share OF THAT FEE, never on top of it
   commission = amount * feeRate * koutyeRate                                  */
const PLATFORM_FEES = {
  '48hoursready': { feeRate: 1.00, koutyeRate: 0.10, label: '10% of package price' },
  /* 🚨 3 Oct: this said 0.25 and the real fare split is 20%
     (services/pricing.js, commission_rate: 0.20). Every ride commission was
     therefore worked out on a fee that does not exist and the agent was
     overpaid by a quarter - 8.33 instead of 6.67 on a 333 HTG fare.
     ⛔ If the fare split ever changes, this number changes with it. */
  /* 15 Oct 2026, Jeffery: "MsouWout: 3% of the eligible completed and paid
     ride fare", to the Ajan who recruited the DRIVER. 3% of the fare out of
     MsouWout's 20% is 15% OF THE FEE: 0.20 * 0.15 = 0.03. Funded from the
     platform's cut - never the driver's 80% or DASH.
     Nothing calls this until MsouWout's KOUTYE_RIDE_COMMISSION switch is on
     (rideCommission below is the only caller). */
  'msouwout':     { feeRate: 0.20, koutyeRate: 0.15, label: '3% of the ride fare (15% of the 20% platform fee)' },
  'myplopplop':   { feeRate: 0.10, koutyeRate: 0.10, label: '10% of 10% platform fee' },
  'utility':      { feeRate: 0.05, koutyeRate: 0.10, label: '10% of 5% service fee' },
  'sol':          { feeRate: 0.02, koutyeRate: 0.10, label: '10% of 2% cycle fee' },
  'prolakay':     { feeRate: 0.15, koutyeRate: 0.10, label: '10% of 15% platform fee' },
  /* Jeffery, 3 Oct: "the agent/referrer receives 3% of the ticket price, but
     that 3% must come from within our 7.5% service fee - never added as
     another charge to the buyer."
     3% of the price out of a 7.5% fee is 40% OF THE FEE: 0.075 * 0.40 = 0.03.
     ⛔ `amount` MUST be the TICKET PRICE (subtotal), not the 1,075 the buyer
     pays - billing the buyer's total would pay the agent 32.25 instead of 30. */
  'tikelakay':    { feeRate: 0.075, koutyeRate: 0.40, label: '3% of the ticket price (40% of the 7.5% fee)' }
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
    return await payOnReferral(referral, platform, amount, o);
  } catch (err) {
    console.error('payCommissionForUser failed for ' + userId + ':', err.message);
    return { commissioned: false, reason: 'error' };
  }
}

/* Write the commission against a referral that has already been found.
   ⛔ Shared by every path on purpose: a ticket, an order and a ride must agree
   on what "the agent's share" means, and two copies of this would drift the
   way the two rate tables already did. */
async function payOnReferral(referral, platform, amount, o) {
  /* o.rates: a caller that knows the exact rule for THIS sale (the MyPlopPlop
     order rule, utils/marketFees.js) passes {feeRate, koutyeRate}; everyone
     else gets the platform's table. */
  const fees = (o && o.rates) || PLATFORM_FEES[platform];
  if (!fees) return { commissioned: false, reason: 'bad_platform' };
  try {
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
      /* The share of what the customer BOUGHT (3% on a ticket), not the share
         of the platform fee (40%) - this is the number an Ajan reads. */
      commissionRate: Math.round(fees.feeRate * fees.koutyeRate * 10000) / 10000,
      amount: commissionAmount,
      status: 'pending',
      description: o.description || fees.label,
      expiresAt: referral.expiryDate,
      organization: referral.organization || ''
    });

    /* An Enterprise Ajan's commission belongs to the organisation, not to
       the Ajan (see routes/koutye.js PERSONAL) - so it is not added to the
       Ajan's own earnings counters either. Same amount, same rate, one line. */
    if (!referral.organization) {
      koutye.stats.totalEarnings = (koutye.stats.totalEarnings || 0) + commissionAmount;
      koutye.stats.pendingEarnings = (koutye.stats.pendingEarnings || 0) + commissionAmount;
      const pb = koutye.platformBreakdown && koutye.platformBreakdown[platform];
      if (pb) pb.earnings = (pb.earnings || 0) + commissionAmount;
      koutye.updateTier();
      await koutye.save();
    }

    referral.totalCommissionEarned = (referral.totalCommissionEarned || 0) + commissionAmount;
    referral.commissionCount = (referral.commissionCount || 0) + 1;
    referral.lastCommissionDate = new Date();
    await referral.save();

    return {
      commissioned: true, reason: 'ok', amount: commissionAmount,
      koutyeCode: koutye.koutyeCode, commissionId: commission._id
    };
  } catch (err) {
    console.error('payOnReferral failed on ' + platform + ':', err.message);
    return { commissioned: false, reason: 'error' };
  }
}

/* ── TIKE LAKAY ────────────────────────────────────────────────────────────
   Jeffery, 3 Oct 2026: "I want the buyer to become that agent's referred
   customer for 12 months... During that period, when that customer purchases
   eligible Tike Lakay tickets, the assigned agent should receive the 3%."

   So there are two jobs here and they are deliberately in this order:
     1. if she is nobody's customer yet and a code came with the sale, attach
        her to that agent for 12 months;
     2. pay whoever she ALREADY belongs to - which may not be the agent whose
        code is on today's ticket. First agent wins, for the whole year.

   ⛔ `amount` is the TICKET PRICE, never the 1,075 the buyer hands over. The
   fee is added on top of the price, and the agent's 3% comes out of that fee.  */
async function commissionForTicketSale(opts) {
  const o = opts || {};
  const platform = 'tikelakay';
  const amount = Number(o.amount);
  const pk = phoneKey(o.phone);

  if (!pk) return { commissioned: false, reason: 'no_phone' };
  if (!isFinite(amount) || amount <= 0) return { commissioned: false, reason: 'no_amount' };

  try {
    let referral = await activeReferralForPhone(o.phone, platform);
    let attached = null;

    if (!referral && o.koutyeCode) {
      attached = await attachReferral({
        code: o.koutyeCode, platform: platform, entityType: 'customer',
        name: o.name, phone: o.phone, email: o.email,
        source: o.description || 'Tike Lakay ticket'
      });
      if (attached.attached) referral = attached.referral;
      else if (attached.referral) referral = await liveOrExpire(attached.referral);
    }

    if (!referral) {
      return { commissioned: false, attached: false,
               reason: (attached && attached.reason) || 'no_active_referral' };
    }

    const paid = await payOnReferral(referral, platform, amount, o);
    return Object.assign({ attached: !!(attached && attached.attached),
                           koutyeCode: referral.koutyeCode }, paid);
  } catch (err) {
    /* A ticket is the thing that matters. If the commission cannot be written
       the buyer still has her ticket and we still have the sale on record. */
    console.error('commissionForTicketSale failed:', err.message);
    return { commissioned: false, reason: 'error' };
  }
}

/* ═══ MSOUWOUT: 3% OF A PAID RIDE TO THE DRIVER'S AJAN (15 Oct 2026) ═══════
   Jeffery: "For now, the 3% ride commission should go to the Ajan who
   recruited the driver. The driver must be verified and approved, and the
   ride must be completed and paid. If another Ajan recruited the passenger,
   preserve that information for reporting, but do not generate a second
   standard commission on the same ride."

   MsouWout (Postgres) decides "completed AND paid AND approved driver AND not
   a test ride" - it is the only side that knows - and calls this once per
   ride. This side finds the driver's Ajan and pays through the same
   payOnReferral every platform uses, so the Enterprise rule (credited to the
   organisation, never also to the Ajan) applies here too.
   🔑 transactionId 'MW-<tracking code>': the same ride reported twice earns
   once.                                                                      */
async function rideCommission(o) {
  const pk = phoneKey(o.driverPhone);
  if (!pk) return { commissioned: false, reason: 'no_driver_phone' };
  const fare = Number(o.fare);
  if (!(fare > 0)) return { commissioned: false, reason: 'no_fare' };
  if (!o.rideRef) return { commissioned: false, reason: 'no_ride_ref' };

  const driverRef = await liveOrExpire(await KoutyeReferral.findOne({
    'referredEntity.phoneKey': pk, 'referredEntity.type': 'driver',
    platform: 'msouwout', status: 'active'
  }));

  /* Reporting only - looked up whether or not the driver has an Ajan. */
  let passengerKoutyeCode = '';
  const ppk = phoneKey(o.passengerPhone);
  if (ppk) {
    const pRef = await liveOrExpire(await KoutyeReferral.findOne({
      'referredEntity.phoneKey': ppk, 'referredEntity.type': { $ne: 'driver' },
      platform: 'msouwout', status: 'active'
    }));
    if (pRef) passengerKoutyeCode = pRef.koutyeCode;
  }

  if (!driverRef) return { commissioned: false, reason: 'driver_has_no_ajan', passengerKoutyeCode };

  const out = await payOnReferral(driverRef, 'msouwout', fare, {
    transactionId: 'MW-' + String(o.rideRef),
    serviceType: 'ride',
    description: 'MsouWout ride ' + o.rideRef
  });
  if (out.commissioned && out.commissionId && passengerKoutyeCode) {
    const KoutyeCommission = require('../models/KoutyeCommission');
    await KoutyeCommission.updateOne({ _id: out.commissionId }, { $set: { passengerKoutyeCode } })
      .catch(function () {});
  }
  return Object.assign({}, out, { passengerKoutyeCode });
}

/* ═══ CANCELLED OR REFUNDED -> THE COMMISSION IS TAKEN BACK (15 Oct 2026) ══
   Jeffery asked for "correct handling of cancellations and refunds", and his
   PDF: commission only on completed, paid sales, "excluding ... refunded
   amounts". Until now nothing anywhere reversed a commission.

   Every commission line written for this transactionId that has NOT been
   paid becomes 'reversed' (kept, with the reason and the date - never
   deleted). The referral's totals and, for an independent Ajan, the personal
   counters are taken back by the same amount, so every balance still adds
   up.
   ⛔ A line already PAID is not touched: money that has left cannot be
   unwritten by a status. It is reported back as `alreadyPaid`, for a person
   to recover. (Enterprise payouts are off, so today nothing can be paid.)
   Safe to call twice: a reversed line is not reversed again.               */
async function reverseCommission(o) {
  const KoutyeCommission = require('../models/KoutyeCommission');
  const Koutye = require('../models/Koutye');
  if (!o || !o.transactionId) return { reversed: 0, reason: 'no_transaction' };
  const lines = await KoutyeCommission.find({ transactionId: String(o.transactionId) });
  let reversed = 0, amount = 0;
  const alreadyPaid = [];
  for (const c of lines) {
    if (c.status === 'reversed' || c.status === 'rejected' || c.status === 'expired') continue;
    if (c.status === 'paid') { alreadyPaid.push({ id: String(c._id), amount: c.amount }); continue; }
    const r = await KoutyeCommission.updateOne(
      { _id: c._id, status: c.status },          // only if nobody changed it meanwhile
      { $set: { status: 'reversed', reversedAt: new Date(),
                reversalReason: String(o.reason || 'refunded').slice(0, 120) } });
    if (!r.modifiedCount) continue;
    reversed++; amount += c.amount;
    const ref = await KoutyeReferral.findById(c.referral);
    if (ref) {
      ref.totalCommissionEarned = Math.max(0, (ref.totalCommissionEarned || 0) - c.amount);
      ref.commissionCount = Math.max(0, (ref.commissionCount || 0) - 1);
      await ref.save().catch(function () {});
    }
    if (!c.organization) {
      const k = await Koutye.findById(c.koutye);
      if (k) {
        k.stats.totalEarnings = Math.max(0, (k.stats.totalEarnings || 0) - c.amount);
        k.stats.pendingEarnings = Math.max(0, (k.stats.pendingEarnings || 0) - c.amount);
        const pb = k.platformBreakdown && k.platformBreakdown[c.platform];
        if (pb) pb.earnings = Math.max(0, (pb.earnings || 0) - c.amount);
        await k.save().catch(function () {});
      }
    }
  }
  return { reversed, amount: Math.round(amount * 100) / 100, alreadyPaid };
}

module.exports = {
  rideCommission,
  reverseCommission,
  attachReferral,
  activeReferralFor,
  activeReferralForPhone,
  payCommissionForUser,
  commissionForTicketSale,
  phoneKey,
  normalizeCode,
  REFERRAL_WINDOW_DAYS,
  COMMISSION_RATES,
  PLATFORM_FEES
};
