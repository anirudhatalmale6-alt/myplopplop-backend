/* ═══ MERCHANT VERIFICATION (4 Nov 2026, Jeffery: "MYPLOPPLOP — YES, APPROVED") ═══════════════════════════
   Jennifer's review of the businesses Ajans register from LajanMaker - the MyPlopPlop twin of the MsouWout
   driver console. Mounted at /api/internal/merchants behind the shared INTERNAL_SERVICE_KEY: only
   haitibiznis-api (her console code checked THERE) calls it. Every decision carries her name.
   - pending → (fix ↔ pending) → approved (store public + orders) | rejected (stays hidden)
   - stores created before 4 Nov have no verification: never switched off here; "review" only notes them.
   - the owner's ID photo lives in MerchantDocument and is served ONLY by GET /:id below. */
const express = require('express');
const router = express.Router();
const Store = require('../models/Store');
const User = require('../models/User');
const Product = require('../models/Product');
const MerchantDocument = require('../models/MerchantDocument');
const storesRouter = require('./stores');
const merchantVerify = require('../services/merchantVerify');
let Koutye = null; try { Koutye = require('../models/Koutye'); } catch (e) { /* optional */ }

const ID_RE = /^[0-9a-fA-F]{24}$/;
const NEED = ['storefront', 'owner_id'];
const FIXABLE = NEED.concat(['patente', 'mspp']);
const by = (req) => String((req.body && req.body.by) || '').trim().slice(0, 60);

async function agentNames(codes) {
  const out = {};
  if (!Koutye || !codes.length) return out;
  const ks = await Koutye.find({ koutyeCode: { $in: codes } }).populate('user', 'name').select('koutyeCode user').lean();
  ks.forEach((k) => { out[String(k.koutyeCode).toUpperCase()] = (k.user && k.user.name) || ''; });
  return out;
}
function view(s, docs, names, products) {
  const v = s.verification || {};
  const code = String(v.agentCode || '').toUpperCase();
  return {
    id: String(s._id), name: s.name, slug: s.slug, category: s.category, phone: s.phone || '', description: s.description || '',
    address: (s.address && s.address.street) || '', status: s.status, isVerified: !!s.isVerified, createdAt: s.createdAt,
    owner: s.owner ? { name: s.owner.name || '', phone: s.owner.phone || '' } : null,
    state: v.state || 'legacy', source: v.source || '', agentCode: code, agentName: names[code] || '',
    fixDocs: v.fixDocs || [], fixNote: v.fixNote || '', reason: v.reason || '', decidedBy: v.decidedBy || '', decidedAt: v.decidedAt || null,
    welcomeBy: v.welcomeBy || '', welcomeAt: v.welcomeAt || null, review: v.review || null,
    docs: docs || [], products: products || 0,
    /* 4 Nov 2026 (PATENTE) */
    patente: storesRouter.patenteView(v.patente), assist: v.assist && v.assist.asked ? { state: v.assist.state || 'new', at: v.assist.at, note: v.assist.note || '', by: v.assist.by || '' } : null,
    trust: s.trust ? s.trust.level : '', licence: merchantVerify.LICENSED[s.category] || [],
    licenceMissing: merchantVerify.licenceMissing(s.category, v, docs || []), city: (s.address && s.address.city) || ''
  };
}

