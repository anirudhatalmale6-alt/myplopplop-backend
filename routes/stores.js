const express = require('express');
const marketFees = require('../utils/marketFees');

/* 16 Oct 2026: the shop never sees the customer's delivery code: the driver
   must get it from the customer at the door, or it proves nothing. */
function noPin(o) {
  var x = o && o.toObject ? o.toObject() : Object.assign({}, o);
  delete x.deliveryPin; delete x.pinAttempts;
  return x;
}
const router = express.Router();
const { body, validationResult } = require('express-validator');
const Store = require('../models/Store');
const Product = require('../models/Product');
const Order = require('../models/Order');
const { protect, authorize } = require('../middleware/auth');
const referralService = require('../services/referral');
const merchantVerify = require('../services/merchantVerify');
const MerchantDocument = require('../models/MerchantDocument');

// ─── GET ALL ACTIVE STORES (public) ───
router.get('/', async function(req, res) {
  try {
    var page = parseInt(req.query.page) || 1;
    var limit = parseInt(req.query.limit) || 20;
    var category = req.query.category;
    var search = req.query.search;

    var query = { status: 'active' };
    if (category) query.category = category;
    if (search) {
      query.name = { $regex: search, $options: 'i' };
    }

    var stores = await Store.find(query)
      .select('name slug category logo coverImage rating stats address deliveryOptions isFeatured isVerified status trust')
      .sort({ isFeatured: -1, 'rating.average': -1 })
      .skip((page - 1) * limit)
      .limit(limit);

    var total = await Store.countDocuments(query);

    res.json({
      success: true,
      data: stores,
      pagination: { page: page, limit: limit, total: total }
    });
  } catch (err) {
    console.error('Get stores error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET STORE BY SLUG (public) ───
router.get('/s/:slug', async function(req, res) {
  try {
    var store = await Store.findOne({ slug: req.params.slug, status: 'active' })
      .populate('owner', 'name phone');

    if (!store) {
      return res.status(404).json({ success: false, message: 'Store not found' });
    }

    var products = await Product.find({ store: store._id, isActive: true })
      .sort({ isFeatured: -1, orderCount: -1 });

    res.json({ success: true, data: { store: store, products: products } });
  } catch (err) {
    console.error('Get store error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET STORE BY ID (public) ───
router.get('/:id', async function(req, res) {
  try {
    // A shop link that carries a name instead of an id - a shared link that
    // got edited, an old bookmark, /api/stores/products - used to reach
    // Store.findOne with something that is not an id at all, and mongoose
    // threw. The shopper saw "Server error" for what is really just a shop
    // that is not there. Answer the question that was actually asked: look it
    // up by slug too, and say "not found" when it is not found.
    var byId = /^[0-9a-fA-F]{24}$/.test(String(req.params.id));
    var store = await Store.findOne(byId
      ? { _id: req.params.id, status: 'active' }
      : { slug: req.params.id, status: 'active' });
    if (!store) {
      return res.status(404).json({ success: false, message: 'Store not found' });
    }

    var products = await Product.find({ store: store._id, isActive: true })
      .sort({ isFeatured: -1, orderCount: -1 });

    res.json({ success: true, data: { store: store, products: products } });
  } catch (err) {
    console.error('Get store error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── CREATE STORE (merchant) ───
router.post('/', protect, [
  body('name').trim().notEmpty().withMessage('Store name is required'),
  body('category').isIn(['restaurant', 'supermarket', 'hardware', 'pharmacy', 'wholesale', 'retail', 'bakery', 'other'])
], async function(req, res) {
  try {
    var errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, errors: errors.array() });
    }

    /* 4 Nov 2026: registered by an Ajan from LajanMaker (agentPhone) → waits for Jennifer. A second call
       for the same account (an answer lost on a weak connection) gets ITS store back, never a second one. */
    var byAjan = !!req.body.agentPhone;
    if (byAjan) {
      var mine = await Store.findOne({ owner: req.user._id });
      if (mine) return res.status(200).json({ success: true, resumed: true, data: mine });
    }
    /* ...and a business waiting for (or refused by) Jennifer cannot open a second, public store around it */
    if (!byAjan) {
      var held = await Store.findOne({ owner: req.user._id }).select('+verification');
      if (held && merchantVerify.waiting(held)) return res.status(409).json({ success: false, error: 'store_waiting_verification',
        message: 'Your store is waiting for verification. It opens as soon as it is approved.' });
    }
    // Set user role to merchant if not already
    var user = await require('../models/User').findById(req.user._id);
    if (user.role === 'customer') {
      user.role = 'merchant';
      await user.save();
    }

    var store = await Store.create({
      owner: req.user._id,
      name: req.body.name,
      description: req.body.description || '',
      category: req.body.category,
      phone: req.body.phone || user.phone,
      email: req.body.email || user.email,
      address: req.body.address || {},
      logo: req.body.logo || '',
      coverImage: req.body.coverImage || '',
      deliveryOptions: req.body.deliveryOptions || {},
      /* Jeffery 4 Nov: "All NEW MyPlopPlop merchants must go through Jennifer's verification process,
         including those registering directly on myplopplop.com" - every new store waits */
      status: 'pending',
      isVerified: false,
      referralPartner: req.body.referralPartner || undefined
    });

    // Credit the LajanMaker agent who brought this merchant. A merchant can
    // arrive two ways - signing up straight from an agent's link, or as an
    // ordinary customer who opens a shop later - so the code is looked for
    // here as well as at sign-up. attachReferral() only writes one referral
    // per person, so doing it in both places cannot pay an agent twice.
    var agentCode = req.body.koutyeCode || req.body.agentCode || req.body.ref;
    /* From the LajanMaker POS: the Ajan who registered this shop, by phone. */
    if (!agentCode && req.body.agentPhone) agentCode = await referralService.koutyeCodeForPhone(req.body.agentPhone);
    /* every new store: waiting for Jennifer, with where it came from (agentCode is filled in below only when
       the Ajan credit was really attached - a typed code that does not exist credits nobody) */
    var pat = patenteInput(req.body.patente);
    var ver = { state: 'pending', source: byAjan ? 'lajanmaker' : 'website',
      agentPhone: byAjan ? String(req.body.agentPhone).slice(0, 32) : '', agentCode: '',
      history: [{ at: new Date(), by: byAjan ? 'ajan' : 'merchant', action: 'registered', note: byAjan ? 'LajanMaker' : 'myplopplop.com' }] };
    /* 4 Nov 2026 (PATENTE): "Èske biznis ou gen Patente?" - absent (LajanMaker 88) = not answered */
    if (pat) { ver.patente = { has: pat.has, number: pat.number, fy: pat.fy, state: pat.has === 'yes' ? 'pending' : 'none', at: new Date() };
      ver.history.push({ at: new Date(), by: byAjan ? 'ajan' : 'merchant', action: 'patente', note: pat.has === 'yes' ? 'Wi' + (pat.fy ? ' ' + pat.fy + '-' + (pat.fy + 1) : '') : 'Non' }); }
    if (req.body.patenteAssist === true || req.body.patenteAssist === 'yes') {
      ver.assist = { asked: true, at: new Date(), state: 'new' };
      ver.history.push({ at: new Date(), by: byAjan ? 'ajan' : 'merchant', action: 'assist', note: 'Mwen bezwen asistans (Patente)' });
    }
    await Store.updateOne({ _id: store._id }, { $set: { verification: ver } });
    var refResult = await referralService.attachReferral({
      code: agentCode,
      platform: 'myplopplop',
      entityType: 'merchant',
      user: req.user._id,
      name: store.name,
      phone: store.phone || user.phone,
      email: store.email || user.email,
      source: 'Store registration: ' + store.name
    });
    /* the Ajan credited for this business (first agent wins - may be an earlier agent than the code typed) */
    var credited = refResult && refResult.referral && refResult.referral.koutyeCode ? String(refResult.referral.koutyeCode).toUpperCase() : '';
    if (credited) await Store.updateOne({ _id: store._id }, { $set: { 'verification.agentCode': credited } });
    // Someone the agent signed up as a customer has now opened a shop. Same
    // referral, same 12 months - but the report should call them a merchant.
    if (!refResult.attached && refResult.reason === 'already_referred' && refResult.referral) {
      if (refResult.referral.referredEntity.type !== 'merchant') {
        refResult.referral.referredEntity.type = 'merchant';
        refResult.referral.referredEntity.name = store.name;
        await refResult.referral.save().catch(function () {});
      }
    }

    // Tell the office a real store just appeared, with the partner who sent them.
    try {
      require('../utils/notify').notifySignup('store', {
        storeName: store.name,
        name: user.name,
        phone: store.phone || user.phone,
        category: store.category,
        referralPartner: store.referralPartner || ''
      }).catch(function() {});
    } catch (e) { /* notification must never block a store being created */ }

    res.status(201).json({ success: true, data: store });
  } catch (err) {
    console.error('Create store error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ─── 4 Nov 2026: VERIFICATION PHOTOS (owner) ─── the storefront and the owner's ID, sent by LajanMaker with the
   merchant's own session right after registration (retried like the driver photos). Only while the store waits
   (pending / corrections asked). Stored privately in MerchantDocument - never on the store. */
var VDOC = ['storefront', 'owner_id'];
/* 4 Nov 2026 (PATENTE): the Patente / MSPP authorisation can also come LATER, from an approved store (🟡 → 🟢)
   or a store from before 4 Nov - never from one Jennifer rejected */
var LDOC = ['patente', 'mspp'];
function patenteInput(p) {
  if (!p || typeof p !== 'object') return null;
  var has = p.has === 'yes' || p.has === true ? 'yes' : p.has === 'no' || p.has === false ? 'no' : '';
  if (!has) return null;
  var cur = merchantVerify.fiscalStart(), fy = parseInt(p.fy, 10);
  if (!(fy >= cur - 15 && fy <= cur)) fy = undefined;
  var number = String(p.number || '').replace(/[^0-9A-Za-z\-\/ ]/g, '').trim().slice(0, 30);
  return { has: has, number: has === 'yes' ? number : '', fy: has === 'yes' ? fy : undefined };
}
router.post('/:id/verification-docs', protect, async function (req, res) {
  try {
    if (!/^[0-9a-fA-F]{24}$/.test(String(req.params.id))) return res.status(404).json({ success: false, message: 'Store not found' });
    var store = await Store.findById(req.params.id).select('+verification');
    if (!store) return res.status(404).json({ success: false, message: 'Store not found' });
    if (store.owner.toString() !== req.user._id.toString()) return res.status(403).json({ success: false, message: 'Not authorized' });
    var r = await saveVerificationDoc(store, req.body || {}, 'merchant');
    res.status(r.code).json(r.body);
  } catch (err) {
    console.error('verification doc error:', err.message);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});
async function saveVerificationDoc(store, b, by) {
  var v = store.verification || {};
  var type = String(b.type || ''), m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(b.image_data || ''));
  if (VDOC.indexOf(type) < 0 && LDOC.indexOf(type) < 0) return { code: 400, body: { success: false, error: 'bad_type' } };
  if (VDOC.indexOf(type) >= 0 ? ['pending', 'fix'].indexOf(v.state) < 0 : v.state === 'rejected') return { code: 409, body: { success: false, error: 'not_waiting' } };
  if (!m) return { code: 400, body: { success: false, error: 'bad_image' } };
  if (m[2].length > 7 * 1024 * 1024) return { code: 413, body: { success: false, error: 'too_large' } };
  await MerchantDocument.findOneAndUpdate({ store: store._id, type: type },
    { $set: { mime: m[1], data: m[2], size: Math.round(m[2].length * 0.75), by: by } }, { upsert: true, new: true, setDefaultsOnInsert: true });
  var fix = (v.fixDocs || []).filter(function (t) { return t !== type; });
  var set = { 'verification.fixDocs': fix };
  if (v.state === 'fix' && !fix.length) set['verification.state'] = 'pending';
  /* a new Patente photo is checked again by Jennifer (a 🟢 goes back to 🟡 until she does) */
  if (type === 'patente' && by.indexOf('console:') !== 0) { set['verification.patente.has'] = 'yes'; set['verification.patente.state'] = 'pending'; set['verification.patente.note'] = ''; }
  if (type === 'patente' && by.indexOf('console:') === 0 && !(v.patente && v.patente.state)) { set['verification.patente.has'] = 'yes'; set['verification.patente.state'] = 'pending'; }
  await Store.updateOne({ _id: store._id }, { $set: set, $push: { 'verification.history': { at: new Date(), by: by, action: 'document', note: type } } });
  if (type === 'patente') await merchantVerify.syncTrust(Store, store._id);
  return { code: 201, body: { success: true, type: type } };
}
router.saveVerificationDoc = saveVerificationDoc;

/* ─── 4 Nov 2026: the merchant's own verification status (dashboard / registration page) ─── */
router.get('/my/verification', protect, async function (req, res) {
  try {
    var st = await Store.findOne({ owner: req.user._id }).select('+verification');
    if (!st) return res.status(404).json({ success: false, error: 'no_store' });
    var v = st.verification || {};
    var docs = await MerchantDocument.find({ store: st._id }).select('type').lean();
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, storeId: String(st._id), name: st.name, status: st.status, slug: st.status === 'active' ? st.slug : '',
      state: v.state || (st.status === 'active' ? 'approved' : st.status), fix: v.fixDocs || [], note: v.state === 'fix' ? (v.fixNote || '') : '',
      reason: v.state === 'rejected' ? (v.reason || '') : '', docs: docs.map(function (d) { return d.type; }),
      category: st.category, patente: patenteView(v.patente), assist: !!(v.assist && v.assist.asked), trust: st.trust || null,
      licence: merchantVerify.LICENSED[st.category] || [], fiscalYears: merchantVerify.fiscalChoices() });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

function patenteView(p) {
  p = p || {};
  return { has: p.has || '', number: p.number || '', fy: p.fy || null, state: p.state || (p.has ? 'none' : ''),
    note: p.state === 'fix' ? (p.note || '') : '', fresh: merchantVerify.patenteFreshness(p.fy) };
}
router.patenteView = patenteView;
router.patenteInput = patenteInput;

/* ─── 4 Nov 2026 (PATENTE): the merchant answers / updates "Èske biznis ou gen Patente?" himself - from the
   registration page or later from his dashboard. Never "verified": only Jennifer does that. ─── */
router.post('/my/patente', protect, async function (req, res) {
  try {
    var st = await Store.findOne({ owner: req.user._id }).select('+verification');
    if (!st) return res.status(404).json({ success: false, error: 'no_store' });
    var v = st.verification || {};
    if (v.state === 'rejected') return res.status(409).json({ success: false, error: 'not_waiting' });
    var pat = patenteInput(req.body);
    if (!pat) return res.status(400).json({ success: false, error: 'has_required' });
    var old = v.patente || {};
    var same = old.has === pat.has && (old.number || '') === pat.number && (old.fy || null) === (pat.fy || null);
    if (same) return res.json({ success: true, patente: patenteView(old) });
    var np = { has: pat.has, number: pat.number, fy: pat.fy, state: pat.has === 'yes' ? 'pending' : 'none', note: '', at: new Date(), by: 'merchant' };
    await Store.updateOne({ _id: st._id }, { $set: { 'verification.patente': np },
      $push: { 'verification.history': { at: new Date(), by: 'merchant', action: 'patente', note: pat.has === 'yes' ? 'Wi' + (pat.number ? ' #' + pat.number : '') + (pat.fy ? ' ' + pat.fy + '-' + (pat.fy + 1) : '') : 'Non' } } });
    await merchantVerify.syncTrust(Store, st._id);
    res.json({ success: true, patente: patenteView(np) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});
/* "📋 Ou poko gen Patente? ... Mwen bezwen asistans" - a lead for Jennifer (once; asking again keeps the first) */
router.post('/my/patente-assist', protect, async function (req, res) {
  try {
    var st = await Store.findOne({ owner: req.user._id }).select('+verification');
    if (!st) return res.status(404).json({ success: false, error: 'no_store' });
    var a = (st.verification && st.verification.assist) || {};
    if (a.asked && a.state !== 'done') return res.json({ success: true, already: true });
    await Store.updateOne({ _id: st._id }, { $set: { 'verification.assist': { asked: true, at: new Date(), state: 'new' } },
      $push: { 'verification.history': { at: new Date(), by: 'merchant', action: 'assist', note: 'Mwen bezwen asistans (Patente)' } } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* ─── 4 Nov 2026: what became of the businesses THIS phone registered (public, by store id) ─── status words
   only: no name, phone or document. The public link only once the store is approved and active. */
router.post('/status-batch', async function (req, res) {
  try {
    var ids = ((req.body && req.body.ids) || []).map(String).filter(function (x) { return /^[0-9a-fA-F]{24}$/.test(x); }).slice(0, 100);
    if (!ids.length) return res.json({ stores: [] });
    var rows = await Store.find({ _id: { $in: ids } }).select('+verification status slug trust').lean();
    var docs = await MerchantDocument.find({ store: { $in: ids } }).select('store type').lean();
    res.set('Cache-Control', 'no-store');
    res.json({ stores: rows.map(function (x) { var v = x.verification || {};
      return { id: String(x._id), state: v.state || (x.status === 'active' ? 'approved' : x.status), status: x.status,
        fix: v.fixDocs || [], note: v.state === 'fix' ? (v.fixNote || '') : '', reason: v.state === 'rejected' ? (v.reason || '') : '',
        docs: docs.filter(function (d) { return String(d.store) === String(x._id); }).map(function (d) { return d.type; }),
        slug: x.status === 'active' ? x.slug : '', patente: v.patente ? { has: v.patente.has || '', state: v.patente.state || '' } : null,
        trust: x.trust ? x.trust.level : '' }; }) });
  } catch (err) {
    res.status(500).json({ error: 'server_error' });
  }
});

// ─── UPDATE STORE (owner only) ───
router.put('/:id', protect, async function(req, res) {
  try {
    var store = await Store.findById(req.params.id).select('+verification');
    if (!store) {
      return res.status(404).json({ success: false, message: 'Store not found' });
    }
    if (store.owner.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    var allowed = ['name', 'description', 'category', 'phone', 'email', 'address', 'openingHours', 'deliveryOptions', 'logo', 'coverImage', 'status'];
    /* 4 Nov 2026: a store waiting for Jennifer cannot switch itself on (or anything else) - only her approval does */
    if (merchantVerify.waiting(store)) allowed = allowed.filter(function (f) { return f !== 'status'; });
    /* 4 Nov 2026 (PATENTE): an open store cannot turn itself into a pharmacy without the Patente + MSPP
       authorisation Jennifer checked (a waiting store may: her approval checks it) */
    if (req.body.category !== undefined && req.body.category !== store.category && merchantVerify.LICENSED[req.body.category] && !merchantVerify.waiting(store)) {
      var have = (await MerchantDocument.find({ store: store._id }).select('type').lean()).map(function (d) { return d.type; });
      var miss = merchantVerify.licenceMissing(req.body.category, store.verification, have);
      if (miss.length) return res.status(409).json({ success: false, error: 'licence_required', missing: miss,
        message: 'A pharmacy needs a verified Patente and the MSPP authorisation first.' });
    }
    allowed.forEach(function(field) {
      if (req.body[field] !== undefined) store[field] = req.body[field];
    });

    // The partner who introduced the merchant is set once, at sign-up, and is
    // not something a later edit can quietly reassign.
    if (!store.referralPartner && req.body.referralPartner) {
      store.referralPartner = req.body.referralPartner;
    }

    await store.save();
    res.json({ success: true, data: store });
  } catch (err) {
    console.error('Update store error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── MERCHANT: GET MY STORE ───
router.get('/merchant/my-store', protect, async function(req, res) {
  try {
    var store = await Store.findOne({ owner: req.user._id });
    if (!store) {
      return res.status(404).json({ success: false, message: 'No store found' });
    }

    var products = await Product.find({ store: store._id }).sort('-createdAt');
    var recentOrders = await Order.find({ store: store._id })
      .populate('customer', 'name phone')
      .sort('-createdAt')
      .limit(20);

    res.json({
      success: true,
      data: {
        store: store,
        products: products,
        recentOrders: recentOrders.map(noPin)
      }
    });
  } catch (err) {
    console.error('Get my store error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── MERCHANT: THE PRICING, AND ACCEPTING IT (15 Oct 2026) ───
// Jeffery: "notify merchants and obtain acceptance of the revised pricing
// before applying it to their future sales." Shown in the merchant dashboard.
router.get('/merchant/pricing', protect, async function(req, res) {
  try {
    var store = await Store.findOne({ owner: req.user._id });
    if (!store) return res.status(404).json({ success: false, message: 'No store found' });
    res.json({ success: true, data: marketFees.pricingFor(store) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/merchant/pricing/accept', protect, async function(req, res) {
  try {
    if (marketFees.phase() === 'off') {
      return res.status(409).json({ success: false, message: 'There is no new pricing to accept.' });
    }
    var store = await Store.findOne({ owner: req.user._id });
    if (!store) return res.status(404).json({ success: false, message: 'No store found' });
    // Accepting exactly the wording on the screen: an older page cannot accept a newer version.
    if (String((req.body && req.body.version) || '') !== marketFees.pricingVersion()) {
      return res.status(409).json({ success: false, message: 'The pricing changed. Reload the page and read it again.' });
    }
    if (!marketFees.hasAccepted(store)) {
      store.pricingAcceptedVersion = marketFees.pricingVersion();
      store.pricingAcceptedAt = new Date();
      store.pricingAcceptedBy = req.user._id;
      await store.save();
      console.warn('[PRICING] ' + store.name + ' accepted pricing ' + store.pricingAcceptedVersion);
    }
    res.json({ success: true, data: marketFees.pricingFor(store) });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── MERCHANT: GET STORE ORDERS ───
router.get('/:id/orders', protect, async function(req, res) {
  try {
    var store = await Store.findById(req.params.id);
    if (!store) {
      return res.status(404).json({ success: false, message: 'Store not found' });
    }
    if (store.owner.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    var page = parseInt(req.query.page) || 1;
    var limit = parseInt(req.query.limit) || 20;
    var statusFilter = req.query.status;

    var query = { store: store._id };
    if (statusFilter) query.status = statusFilter;

    var orders = await Order.find(query)
      .populate('customer', 'name phone')
      .populate('rider', 'name phone')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(limit);

    var total = await Order.countDocuments(query);

    res.json({
      success: true,
      data: orders.map(noPin),
      pagination: { page: page, limit: limit, total: total }
    });
  } catch (err) {
    console.error('Get store orders error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── ADMIN: Activate all pending stores ───
router.patch('/admin/activate-all', protect, authorize('admin'), async function(req, res) {
  try {
    /* never the stores waiting for Jennifer's verification (4 Nov 2026) */
    var result = await Store.updateMany(Object.assign({ status: 'pending' }, merchantVerify.notWaiting), { $set: { status: 'active' } });
    res.json({ success: true, activated: result.modifiedCount || result.nModified || 0 });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ═══ PRODUCT MANAGEMENT ═══

// ─── ADD PRODUCT ───
router.post('/:storeId/products', protect, [
  body('name').trim().notEmpty(),
  body('price').isNumeric()
], async function(req, res) {
  try {
    var errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ success: false, message: 'Validation failed', errors: errors.array() });
    }
    var store = await Store.findById(req.params.storeId);
    if (!store) {
      return res.status(404).json({ success: false, message: 'Store not found' });
    }
    if (store.owner.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    var product = await Product.create({
      store: store._id,
      name: req.body.name,
      description: req.body.description || '',
      price: req.body.price,
      comparePrice: req.body.comparePrice,
      category: req.body.category || '',
      images: req.body.images || [],
      unit: req.body.unit || 'piece',
      stockQuantity: req.body.stockQuantity || -1,
      inStock: req.body.inStock !== false
    });

    store.stats.totalProducts += 1;
    await store.save();

    res.status(201).json({ success: true, data: product });
  } catch (err) {
    console.error('Add product error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── BULK ADD PRODUCTS ───
router.post('/:storeId/products/bulk', protect, async function(req, res) {
  try {
    var store = await Store.findById(req.params.storeId);
    if (!store) {
      return res.status(404).json({ success: false, message: 'Store not found' });
    }
    if (store.owner.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    var items = req.body.products;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'No products provided' });
    }

    // Delete existing products for this store first (full sync)
    await Product.deleteMany({ store: store._id });

    var created = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      if (!item.name || !item.name.trim()) continue;
      var product = await Product.create({
        store: store._id,
        name: item.name.trim(),
        description: item.description || '',
        price: parseFloat(item.price) || 0,
        category: item.category || 'Products',
        images: item.images || [],
        unit: item.unit || 'piece',
        inStock: true
      });
      created.push(product);
    }

    store.stats.totalProducts = created.length;
    await store.save();

    res.status(201).json({ success: true, data: created, count: created.length });
  } catch (err) {
    console.error('Bulk add products error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── UPDATE PRODUCT ───
router.put('/products/:productId', protect, async function(req, res) {
  try {
    var product = await Product.findById(req.params.productId);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    var store = await Store.findById(product.store);
    if (store.owner.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    var allowed = ['name', 'description', 'price', 'comparePrice', 'category', 'images', 'inStock', 'stockQuantity', 'unit', 'isActive', 'isFeatured'];
    allowed.forEach(function(field) {
      if (req.body[field] !== undefined) product[field] = req.body[field];
    });

    await product.save();
    res.json({ success: true, data: product });
  } catch (err) {
    console.error('Update product error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── DELETE PRODUCT ───
router.delete('/products/:productId', protect, async function(req, res) {
  try {
    var product = await Product.findById(req.params.productId);
    if (!product) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    var store = await Store.findById(product.store);
    if (store.owner.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    product.isActive = false;
    await product.save();

    store.stats.totalProducts = Math.max(0, store.stats.totalProducts - 1);
    await store.save();

    res.json({ success: true, message: 'Product removed' });
  } catch (err) {
    console.error('Delete product error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
