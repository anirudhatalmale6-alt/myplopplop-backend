/* Partner organizations, and the numbers their dashboard was built to show.
 *
 * The dashboard page has existed since 18 June with statistic tiles and two
 * tables in it. It has never asked anybody for the data — the numbers were
 * zeros typed into the page. This is the half that was missing.
 *
 *   POST /api/organizations/:slug/open   public, takes the organization's code
 *   GET  /api/organizations              console code — list
 *   POST /api/organizations              console code — create one
 *   POST /api/organizations/:slug/code   console code — set/replace its code
 *   POST /api/organizations/:slug/status console code — suspend / reactivate
 *   GET  /api/organizations/:slug/agents        console code — its Ajan
 *   POST /api/organizations/:slug/agents        console code — link Ajan (by code)
 *   POST /api/organizations/:slug/agents/remove console code — unlink Ajan
 *
 * ⚠️ The drivers live in a different database on a different service
 * (MsouWout, PostgreSQL). This asks that service for its own count rather than
 * trying to reach into it, and if it cannot be reached it says so instead of
 * quietly reporting zero — a zero that means "we could not ask" is exactly the
 * kind of number that gets believed.
 */
const express = require('express');
const router = express.Router();
const Organization = require('../models/Organization');
const Store = require('../models/Store');
const { requirePin } = require('../utils/consolePin');

const MSW_API = process.env.MSOUWOUT_API || 'https://msouwout-backend.onrender.com';

/* Matched without regard to case: the same partner appears as "SPAP", "spap"
   and "Spap" on records typed by different people over months. */