/* GET /?state=pending|fix|approved|rejected|active|legacy|all - every store, counted once per category */
router.get('/', async (req, res) => {
  try {
    const rows = await Store.find({}).select('+verification').populate('owner', 'name phone').sort({ createdAt: -1 }).limit(1000).lean();
    const ids = rows.map((s) => s._id);
    const docs = await MerchantDocument.find({ store: { $in: ids } }).select('store type').lean();
    const byStore = {}; docs.forEach((d) => { (byStore[String(d.store)] = byStore[String(d.store)] || []).push(d.type); });
    const pc = await Product.aggregate([{ $match: { store: { $in: ids } } }, { $group: { _id: '$store', n: { $sum: 1 } } }]);
    const prod = {}; pc.forEach((x) => { prod[String(x._id)] = x.n; });
    const names = await agentNames([...new Set(rows.map((s) => String((s.verification && s.verification.agentCode) || '').toUpperCase()).filter(Boolean))]);
    const all = rows.map((s) => view(s, byStore[String(s._id)], names, prod[String(s._id)]));
    const counts = { pending: 0, fix: 0, approved: 0, rejected: 0, active: 0, legacy: 0, legacy_unreviewed: 0, all: all.length,
      pat_green: 0, pat_yellow: 0, pat_check: 0, pat_stale: 0, assist_new: 0, assist: 0 };
    all.forEach((m) => {
      const p = m.patente;
      if (m.trust === 'patente' && (p.fresh === 'current' || p.fresh === 'grace')) counts.pat_green++;
      else if (m.trust) counts.pat_yellow++;
      if (p.state === 'pending' && m.state !== 'rejected') counts.pat_check++;
      if (p.has === 'yes' && p.fy && p.fresh === 'expired') counts.pat_stale++;
      if (m.assist) { counts.assist++; if (m.assist.state === 'new') counts.assist_new++; }
      if (counts[m.state] !== undefined) counts[m.state]++;
      if (m.status === 'active') counts.active++;
      if (m.state === 'legacy' && !(m.review && m.review.state)) counts.legacy_unreviewed++;
    });
    res.set('Cache-Control', 'no-store');
    res.json({ merchants: all, counts });
  } catch (e) { res.status(500).json({ error: 'list_failed' }); }
});

/* GET /:id - one business WITH its private photos (staff only) */
router.get('/:id', async (req, res) => {
  try {
    if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
    const s = await Store.findById(req.params.id).select('+verification').populate('owner', 'name phone').lean();
    if (!s) return res.status(404).json({ error: 'not_found' });
    const docs = await MerchantDocument.find({ store: s._id }).lean();
    const names = await agentNames(s.verification && s.verification.agentCode ? [String(s.verification.agentCode).toUpperCase()] : []);
    const products = await Product.countDocuments({ store: s._id });
    res.set('Cache-Control', 'no-store');
    res.json({ merchant: view(s, docs.map((d) => d.type), names, products),
      history: ((s.verification && s.verification.history) || []).slice(-50),
      documents: docs.map((d) => ({ type: d.type, by: d.by || '', at: d.updatedAt, data_url: 'data:' + d.mime + ';base64,' + d.data })) });
  } catch (e) { res.status(500).json({ error: 'detail_failed' }); }
});

