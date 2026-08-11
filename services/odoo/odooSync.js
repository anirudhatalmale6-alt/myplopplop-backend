// Odoo → MyPlopPlop catalogue sync.
//
// Replaces the CSV upload for merchants running Odoo. Three ways in:
//   full        — read everything, and deactivate what vanished from Odoo
//   incremental — only records whose write_date moved since the last run (cheap,
//                 which is what makes a 30-minute price refresh practical)
//   webhook     — Odoo pushes the ids it just changed, so a price edit lands in
//                 seconds instead of waiting for the next tick
//
// Nothing here writes back to Odoo. We only ever read.

const fs = require('fs');
const path = require('path');
const { OdooClient } = require('./odooClient');
const OdooConnection = require('../../models/OdooConnection');
const Product = require('../../models/Product');
const Store = require('../../models/Store');

const BATCH_SIZE = 200;
const MAX_HISTORY = 20;

const BASE_FIELDS = [
  'name', 'default_code', 'barcode', 'list_price', 'standard_price',
  'description_sale', 'categ_id', 'uom_id', 'write_date', 'active', 'sale_ok',
  'qty_available', 'currency_id'
];

function clientFor(conn) {
  return new OdooClient({
    baseUrl: conn.baseUrl,
    database: conn.database,
    username: conn.username,
    apiKey: conn.apiKey
  });
}

function parseExtraDomain(raw) {
  if (!raw || !String(raw).trim()) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('Extra domain is not valid JSON: ' + e.message);
  }
  if (!Array.isArray(parsed)) throw new Error('Extra domain must be a JSON array, e.g. [["categ_id","child_of",12]]');
  return parsed;
}

function buildDomain(conn, opts) {
  const domain = [];
  if (opts && Array.isArray(opts.ids) && opts.ids.length) {
    domain.push(['id', 'in', opts.ids]);
    return domain; // an explicit id list overrides every other filter
  }
  if (conn.onlySaleOk) domain.push(['sale_ok', '=', true]);
  if (conn.categoryIds && conn.categoryIds.length) domain.push(['categ_id', 'child_of', conn.categoryIds]);
  if (opts && opts.since) domain.push(['write_date', '>', opts.since]);
  return domain.concat(parseExtraDomain(conn.extraDomain));
}

function m2oName(value) {
  return Array.isArray(value) && value.length > 1 ? String(value[1]) : '';
}
function m2oId(value) {
  return Array.isArray(value) && value.length ? Number(value[0]) : 0;
}

// ─── Pricelist support ───────────────────────────────────────────────────────
// Best-effort: Odoo pricelists can compute prices in ways that only Odoo itself
// can resolve (quantity breaks, partner rules, formulas over other pricelists).
// We honour the common cases — fixed price, percentage, and simple formula — and
// fall back to the product's own price when no rule matches.
async function loadPricelistRules(client, pricelistId) {
  if (!pricelistId) return null;
  const items = await client.searchRead('product.pricelist.item',
    [['pricelist_id', '=', Number(pricelistId)]],
    ['applied_on', 'product_tmpl_id', 'product_id', 'categ_id', 'compute_price',
      'fixed_price', 'percent_price', 'price_discount', 'price_surcharge',
      'min_quantity', 'date_start', 'date_end'],
    { limit: 5000, order: 'applied_on asc' });

  const now = new Date();
  const active = items.filter((it) => {
    if (it.min_quantity && it.min_quantity > 1) return false;
    if (it.date_start && new Date(it.date_start) > now) return false;
    if (it.date_end && new Date(it.date_end) < now) return false;
    return true;
  });

  return {
    byVariant: new Map(active.filter(i => i.applied_on === '0_product_variant').map(i => [m2oId(i.product_id), i])),
    byTemplate: new Map(active.filter(i => i.applied_on === '1_product').map(i => [m2oId(i.product_tmpl_id), i])),
    byCategory: new Map(active.filter(i => i.applied_on === '2_product_category').map(i => [m2oId(i.categ_id), i])),
    global: active.find(i => i.applied_on === '3_global') || null
  };
}

