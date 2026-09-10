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
    return { reachable: true, count: n };
  } catch (e) {
    return { reachable: false, count: null, why: e.message };
  } finally {
    clearTimeout(t);
  }
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

    const [s, d] = await Promise.all([storeStats(org.slug), driverStats(org.slug)]);
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
        driversReachable: d.reachable
      }
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

module.exports = router;
module.exports.parseDriverRows = parseDriverRows;