/* POST /:id/:act - approve | reject | fix | reopen | document | ajan-document | welcome | review | patente | assist */
router.post('/:id/:act', async (req, res) => {
  try {
    if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
    const act = req.params.act, b = req.body || {}, who = by(req);
    const s = await Store.findById(req.params.id).select('+verification');
    if (!s) return res.status(404).json({ error: 'not_found' });
    const v = s.verification || {}, state = v.state || 'legacy';
    const log = (action, note) => ({ $push: { 'verification.history': { at: new Date(), by: who ? 'console:' + who : 'console', action, note: String(note || '').slice(0, 200) } } });

    if (act === 'ajan-document') {
      /* the Ajan's approved phone (checked by haitibiznis-api), and only for a business credited to HIS code */
      const code = String(b.agentCode || '').toUpperCase();
      if (!code || code !== String(v.agentCode || '').toUpperCase()) return res.status(403).json({ error: 'not_your_business' });
      const r = await storesRouter.saveVerificationDoc(s, b, 'ajan:' + String(b.agentId || code).slice(0, 40));
      return res.status(r.code).json(r.body);
    }
    if (!who) return res.status(400).json({ error: 'name_required' });
    if (act === 'document') {
      const r = await storesRouter.saveVerificationDoc(s, b, 'console:' + who);
      return res.status(r.code).json(r.body);
    }
    if (act === 'approve') {
      if (state !== 'pending') return res.status(409).json({ error: state === 'fix' ? 'corrections_pending' : 'not_pending', state });
      const have = (await MerchantDocument.find({ store: s._id }).select('type').lean()).map((d) => d.type);
      const missing = NEED.filter((t) => have.indexOf(t) < 0);
      if (missing.length) return res.status(409).json({ error: 'missing_documents', missing });
      /* pharmacies: verified Patente (current fiscal year) + MSPP authorisation, BEFORE they can sell */
      const lic = merchantVerify.licenceMissing(s.category, v, have);
      if (lic.length) return res.status(409).json({ error: 'licence_required', missing: lic });
      await Store.updateOne({ _id: s._id }, Object.assign({ $set: { status: 'active', isVerified: true, 'verification.state': 'approved',
        'verification.decidedBy': who, 'verification.decidedAt': new Date(), 'verification.fixDocs': [], 'verification.reason': '' } }, log('approve', '')));
      await merchantVerify.syncTrust(Store, s._id);
      console.log('[MERCHANT] ' + s._id + ' APPROVED by ' + who);
      return res.json({ ok: true, state: 'approved' });
    }
    if (act === 'reject') {
      const reason = String(b.reason || '').trim().slice(0, 300);
      if (!reason) return res.status(400).json({ error: 'reason_required' });
      if (['pending', 'fix'].indexOf(state) < 0) return res.status(409).json({ error: 'not_pending', state });
      await Store.updateOne({ _id: s._id }, Object.assign({ $set: { status: 'pending', isVerified: false, 'verification.state': 'rejected',
        'verification.reason': reason, 'verification.decidedBy': who, 'verification.decidedAt': new Date() }, $unset: { trust: 1 } }, log('reject', reason)));
      return res.json({ ok: true, state: 'rejected' });
    }
    if (act === 'fix') {
      const docs = (Array.isArray(b.docs) ? b.docs : []).map(String).filter((t) => FIXABLE.indexOf(t) >= 0 || t === 'info');
      if (!docs.length) return res.status(400).json({ error: 'docs_required' });
      if (['pending', 'fix'].indexOf(state) < 0) return res.status(409).json({ error: 'not_pending', state });
      const note = String(b.note || '').trim().slice(0, 300);
      const fset = { 'verification.state': 'fix', 'verification.fixDocs': docs, 'verification.fixNote': note };
      if (docs.indexOf('patente') >= 0) { fset['verification.patente.state'] = 'fix'; fset['verification.patente.note'] = note; }
      await Store.updateOne({ _id: s._id }, Object.assign({ $set: fset },
        log('fix', docs.join(',') + (note ? ' - ' + note : ''))));
      return res.json({ ok: true, state: 'fix' });
    }
    if (act === 'edit') {
      /* Jennifer corrects the basic information herself (Jeffery 4 Nov) - logged old → new; never status/owner */
      const E = { name: 100, category: 20, phone: 32, description: 500, address: 200, ownerName: 80 };
      const changed = {}, set = {};
      for (const k of Object.keys(E)) {
        if (b[k] === undefined) continue;
        const val = String(b[k]).trim().slice(0, E[k]);
        if (k === 'name' && !val) return res.status(400).json({ error: 'name_required' });
        if (k === 'category' && ['restaurant', 'supermarket', 'hardware', 'pharmacy', 'wholesale', 'retail', 'bakery', 'other'].indexOf(val) < 0) return res.status(400).json({ error: 'bad_category' });
        if (k === 'category' && val !== s.category && merchantVerify.LICENSED[val] && state === 'approved') {
          const have = (await MerchantDocument.find({ store: s._id }).select('type').lean()).map((d) => d.type);
          const lic = merchantVerify.licenceMissing(val, v, have);
          if (lic.length) return res.status(409).json({ error: 'licence_required', missing: lic });
        }
        const cur = k === 'address' ? ((s.address && s.address.street) || '') : k === 'ownerName' ? null : String(s[k] || '');
        if (k === 'ownerName') {
          const u = await User.findById(s.owner).select('name');
          if (u && u.name !== val && val) { changed.ownerName = [u.name, val]; u.name = val; await u.save(); }
          continue;
        }
        if (cur !== val) { changed[k] = [cur, val]; set[k === 'address' ? 'address.street' : k] = val; }
      }
      if (!Object.keys(changed).length) return res.json({ ok: true, changed: {} });
      await Store.updateOne({ _id: s._id }, Object.assign({ $set: set }, log('edit', Object.keys(changed).map((k) => k + ': ' + changed[k][0] + ' → ' + changed[k][1]).join(' · '))));
      return res.json({ ok: true, changed });
    }
    if (act === 'fix-done') {
      /* Jennifer: the information she asked for is corrected (no photo involved) */
      if (state !== 'fix') return res.status(409).json({ error: 'not_fix', state });
      const left = (v.fixDocs || []).filter((t) => t !== 'info');
      await Store.updateOne({ _id: s._id }, Object.assign({ $set: { 'verification.fixDocs': left, 'verification.state': left.length ? 'fix' : 'pending' } }, log('fix-done', '')));
      return res.json({ ok: true, state: left.length ? 'fix' : 'pending' });
    }
    if (act === 'reopen') {
      if (state !== 'rejected') return res.status(409).json({ error: 'not_rejected', state });
      await Store.updateOne({ _id: s._id }, Object.assign({ $set: { 'verification.state': 'pending', 'verification.reason': '' } }, log('reopen', '')));
      return res.json({ ok: true, state: 'pending' });
    }
    if (act === 'welcome') {
      if (state !== 'approved') return res.status(409).json({ error: 'not_approved', state });
      if (v.welcomeAt) return res.status(409).json({ error: 'already_sent', welcomeBy: v.welcomeBy, welcomeAt: v.welcomeAt });
      await Store.updateOne({ _id: s._id }, Object.assign({ $set: { 'verification.welcomeBy': who, 'verification.welcomeAt': new Date() } }, log('welcome', 'WhatsApp')));
      return res.json({ ok: true });
    }
    if (act === 'patente') {
      /* 4 Nov 2026 (PATENTE) - Jennifer: verify | fix (ask a correction) | edit (number, fiscal year, yes/no) | unverify.
         Allowed on any store that is not rejected, including stores from before 4 Nov (it never closes them). */
      if (state === 'rejected') return res.status(409).json({ error: 'not_pending', state });
      const op = String(b.op || ''), p = v.patente || {}, note = String(b.note || '').trim().slice(0, 300);
      const have = (await MerchantDocument.find({ store: s._id }).select('type').lean()).map((d) => d.type);
      const set = {};
      let logNote = '';
      if (op === 'verify') {
        if (have.indexOf('patente') < 0) return res.status(409).json({ error: 'missing_documents', missing: ['patente'] });
        if (!p.fy) return res.status(400).json({ error: 'fiscal_year_required' });
        Object.assign(set, { 'verification.patente.has': 'yes', 'verification.patente.state': 'verified', 'verification.patente.note': '',
          'verification.patente.by': who, 'verification.patente.at': new Date() });
        logNote = (p.number ? '#' + p.number + ' ' : '') + p.fy + '-' + (p.fy + 1);
      } else if (op === 'unverify') {
        if (p.state !== 'verified') return res.status(409).json({ error: 'not_verified' });
        Object.assign(set, { 'verification.patente.state': 'pending', 'verification.patente.by': who, 'verification.patente.at': new Date() });
        logNote = note;
      } else if (op === 'fix') {
        if (!note) return res.status(400).json({ error: 'note_required' });
        Object.assign(set, { 'verification.patente.state': 'fix', 'verification.patente.note': note, 'verification.patente.by': who, 'verification.patente.at': new Date() });
        /* while the store itself still waits, this is one of its corrections (same 🔧 flow as the photos) */
        if (state === 'pending' || state === 'fix') {
          set['verification.state'] = 'fix';
          set['verification.fixDocs'] = [...new Set((v.fixDocs || []).concat(['patente']))];
          set['verification.fixNote'] = note;
        }
        logNote = note;
      } else if (op === 'edit') {
        const pat = storesRouter.patenteInput({ has: b.has || p.has || 'yes', number: b.number !== undefined ? b.number : p.number, fy: b.fy !== undefined ? b.fy : p.fy });
        if (!pat) return res.status(400).json({ error: 'has_required' });
        if (b.fy !== undefined && b.fy !== '' && b.fy !== null && !pat.fy) return res.status(400).json({ error: 'bad_fiscal_year' });
        const ch = [];
        if ((p.has || '') !== pat.has) ch.push('Patente: ' + (p.has || '—') + ' → ' + pat.has);
        if ((p.number || '') !== pat.number) ch.push('nº: ' + (p.number || '—') + ' → ' + (pat.number || '—'));
        if ((p.fy || null) !== (pat.fy || null)) ch.push('ane fiskal: ' + (p.fy || '—') + ' → ' + (pat.fy || '—'));
        if (!ch.length) return res.json({ ok: true, changed: [] });
        Object.assign(set, { 'verification.patente.has': pat.has, 'verification.patente.number': pat.number, 'verification.patente.fy': pat.fy || null });
        if (pat.has === 'no') set['verification.patente.state'] = 'none';
        else if (!p.state || p.state === 'none') set['verification.patente.state'] = 'pending';
        logNote = ch.join(' · ');
      } else return res.status(400).json({ error: 'bad_op' });
      await Store.updateOne({ _id: s._id }, Object.assign({ $set: set }, log('patente-' + op, logNote)));
      const trust = await merchantVerify.syncTrust(Store, s._id);
      return res.json({ ok: true, trust: trust ? trust.level : '' });
    }
    if (act === 'assist') {
      /* the formalization lead ("Mwen bezwen asistans"): Jennifer follows it up - contacted | done | reopen | new (she opens one) */
      const op = String(b.op || ''), note = String(b.note || '').trim().slice(0, 300), a = v.assist || {};
      const next = { contacted: 'contacted', done: 'done', reopen: 'new', new: 'new' }[op];
      if (!next) return res.status(400).json({ error: 'bad_op' });
      if (op !== 'new' && !a.asked) return res.status(409).json({ error: 'no_request' });
      const set = { 'verification.assist.asked': true, 'verification.assist.state': next, 'verification.assist.by': who };
      if (note) set['verification.assist.note'] = note;
      if (op === 'new' && !a.asked) set['verification.assist.at'] = new Date();
      if (next === 'done') set['verification.assist.doneAt'] = new Date();
      await Store.updateOne({ _id: s._id }, Object.assign({ $set: set }, log('assist-' + op, note)));
      return res.json({ ok: true, state: next });
    }
    if (act === 'review') {
      /* an EXISTING store (before 4 Nov): Jennifer's note only - it is never switched off from here */
      if (state !== 'legacy' && state !== 'approved') return res.status(409).json({ error: 'not_existing_store', state });
      const rs = b.state === 'flag' ? 'flag' : 'ok', note = String(b.note || '').trim().slice(0, 300);
      await Store.updateOne({ _id: s._id }, { $set: { 'verification.review': { state: rs, by: who, at: new Date(), note } },
        $push: { 'verification.history': { at: new Date(), by: 'console:' + who, action: 'review-' + rs, note } } });
      return res.json({ ok: true, review: rs });
    }
    res.status(404).json({ error: 'not_found' });
  } catch (e) { res.status(500).json({ error: 'action_failed' }); }
});

module.exports = router;