function applyRule(rule, basePrice) {
  if (!rule) return basePrice;
  switch (rule.compute_price) {
    case 'fixed':
      return Number(rule.fixed_price) || 0;
    case 'percentage':
      return basePrice * (1 - (Number(rule.percent_price) || 0) / 100);
    case 'formula':
      return basePrice * (1 - (Number(rule.price_discount) || 0) / 100) + (Number(rule.price_surcharge) || 0);
    default:
      return basePrice;
  }
}

function pricelistPrice(rules, rec, model, basePrice) {
  if (!rules) return basePrice;
  const templateId = model === 'product.product' ? m2oId(rec.product_tmpl_id) : rec.id;
  const rule =
    (model === 'product.product' && rules.byVariant.get(rec.id)) ||
    rules.byTemplate.get(templateId) ||
    rules.byCategory.get(m2oId(rec.categ_id)) ||
    rules.global;
  return applyRule(rule, basePrice);
}

// ─── Mapping ─────────────────────────────────────────────────────────────────
function resolvePrice(conn, rec, rules) {
  const base = Number(rec[conn.priceField] || rec.list_price || 0);
  const listed = pricelistPrice(rules, rec, conn.model, base);
  const withMarkup = listed * (1 + (Number(conn.markupPercent) || 0) / 100);
  const htg = String(conn.sourceCurrency).toUpperCase() === 'HTG'
    ? withMarkup
    : withMarkup * (Number(conn.exchangeRateHTG) || 1);

  const step = Number(conn.roundToHTG) || 0;
  if (step > 0) return Math.round(htg / step) * step;
  return Math.round(htg * 100) / 100;
}

function resolveCategory(conn, rec) {
  const odooCat = m2oName(rec.categ_id);
  const map = conn.categoryMap || {};
  if (odooCat && map[odooCat]) return map[odooCat];
  // "All / Saleable / Beverages" — try the leaf too, that is what merchants type
  const leaf = odooCat.split('/').map(s => s.trim()).filter(Boolean).pop();
  if (leaf && map[leaf]) return map[leaf];
  if (leaf) return leaf.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return conn.defaultCategory || 'general';
}

function mapProduct(conn, rec, rules) {
  const sku = String(rec.default_code || rec.barcode || '').trim();
  const qty = rec.qty_available === undefined ? null : Math.floor(Number(rec.qty_available) || 0);

  const doc = {
    name: String(rec.name || '').trim().slice(0, 200),
    price: resolvePrice(conn, rec, rules),
    currency: 'HTG',
    category: resolveCategory(conn, rec),
    unit: (m2oName(rec.uom_id) || 'piece').toLowerCase().slice(0, 30),
    sku: sku,
    externalId: String(rec.id),
    source: 'odoo',
    lastSyncedAt: new Date()
  };

  const desc = String(rec.description_sale || '').trim();
  if (desc) doc.description = desc.slice(0, 1000);

  if (conn.trackStock && qty !== null) {
    doc.stockQuantity = qty;
    doc.inStock = qty > 0;
  } else {
    doc.stockQuantity = -1;
    doc.inStock = rec.active === false ? false : true;
  }

  return doc;
}

// ─── Images ──────────────────────────────────────────────────────────────────
// Odoo hands images back as base64 on the record. We drop them on disk under
// /uploads so the storefront gets a plain URL. Only fetched for products that
// do not have an image yet — image_512 is ~50–150 KB a piece and there is no
// point re-pulling them on every price refresh.
async function fetchImages(client, conn, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const recs = await client.read(conn.model, ids, ['image_512']);
  const dir = path.join(__dirname, '..', '..', 'uploads', 'odoo', String(conn.store));
  fs.mkdirSync(dir, { recursive: true });
  const base = (process.env.PUBLIC_API_URL || '').replace(/\/+$/, '');

  recs.forEach((rec) => {
    if (!rec.image_512) return;
    const file = String(rec.id) + '.jpg';
    try {
      fs.writeFileSync(path.join(dir, file), Buffer.from(rec.image_512, 'base64'));
      out.set(String(rec.id), base + '/uploads/odoo/' + conn.store + '/' + file);
    } catch (e) {
      console.error('Odoo image write failed for', rec.id, e.message);
    }
  });
  return out;
}

