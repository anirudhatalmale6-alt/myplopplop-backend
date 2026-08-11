// End-to-end test for the Odoo connector.
//
// Runs the real sync engine against a stand-in Odoo that speaks the same
// JSON-RPC dialect, on an in-memory MongoDB. No external services, no real
// credentials — `node scripts/test-odoo-sync.js`.

const http = require('http');
const assert = require('assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const OdooConnection = require('../models/OdooConnection');
const Product = require('../models/Product');
const Store = require('../models/Store');
const User = require('../models/User');
const odooSync = require('../services/odoo/odooSync');

// ─── Stand-in Odoo ───────────────────────────────────────────────────────────

const DB = 'msc_prod';
const LOGIN = 'myplopplop@msc.example';
const API_KEY = 'test-api-key-123';

let templates = [
  { id: 11, name: 'Diri Blan 5 lb', default_code: 'DIRI-5', barcode: '', list_price: 150, standard_price: 100, description_sale: 'Sak diri blan', categ_id: [3, 'All / Saleable / Grocery'], uom_id: [1, 'Units'], write_date: '2026-08-10 09:00:00', active: true, sale_ok: true, qty_available: 40, currency_id: [1, 'HTG'] },
  { id: 12, name: 'Luil Kwit Manje 1 L', default_code: 'LUIL-1L', barcode: '', list_price: 250, standard_price: 190, description_sale: '', categ_id: [3, 'All / Saleable / Grocery'], uom_id: [1, 'Units'], write_date: '2026-08-10 09:05:00', active: true, sale_ok: true, qty_available: 0, currency_id: [1, 'HTG'] },
  { id: 13, name: 'Livrezon Ekspre', default_code: 'SRV-EXP', barcode: '', list_price: 0, standard_price: 0, description_sale: '', categ_id: [5, 'All / Services'], uom_id: [1, 'Units'], write_date: '2026-08-10 09:06:00', active: true, sale_ok: true, qty_available: 0, currency_id: [1, 'HTG'] },
  { id: 14, name: 'Konsèy Entèn', default_code: 'INT-1', barcode: '', list_price: 500, standard_price: 400, description_sale: '', categ_id: [3, 'All / Saleable / Grocery'], uom_id: [1, 'Units'], write_date: '2026-08-10 09:07:00', active: true, sale_ok: false, qty_available: 5, currency_id: [1, 'HTG'] }
];

const FIELD_TYPES = {};
odooSync.BASE_FIELDS.forEach((f) => { FIELD_TYPES[f] = { type: 'char' }; });

function matches(rec, domain) {
  return domain.every(([field, op, value]) => {
    const actual = field === 'categ_id' ? (rec.categ_id && rec.categ_id[0]) : rec[field];
    switch (op) {
      case '=': return actual === value;
      case '!=': return actual !== value;
      case '>': return String(actual) > String(value);
      case 'in': return [].concat(value).includes(actual);
      case 'not in': return ![].concat(value).includes(actual);
      case 'child_of': return [].concat(value).includes(actual);
      default: throw new Error('mock Odoo: unsupported operator ' + op);
    }
  });
}

function pick(rec, fields) {
  const out = { id: rec.id };
  fields.forEach((f) => { if (rec[f] !== undefined) out[f] = rec[f]; });
  return out;
}

function handleExecuteKw(args) {
  const [db, uid, key, model, method, params, kwargs = {}] = args;
  assert.strictEqual(db, DB, 'mock Odoo: wrong database');
  assert.strictEqual(key, API_KEY, 'mock Odoo: wrong api key');
  assert.ok(uid > 0, 'mock Odoo: missing uid');

  if (model === 'product.category' && method === 'search_read') {
    return [{ id: 3, complete_name: 'All / Saleable / Grocery' }, { id: 5, complete_name: 'All / Services' }];
  }
  if (model === 'product.pricelist.item' && method === 'search_read') {
    return [];
  }

  assert.strictEqual(model, 'product.template', 'mock Odoo: unexpected model ' + model);

  if (method === 'fields_get') {
    const requested = params[0] || [];
    const out = {};
    requested.forEach((f) => { if (FIELD_TYPES[f]) out[f] = FIELD_TYPES[f]; });
    return out;
  }
  if (method === 'search_count') {
    return templates.filter(r => matches(r, params[0] || [])).length;
  }
  if (method === 'search_read') {
    const hits = templates.filter(r => matches(r, params[0] || []));
    const offset = kwargs.offset || 0;
    const limit = kwargs.limit || hits.length;
    return hits.slice(offset, offset + limit).map(r => pick(r, kwargs.fields || []));
  }
  if (method === 'read') {
    const ids = params[0] || [];
    return templates.filter(r => ids.includes(r.id)).map(r => pick(r, params[1] || []));
  }
  throw new Error('mock Odoo: unsupported method ' + method);
}

function startMockOdoo() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      const { service, method, args } = payload.params;
      let result;
      try {
        if (service === 'common' && method === 'version') {
          result = { server_version: '19.0+e', server_serie: '19.0' };
        } else if (service === 'common' && method === 'authenticate') {
          result = (args[0] === DB && args[1] === LOGIN && args[2] === API_KEY) ? 7 : false;
        } else if (service === 'object' && method === 'execute_kw') {
          result = handleExecuteKw(args);
        } else {
          throw new Error('mock Odoo: unsupported service ' + service + '.' + method);
        }
      } catch (err) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, error: { message: 'Odoo Server Error', data: { name: 'MockError', message: err.message } } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: payload.id, result }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ─── Test run ────────────────────────────────────────────────────────────────

