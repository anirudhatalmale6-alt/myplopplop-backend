// Odoo connector — merchant-facing configuration + sync control.
//
// A merchant (or an admin acting for them) points this at their Odoo instance
// once; after that their catalogue and prices keep themselves up to date and the
// CSV upload becomes optional.

const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const OdooConnection = require('../models/OdooConnection');
const Product = require('../models/Product');
const Store = require('../models/Store');
const odooSync = require('../services/odoo/odooSync');

// Fields a merchant is allowed to set. Anything else (state, stats, tokens) is
// ours and is not writable over the API.
const EDITABLE = [
  'label', 'isActive', 'baseUrl', 'database', 'username', 'apiKey', 'model',
  'extraDomain', 'categoryIds', 'onlySaleOk', 'syncImages', 'trackStock',
  'skipZeroPrice', 'deactivateMissing', 'priceField', 'pricelistId',
  'sourceCurrency', 'exchangeRateHTG', 'markupPercent', 'roundToHTG',
  'defaultCategory', 'categoryMap', 'syncIntervalMinutes'
];

async function loadStore(req, res) {
  const store = await Store.findById(req.params.storeId);
  if (!store) {
    res.status(404).json({ success: false, message: 'Store not found' });
    return null;
  }
  if (store.owner.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
    res.status(403).json({ success: false, message: 'Not authorized for this store' });
    return null;
  }
  return store;
}

async function loadConnection(req, res, opts) {
  const store = await loadStore(req, res);
  if (!store) return null;

  let conn = await OdooConnection.findOne({ store: store._id });
  if (!conn) {
    if (opts && opts.create) {
      conn = new OdooConnection({ store: store._id, label: store.name + ' — Odoo' });
    } else {
      res.status(404).json({ success: false, message: 'No Odoo connection configured for this store' });
      return null;
    }
  }
  return conn;
}

function fail(res, err, fallback) {
  console.error('Odoo route error:', err);
  res.status(400).json({ success: false, message: err.message || fallback || 'Server error' });
}

// ─── Configuration ───────────────────────────────────────────────────────────

router.get('/:storeId/config', protect, async (req, res) => {
  try {
    const conn = await loadConnection(req, res, { create: false });
    if (!conn) return;
    res.json({ success: true, data: conn.toSafeJSON() });
  } catch (err) { fail(res, err); }
});

router.put('/:storeId/config', protect, async (req, res) => {
  try {
    const conn = await loadConnection(req, res, { create: true });
    if (!conn) return;

    EDITABLE.forEach((field) => {
      if (req.body[field] === undefined) return;
      // Blank apiKey means "leave the stored one alone" — the GET only ever
      // returns a masked value, so a round-trip must not wipe it.
      if (field === 'apiKey' && !String(req.body[field]).trim()) return;
      conn[field] = req.body[field];
    });

    if (conn.baseUrl) conn.baseUrl = String(conn.baseUrl).trim().replace(/\/+$/, '');

    await conn.save();
    res.json({ success: true, data: conn.toSafeJSON() });
  } catch (err) { fail(res, err); }
});

router.delete('/:storeId/config', protect, async (req, res) => {
  try {
    const store = await loadStore(req, res);
    if (!store) return;
    await OdooConnection.deleteOne({ store: store._id });
    res.json({ success: true, message: 'Odoo connection removed. Products already imported are untouched.' });
  } catch (err) { fail(res, err); }
});

// ─── Connection test — dry run, writes nothing ───────────────────────────────
// Returns 5 real products with the price we would publish beside the price Odoo
// holds, so a merchant can confirm the mapping before anything goes live.
router.post('/:storeId/test', protect, async (req, res) => {
  try {
    const conn = await loadConnection(req, res, { create: false });
    if (!conn) return;
    const result = await odooSync.testConnection(conn);
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.get('/:storeId/odoo-categories', protect, async (req, res) => {
  try {
    const conn = await loadConnection(req, res, { create: false });
    if (!conn) return;
    const cats = await odooSync.listOdooCategories(conn);
    res.json({ success: true, data: cats });
  } catch (err) { fail(res, err); }
});

// ─── Sync ────────────────────────────────────────────────────────────────────

router.post('/:storeId/sync', protect, async (req, res) => {
  try {
    const conn = await loadConnection(req, res, { create: false });
    if (!conn) return;
    if (conn.status === 'running') {
      return res.status(409).json({ success: false, message: 'A sync is already running for this store' });
    }
    const mode = req.query.mode === 'incremental' ? 'incremental' : 'full';
    const result = await odooSync.runSync(conn, { mode });
    res.json({ success: true, data: result });
  } catch (err) {
    res.status(400).json({ success: false, message: err.message });
  }
});

router.get('/:storeId/status', protect, async (req, res) => {
  try {
    const conn = await loadConnection(req, res, { create: false });
    if (!conn) return;
    const [synced, active] = await Promise.all([
      Product.countDocuments({ store: conn.store, source: 'odoo' }),
      Product.countDocuments({ store: conn.store, source: 'odoo', isActive: true })
    ]);
    res.json({
      success: true,
      data: {
        isActive: conn.isActive,
        status: conn.status,
        lastError: conn.lastError,
        lastRunAt: conn.lastRunAt,
        lastFullSyncAt: conn.lastFullSyncAt,
        syncIntervalMinutes: conn.syncIntervalMinutes,
        productsFromOdoo: synced,
        productsLive: active,
        stats: conn.stats,
        history: conn.history
      }
    });
  } catch (err) { fail(res, err); }
});

// ─── Push from Odoo ──────────────────────────────────────────────────────────
// An Odoo automated action calls this when a product is written, so a price edit
// shows up on MyPlopPlop in seconds instead of at the next scheduled tick.
// Authenticated by the per-store webhook token, not a user session.
router.post('/hook/:storeId', async (req, res) => {
  try {
    const token = req.headers['x-mpp-odoo-token'] || req.query.token;
    const conn = await OdooConnection.findOne({ store: req.params.storeId });
    if (!conn || !token || token !== conn.webhookToken) {
      return res.status(401).json({ success: false, message: 'Invalid token' });
    }
    if (!conn.isActive) {
      return res.status(409).json({ success: false, message: 'Connection is not active' });
    }

    const raw = req.body && req.body.ids;
    const ids = Array.isArray(raw) ? raw.map(Number).filter(n => n > 0) : [];
    if (!ids.length) {
      return res.status(400).json({ success: false, message: 'Send {"ids": [1,2,3]} with the Odoo product ids that changed' });
    }
    if (ids.length > 500) {
      return res.status(400).json({ success: false, message: 'Send at most 500 ids per call' });
    }

    // Answer immediately — Odoo automated actions run inside the user's own
    // transaction and must not be held open while we pull records back.
    res.json({ success: true, queued: ids.length });

    odooSync.runSync(conn, { mode: 'webhook', ids })
      .then(r => console.log('Odoo webhook sync store ' + conn.store + ': +' + r.created + ' / ~' + r.updated))
      .catch(e => console.error('Odoo webhook sync failed:', e.message));
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Server error' });
  }
});

// The token is shown once, to the store owner, so they can paste it into Odoo.
router.get('/:storeId/webhook', protect, async (req, res) => {
  try {
    const conn = await loadConnection(req, res, { create: false });
    if (!conn) return;
    const base = (process.env.PUBLIC_API_URL || '').replace(/\/+$/, '');
    res.json({
      success: true,
      data: {
        url: base + '/api/odoo/hook/' + conn.store,
        header: 'x-mpp-odoo-token',
        token: conn.webhookToken
      }
    });
  } catch (err) { fail(res, err); }
});

module.exports = router;