// ─── Upsert ──────────────────────────────────────────────────────────────────
// Match on the Odoo id first, then the SKU, then the exact name — so a merchant
// who already uploaded a CSV gets their rows adopted rather than duplicated.
async function findExisting(storeId, doc) {
  let found = await Product.findOne({ store: storeId, source: 'odoo', externalId: doc.externalId });
  if (found) return found;
  if (doc.sku) {
    found = await Product.findOne({ store: storeId, sku: doc.sku });
    if (found) return found;
  }
  return Product.findOne({ store: storeId, name: doc.name });
}

async function upsertBatch(conn, records, rules, imageUrls) {
  const result = { created: 0, updated: 0, skipped: 0 };

  for (const rec of records) {
    if (!rec.name) { result.skipped++; continue; }

    const doc = mapProduct(conn, rec, rules);

    if (conn.skipZeroPrice && !(doc.price > 0)) { result.skipped++; continue; }

    const image = imageUrls && imageUrls.get(String(rec.id));
    const existing = await findExisting(conn.store, doc);

    if (existing) {
      const update = Object.assign({}, doc, { isActive: rec.active === false ? false : true });
      // Do not wipe an image the merchant set by hand in our dashboard
      if (image && (!existing.images || !existing.images.length)) update.images = [image];
      await Product.updateOne({ _id: existing._id }, { $set: update });
      result.updated++;
    } else {
      await Product.create(Object.assign({}, doc, {
        store: conn.store,
        images: image ? [image] : [],
        isActive: rec.active === false ? false : true
      }));
      result.created++;
    }
  }

  return result;
}

// ─── Public operations ───────────────────────────────────────────────────────

async function testConnection(conn) {
  const client = clientFor(conn);
  const version = await client.version();
  const uid = await client.authenticate();
  const domain = buildDomain(conn, {});
  const count = await client.searchCount(conn.model, domain);
  const fields = await client.availableFields(conn.model, BASE_FIELDS);
  const rules = await loadPricelistRules(client, conn.pricelistId);
  const sample = await client.searchRead(conn.model, domain, fields, { limit: 5, order: 'write_date desc' });

  return {
    serverVersion: (version && version.server_version) || 'unknown',
    uid,
    model: conn.model,
    matchingProducts: count,
    missingFields: BASE_FIELDS.filter(f => !fields.includes(f)),
    pricelistRules: rules ? true : false,
    sample: sample.map((rec) => ({
      odooId: rec.id,
      name: rec.name,
      sku: rec.default_code || rec.barcode || '',
      odooPrice: Number(rec[conn.priceField] || rec.list_price || 0),
      odooCategory: m2oName(rec.categ_id),
      stock: rec.qty_available,
      myplopplopPrice: resolvePrice(conn, rec, rules),
      myplopplopCategory: resolveCategory(conn, rec)
    }))
  };
}

async function listOdooCategories(conn) {
  const client = clientFor(conn);
  const cats = await client.searchRead('product.category', [], ['complete_name'], { limit: 500, order: 'complete_name asc' });
  return cats.map(c => ({ id: c.id, name: c.complete_name }));
}