function slugRe(slug) {
  return new RegExp('^' + String(slug).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
}

/* "Can the organization see which member referred each merchant?"
   The two halves were both being recorded and never joined. A shop carries the
   ORGANISATION as a string (`referralPartner`), while the individual agent is
   recorded separately in KoutyeReferral, keyed on the shop OWNER's user id -
   not on the shop. So the answer was sitting in the database in two pieces.
   This is the join. */
async function attachAgents(stores) {
  const owners = stores.map(s => s.owner).filter(Boolean);
  if (!owners.length) return stores;
  let byOwner = {};
  try {
    const KoutyeReferral = require('../models/KoutyeReferral');
    const refs = await KoutyeReferral.find({ 'referredEntity.userId': { $in: owners } })
      .select('koutyeCode referredEntity.userId createdAt').lean();
    refs.forEach(r => {
      const k = String(r.referredEntity && r.referredEntity.userId);
      /* First agent wins, same rule the engine itself uses. */
      if (k && !byOwner[k]) byOwner[k] = r.koutyeCode;
    });
  } catch (e) {
    /* An unjoinable agent must never blank the shop list. */
    return stores;
  }
  return stores.map(s => ({ ...s, referredByAgent: byOwner[String(s.owner)] || null }));
}

async function storeStats(slug) {
  const filter = { referralPartner: slugRe(slug) };
  let stores = await Store.find(filter)
    .select('name owner ownerName phone category location status isVerified createdAt')
    .sort({ createdAt: -1 }).limit(200).lean();
  stores = await attachAgents(stores);
  /* Do not leak the owner's internal id to the browser - it was only needed
     for the join. */
  stores = stores.map(({ owner, ...rest }) => rest);
  return {
    count: await Store.countDocuments(filter),
    active: await Store.countDocuments({ ...filter, isVerified: true }),
    withAgent: stores.filter(s => s.referredByAgent).length,
    stores
  };
}

/* Exported so it can be tested on its own rather than re-implemented in a
   test, which would only prove what I THINK the shape is. */
function parseDriverRows(j, slug) {
  const rows = Array.isArray(j) ? j : (j && Array.isArray(j.stats) ? j.stats : null);
  if (rows) {
    const want = String(slug).toLowerCase();
    return rows
      .filter(x => String(x.partner || '').toLowerCase() === want)
      .reduce((a, x) => a + (+x.total_registered || +x.count || 0), 0);
  }
  if (j && j.total != null) return +j.total;
  return null;
}

/* Registered -> Approved -> Qualified (Jeffery, 15 Oct: approved AND at least
   one legitimate paid ride). Null for a field the rides service does not send
   yet - an older deploy - so the page shows "-" rather than a believable 0. */
function parseDriverFunnel(j, slug) {
  const rows = Array.isArray(j) ? j : (j && Array.isArray(j.stats) ? j.stats : null);
  if (!rows) return null;
  const want = String(slug).toLowerCase();
  const mine = rows.filter(x => String(x.partner || '').toLowerCase() === want);
  const sum = (k) => mine.some(x => x[k] != null) ? mine.reduce((a, x) => a + (+x[k] || 0), 0) : null;
  return { registered: sum('total_registered'), approved: sum('approved_drivers'), qualified: sum('qualified_drivers') };
}

async function driverStats(slug) {
  /* A short timeout on purpose. The dashboard must still open and show the
     shops even when the rides service is asleep. */
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 8000);
  try {
    const r = await fetch(MSW_API + '/api/drivers/partner-stats?partner=' + encodeURIComponent(slug),
      { signal: c.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    /* That endpoint answers with a BARE ARRAY of rows like
       {partner, total_registered, total_verified, active_drivers, ...} — I
       checked the live response rather than assuming a shape. Reading it as
       {total} or {stats} would have quietly reported 0 drivers for a partner
       that has some, which is worse than an error. */
    const n = parseDriverRows(j, slug);
    if (n == null) return { reachable: false, count: null, why: 'unexpected shape' };
    return { reachable: true, count: n, funnel: parseDriverFunnel(j, slug) };
  } catch (e) {
    return { reachable: false, count: null, why: e.message };
  } finally {
    clearTimeout(t);
  }
}

/* ═══ ENTERPRISE: THE ORGANISATION'S OWN AJAN (15 Oct 2026) ════════════════
   "HaitiBiznis -> StarFlex Enterprise -> StarFlex Ajan -> recruits."
   Built on what was already here: Koutye agents (code, QR, wallet) and these
   Organization records. The only new fact is Koutye.organization; referrals
   and commissions carry the organisation they were made under.
   ⚠️ Commission figures are what has been EARNED and recorded. Nothing here
   pays anybody - payouts to an organisation stay off until the rates are
   agreed. */
async function teamStats(slug) {
  const Koutye = require('../models/Koutye');
  const KoutyeReferral = require('../models/KoutyeReferral');
  const KoutyeCommission = require('../models/KoutyeCommission');
  const re = slugRe(slug);

  const agents = await Koutye.find({ organization: re })
    .select('koutyeCode status tier user stats organizationLinkedAt createdAt')
    .populate('user', 'name').sort({ koutyeCode: 1 }).lean();

  /* Referrals and commissions counted from the records themselves, not from
     the cached counters on the agent - those were never maintained for every
     path, and a dashboard number must be one we can show the working for. */
  const refAgg = await KoutyeReferral.aggregate([
    { $match: { organization: re } },
    { $group: { _id: { code: '$koutyeCode', platform: '$platform', type: '$referredEntity.type' },
                n: { $sum: 1 } } }
  ]);
  const comAgg = await KoutyeCommission.aggregate([
    { $match: { organization: re } },
    { $group: { _id: { code: null, status: '$status' }, amount: { $sum: '$amount' }, n: { $sum: 1 } } }
  ]);
  const comByAgent = await KoutyeCommission.aggregate([
    { $match: { organization: re, status: { $nin: ['rejected', 'expired'] } } },
    { $lookup: { from: 'koutyes', localField: 'koutye', foreignField: '_id', as: 'k' } },
    { $group: { _id: { $arrayElemAt: ['$k.koutyeCode', 0] }, amount: { $sum: '$amount' } } }
  ]);

  const perAgent = {};
  const byPlatform = {};
  const byType = {};
  refAgg.forEach(r => {
    const c = r._id.code;
    perAgent[c] = perAgent[c] || { referrals: 0, byPlatform: {} };
    perAgent[c].referrals += r.n;
    perAgent[c].byPlatform[r._id.platform] = (perAgent[c].byPlatform[r._id.platform] || 0) + r.n;
    byPlatform[r._id.platform] = (byPlatform[r._id.platform] || 0) + r.n;
    const t = r._id.type || 'customer';
    byType[t] = (byType[t] || 0) + r.n;
  });
  const comMap = {};
  comByAgent.forEach(c => { comMap[c._id] = Math.round(c.amount * 100) / 100; });
  /* Every status the model allows, so a figure is never missing just because
     nothing has reached that stage yet. `total` is what the team has
     genuinely generated: rejected and expired lines are shown but not added. */
  const commissions = { pending: 0, validated: 0, approved: 0, paid: 0, rejected: 0, expired: 0, total: 0, count: 0 };
  comAgg.forEach(c => {
    const st = c._id.status || 'pending';
    commissions[st] = Math.round(((commissions[st] || 0) + c.amount) * 100) / 100;
    if (st !== 'rejected' && st !== 'expired') {
      commissions.total = Math.round((commissions.total + c.amount) * 100) / 100;
      commissions.count += c.n;
    }
  });

  return {
    agents: agents.map(a => ({
      code: a.koutyeCode,
      name: (a.user && a.user.name) || '',
      status: a.status,
      tier: a.tier,
      linkedAt: a.organizationLinkedAt || null,
      referrals: (perAgent[a.koutyeCode] || {}).referrals || 0,
      byPlatform: (perAgent[a.koutyeCode] || {}).byPlatform || {},
      commissionGenerated: comMap[a.koutyeCode] || 0
    })),
    referrals: { total: refAgg.reduce((x, r) => x + r.n, 0), byPlatform, byType },
    commissions,
    payoutsEnabled: false
  };
}

/* --------------------------------------------------- the partner's own door */
router.post('/:slug/open', async (req, res) => {
  try {
    const org = await Organization.findOne({ slug: slugRe(req.params.slug) })
      .select('+accessSalt +accessHash');
    /* Same answer whether the organization does not exist or the code is
       wrong, so this cannot be used to discover which partners exist. */
    if (!org || org.status !== 'active' || !org.checkAccessCode(req.body && req.body.code)) {
      return res.status(403).json({ success: false, message: 'Wrong code' });
    }
    org.lastOpenedAt = new Date();
    await org.save();

    const [s, d, team] = await Promise.all([
      storeStats(org.slug), driverStats(org.slug),
      /* A failure here must not lock a partner out of the dashboard they
         already had - shops and drivers still show. */
      teamStats(org.slug).catch(e => ({ error: e.message }))
    ]);
    res.json({
      success: true,
      organization: { slug: org.slug, name: org.name, fullName: org.fullName,
                      logo: org.logo, color: org.color },
      stores: s.stores,
      stats: {
        stores: s.count,
        activeStores: s.active,
        withAgent: s.withAgent,
        drivers: d.count,
        driversReachable: d.reachable,
        driverFunnel: d.funnel || null
      },
      team
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ------------------------------------------------------------ his console */
router.get('/', requirePin, async (req, res) => {
  try {
    const orgs = await Organization.find({}).sort({ name: 1 }).lean();
    /* Counts alongside each one, so the console itself is useful. */
    const withCounts = await Promise.all(orgs.map(async o => ({
      ...o,
      hasCode: !!(o.accessSalt && o.accessHash) || undefined,
      stores: await Store.countDocuments({ referralPartner: slugRe(o.slug) })
    })));
    res.json({ success: true, count: withCounts.length, organizations: withCounts });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/', requirePin, async (req, res) => {
  try {
    const slug = String(req.body.slug || req.body.name || '').trim();
    if (!slug) return res.status(400).json({ success: false, message: 'A name is required' });
    const existing = await Organization.findOne({ slug: slugRe(slug) });
    if (existing) return res.status(409).json({ success: false, message: 'That organization already exists' });

    const org = new Organization({
      slug,
      name: String(req.body.name || slug).trim(),
      fullName: String(req.body.fullName || '').trim(),
      logo: String(req.body.logo || '').trim(),
      color: String(req.body.color || '#00209F').trim()
    });
    if (req.body.code) org.setAccessCode(req.body.code);
    await org.save();
    res.status(201).json({ success: true, organization: { slug: org.slug, name: org.name } });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.post('/:slug/code', requirePin, async (req, res) => {
  try {
    const org = await Organization.findOne({ slug: slugRe(req.params.slug) });
    if (!org) return res.status(404).json({ success: false, message: 'No such organization' });
    org.setAccessCode(req.body && req.body.code);
    await org.save();
    res.json({ success: true, slug: org.slug });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, message: err.message });
  }
});

router.post('/:slug/status', requirePin, async (req, res) => {
  try {
    const status = req.body.status === 'suspended' ? 'suspended' : 'active';
    const org = await Organization.findOneAndUpdate(
      { slug: slugRe(req.params.slug) }, { $set: { status } }, { new: true });
    if (!org) return res.status(404).json({ success: false, message: 'No such organization' });
    res.json({ success: true, slug: org.slug, status: org.status });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/* ---------------------------------------------- his console: the org's Ajan */
function cleanCodes(list) {
  return (Array.isArray(list) ? list : String(list || '').split(/[\s,;]+/))
    .map(c => String(c || '').trim()).filter(Boolean).slice(0, 200);
}
function codeRe(c) {
  return new RegExp('^' + c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
}

router.get('/:slug/agents', requirePin, async (req, res) => {
  try {
    const org = await Organization.findOne({ slug: slugRe(req.params.slug) }).lean();
    if (!org) return res.status(404).json({ success: false, message: 'No such organization' });
    res.json({ success: true, slug: org.slug, ...(await teamStats(org.slug)) });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/* Link Ajan to the organisation, by their code.
   ⛔ An agent already working for ANOTHER organisation is refused unless
   `move: true` - moving somebody between partners is a decision, never a
   side effect of pasting a list.
   History is NOT rewritten: people an agent recruited before today stay
   credited as they were. Only recruits from now on carry this organisation.
   `dryRun: true` reports what would happen and changes nothing - so he can
   check Christopher's list against our records before approving it. */
router.post('/:slug/agents', requirePin, async (req, res) => {
  try {
    const Koutye = require('../models/Koutye');
    const org = await Organization.findOne({ slug: slugRe(req.params.slug) });
    if (!org) return res.status(404).json({ success: false, message: 'No such organization' });
    const codes = cleanCodes(req.body && req.body.codes);
    if (!codes.length) return res.status(400).json({ success: false, message: 'No agent codes given' });
    const move = !!(req.body && req.body.move);
    const dryRun = !!(req.body && req.body.dryRun);

    const result = [];
    for (const c of codes) {
      const k = await Koutye.findOne({ koutyeCode: codeRe(c) }).populate('user', 'name');
      if (!k) { result.push({ code: c, outcome: 'not_found' }); continue; }
      const cur = k.organization || '';
      if (cur && cur.toLowerCase() === org.slug.toLowerCase()) {
        result.push({ code: k.koutyeCode, name: k.user && k.user.name, outcome: 'already_linked' }); continue;
      }
      if (cur && !move) {
        result.push({ code: k.koutyeCode, name: k.user && k.user.name, outcome: 'belongs_to_other', organization: cur }); continue;
      }
      if (!dryRun) {
        k.organization = org.slug;
        k.organizationLinkedAt = new Date();
        await k.save();
      }
      result.push({ code: k.koutyeCode, name: k.user && k.user.name, status: k.status,
                    outcome: dryRun ? 'would_link' : (cur ? 'moved' : 'linked'), from: cur || undefined });
    }
    res.json({ success: true, slug: org.slug, dryRun, result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/:slug/agents/remove', requirePin, async (req, res) => {
  try {
    const Koutye = require('../models/Koutye');
    const org = await Organization.findOne({ slug: slugRe(req.params.slug) }).lean();
    if (!org) return res.status(404).json({ success: false, message: 'No such organization' });
    const codes = cleanCodes(req.body && req.body.codes);
    const result = [];
    for (const c of codes) {
      const k = await Koutye.findOne({ koutyeCode: codeRe(c), organization: slugRe(org.slug) });
      if (!k) { result.push({ code: c, outcome: 'not_linked' }); continue; }
      /* Unlinking does not touch anything already recruited: those people
         stay credited to the organisation they were recruited for. */
      k.organization = '';
      k.organizationLinkedAt = undefined;
      await k.save();
      result.push({ code: k.koutyeCode, outcome: 'unlinked' });
    }
    res.json({ success: true, slug: org.slug, result });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
module.exports.parseDriverRows = parseDriverRows;
module.exports.parseDriverFunnel = parseDriverFunnel;
module.exports.teamStats = teamStats;