async function main() {
  const { server, port } = await startMockOdoo();
  const mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());

  const checks = [];
  const check = (label, fn) => {
    try { fn(); checks.push('  PASS  ' + label); }
    catch (e) { checks.push('  FAIL  ' + label + ' — ' + e.message); process.exitCode = 1; }
  };

  const owner = await User.create({ name: 'MSC Xpress', phone: '+50900000000', password: 'test1234', role: 'merchant' });
  const store = await Store.create({ owner: owner._id, name: 'MSC Xpress', category: 'wholesale' });

  // A row the merchant had already uploaded by CSV — the sync must adopt it,
  // not create a duplicate.
  await Product.create({ store: store._id, name: 'Diri Blan 5 lb', price: 130, source: 'csv', sku: 'DIRI-5' });

  const conn = await OdooConnection.create({
    store: store._id,
    label: 'MSC Xpress — Odoo 19 EE',
    isActive: true,
    baseUrl: 'http://127.0.0.1:' + port,
    database: DB,
    username: LOGIN,
    apiKey: API_KEY,
    sourceCurrency: 'HTG',
    markupPercent: 10,
    roundToHTG: 5,
    categoryMap: { 'All / Saleable / Grocery': 'grocery' }
  });

  // 1 ─ connection test
  const t = await odooSync.testConnection(conn);
  check('reports the Odoo server version', () => assert.strictEqual(t.serverVersion, '19.0+e'));
  check('counts only sellable products (sale_ok)', () => assert.strictEqual(t.matchingProducts, 3));
  check('preview maps 150 HTG +10% to 165 HTG', () => {
    const diri = t.sample.find(s => s.sku === 'DIRI-5');
    assert.strictEqual(diri.myplopplopPrice, 165);
    assert.strictEqual(diri.myplopplopCategory, 'grocery');
  });
  check('no fields missing on this instance', () => assert.deepStrictEqual(t.missingFields, []));

  // 2 ─ full sync
  const full = await odooSync.runSync(conn, { mode: 'full' });
  check('full sync skips the zero-priced service line', () => assert.strictEqual(full.skipped, 1));
  check('full sync adopts the CSV row instead of duplicating', () => assert.strictEqual(full.updated, 1));
  check('full sync creates the remaining product', () => assert.strictEqual(full.created, 1));

  const diri = await Product.findOne({ store: store._id, sku: 'DIRI-5' });
  check('adopted row now carries the Odoo price', () => assert.strictEqual(diri.price, 165));
  check('adopted row is flagged as Odoo-sourced', () => {
    assert.strictEqual(diri.source, 'odoo');
    assert.strictEqual(diri.externalId, '11');
  });
  const dupCount = await Product.countDocuments({ store: store._id, sku: 'DIRI-5' });
  check('no duplicate was created', () => assert.strictEqual(dupCount, 1));

  const luil = await Product.findOne({ store: store._id, sku: 'LUIL-1L' });
  check('zero stock marks the product out of stock', () => {
    assert.strictEqual(luil.stockQuantity, 0);
    assert.strictEqual(luil.inStock, false);
  });

  // 3 ─ incremental sync picks up only what changed
  templates = templates.map(r => r.id === 11
    ? Object.assign({}, r, { list_price: 200, write_date: '2026-08-11 12:00:00' })
    : r);

  const inc = await odooSync.runSync(conn, { mode: 'incremental' });
  check('incremental sync touches exactly the changed product', () => {
    assert.strictEqual(inc.updated, 1);
    assert.strictEqual(inc.created, 0);
  });
  const repriced = await Product.findOne({ store: store._id, sku: 'DIRI-5' });
  check('new Odoo price 200 lands as 220 HTG (+10%)', () => assert.strictEqual(repriced.price, 220));

  const noop = await odooSync.runSync(conn, { mode: 'incremental' });
  check('a second incremental run with no changes does nothing', () => {
    assert.strictEqual(noop.updated, 0);
    assert.strictEqual(noop.created, 0);
  });

  // 4 ─ webhook push for a single id
  templates = templates.map(r => r.id === 12
    ? Object.assign({}, r, { list_price: 300, qty_available: 12, write_date: '2026-08-11 12:30:00' })
    : r);
  const hook = await odooSync.runSync(conn, { mode: 'webhook', ids: [12] });
  check('webhook sync updates just the pushed id', () => assert.strictEqual(hook.updated, 1));
  const restocked = await Product.findOne({ store: store._id, sku: 'LUIL-1L' });
  check('webhook applies price and stock', () => {
    assert.strictEqual(restocked.price, 330);
    assert.strictEqual(restocked.inStock, true);
  });

  // 5 ─ product archived in Odoo disappears from the storefront on a full sweep
  templates = templates.filter(r => r.id !== 12);
  const sweep = await odooSync.runSync(conn, { mode: 'full' });
  check('full sweep deactivates products removed from Odoo', () => assert.strictEqual(sweep.deactivated, 1));
  const gone = await Product.findOne({ store: store._id, sku: 'LUIL-1L' });
  check('removed product is hidden, not deleted', () => {
    assert.strictEqual(gone.isActive, false);
    assert.ok(gone._id);
  });

  // 6 ─ credentials never leave the API
  const safe = (await OdooConnection.findById(conn._id)).toSafeJSON();
  check('API key is masked in API responses', () => {
    assert.ok(!safe.apiKey.includes(API_KEY));
    assert.strictEqual(safe.hasApiKey, true);
  });

  // 7 ─ a wrong key fails loudly instead of silently syncing nothing
  const bad = await OdooConnection.findById(conn._id);
  bad.apiKey = 'wrong-key';
  let errMsg = '';
  try { await odooSync.testConnection(bad); } catch (e) { errMsg = e.message; }
  check('a bad API key produces a readable error', () => assert.ok(/rejected the login/i.test(errMsg), errMsg));

  console.log('\nOdoo connector test\n' + checks.join('\n') + '\n');
  console.log(process.exitCode ? 'SOME CHECKS FAILED' : 'All checks passed');

  await mongoose.disconnect();
  await mongod.stop();
  server.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