// mode: 'full' | 'incremental' | 'webhook'
async function runSync(conn, options) {
  const opts = options || {};
  const mode = opts.mode || 'incremental';
  const startedAt = Date.now();

  conn.status = 'running';
  await conn.save();

  const totals = { created: 0, updated: 0, skipped: 0, deactivated: 0 };
  let highWaterMark = conn.lastWriteDate || '';

  try {
    const client = clientFor(conn);
    await client.authenticate();

    const fields = await client.availableFields(conn.model, BASE_FIELDS);
    if (!fields.includes('name')) throw new Error('This Odoo user cannot read ' + conn.model + ' — give the integration user read access to Sales / Inventory.');
    if (conn.model === 'product.product' && !fields.includes('product_tmpl_id')) fields.push('product_tmpl_id');

    const rules = await loadPricelistRules(client, conn.pricelistId);

    const domain = buildDomain(conn, {
      ids: opts.ids,
      since: mode === 'incremental' && conn.lastWriteDate ? conn.lastWriteDate : null
    });

    const seenIds = [];
    let offset = 0;

    for (;;) {
      const batch = await client.searchRead(conn.model, domain, fields, {
        limit: BATCH_SIZE, offset, order: 'id asc'
      });
      if (!batch.length) break;

      batch.forEach((rec) => {
        seenIds.push(String(rec.id));
        if (rec.write_date && rec.write_date > highWaterMark) highWaterMark = rec.write_date;
      });

      let imageUrls = null;
      if (conn.syncImages) {
        const known = await Product.find({
          store: conn.store,
          externalId: { $in: batch.map(r => String(r.id)) },
          images: { $exists: true, $ne: [] }
        }).select('externalId').lean();
        const haveImage = new Set(known.map(p => p.externalId));
        const need = batch.filter(r => !haveImage.has(String(r.id))).map(r => r.id);
        imageUrls = await fetchImages(client, conn, need);
      }

      const res = await upsertBatch(conn, batch, rules, imageUrls);
      totals.created += res.created;
      totals.updated += res.updated;
      totals.skipped += res.skipped;

      if (batch.length < BATCH_SIZE) break;
      offset += BATCH_SIZE;
    }

    // Only a full sweep knows what is genuinely gone from Odoo.
    if (mode === 'full' && conn.deactivateMissing) {
      const gone = await Product.updateMany({
        store: conn.store,
        source: 'odoo',
        isActive: true,
        externalId: { $nin: seenIds }
      }, { $set: { isActive: false, inStock: false } });
      totals.deactivated = gone.modifiedCount || 0;
    }

    await Store.findByIdAndUpdate(conn.store, {
      'stats.totalProducts': await Product.countDocuments({ store: conn.store, isActive: true })
    });

    conn.status = 'ok';
    conn.lastError = '';
    conn.lastRunAt = new Date();
    if (mode === 'full') conn.lastFullSyncAt = new Date();
    if (highWaterMark) conn.lastWriteDate = highWaterMark;
    conn.stats.created += totals.created;
    conn.stats.updated += totals.updated;
    conn.stats.deactivated += totals.deactivated;
    conn.stats.totalSynced = await Product.countDocuments({ store: conn.store, source: 'odoo' });

    conn.history.unshift({
      at: new Date(), mode,
      created: totals.created, updated: totals.updated,
      deactivated: totals.deactivated, skipped: totals.skipped,
      durationMs: Date.now() - startedAt, ok: true, message: ''
    });
    conn.history = conn.history.slice(0, MAX_HISTORY);
    await conn.save();

    return Object.assign({ ok: true, mode, durationMs: Date.now() - startedAt }, totals);
  } catch (err) {
    conn.status = 'error';
    conn.lastError = err.message;
    conn.lastRunAt = new Date();
    conn.history.unshift({
      at: new Date(), mode,
      created: totals.created, updated: totals.updated,
      deactivated: totals.deactivated, skipped: totals.skipped,
      durationMs: Date.now() - startedAt, ok: false, message: err.message
    });
    conn.history = conn.history.slice(0, MAX_HISTORY);
    await conn.save();
    throw err;
  }
}

// Ticker: run every due connection. Called from server.js.
async function tick() {
  const now = Date.now();
  const connections = await OdooConnection.find({ isActive: true });

  for (const conn of connections) {
    if (conn.status === 'running') continue;
    const interval = Math.max(5, Number(conn.syncIntervalMinutes) || 30) * 60 * 1000;
    const due = !conn.lastRunAt || (now - new Date(conn.lastRunAt).getTime()) >= interval;
    if (!due) continue;

    // A first run, or a daily sweep, has to be full — that is the only mode that
    // notices products deleted or archived in Odoo.
    const lastFull = conn.lastFullSyncAt ? new Date(conn.lastFullSyncAt).getTime() : 0;
    const mode = (!lastFull || (now - lastFull) > 24 * 60 * 60 * 1000) ? 'full' : 'incremental';

    try {
      const res = await runSync(conn, { mode });
      console.log('Odoo sync (' + mode + ') store ' + conn.store + ': +' + res.created + ' new, ' + res.updated + ' updated');
    } catch (err) {
      console.error('Odoo sync failed for store ' + conn.store + ':', err.message);
    }
  }
}

module.exports = {
  testConnection,
  listOdooCategories,
  runSync,
  tick,
  mapProduct,
  resolvePrice,
  buildDomain,
  BASE_FIELDS
};
