// Expanded CJ Dropshipping catalog import for MyPlopPlop.
// Grows the live CJ catalog across all 12 store categories with curated,
// Haiti-shippable, affordable (<= $100 wholesale) products. Re-runnable:
// existing products (by externalId) are refreshed, new ones are created.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
var mongoose = require('mongoose');
var connectDB = require('../config/db');
var SupplierConfig = require('../models/SupplierConfig');
var InternationalStore = require('../models/InternationalStore');
var InternationalProduct = require('../models/InternationalProduct');

var EXCHANGE_RATE = 135;
var MARKUP = 0.30;
var MAX_COST = 100;
var PRODUCTS_PER_SEARCH = 20;
var MAX_PAGES = 3;
var SLEEP_MS = 1400;

// search term -> valid category/subcategory slugs (must exist in Category model)
var searches = [
  // phones-electronics
  { q: 'android tablet', cat: 'phones-electronics', sub: 'tablets' },
  { q: 'bluetooth speaker', cat: 'phones-electronics', sub: 'bluetooth-speakers' },
  { q: 'gaming headset', cat: 'phones-electronics', sub: 'earbuds' },
  { q: 'wireless mouse', cat: 'phones-electronics', sub: 'laptops' },
  { q: 'wireless keyboard', cat: 'phones-electronics', sub: 'laptops' },
  { q: 'webcam hd', cat: 'phones-electronics', sub: 'laptops' },
  { q: 'usb flash drive', cat: 'phones-electronics', sub: 'laptops' },
  { q: 'memory card', cat: 'phones-electronics', sub: 'laptops' },
  { q: 'mini projector', cat: 'phones-electronics', sub: 'laptops' },
  { q: 'tv box android', cat: 'phones-electronics', sub: 'smart-watches' },
  { q: 'game controller', cat: 'phones-electronics', sub: 'earbuds' },
  { q: 'selfie stick tripod', cat: 'phones-electronics', sub: 'phone-holders' },
  { q: 'smart bulb wifi', cat: 'phones-electronics', sub: 'security-cameras' },
  { q: 'wifi security camera', cat: 'phones-electronics', sub: 'security-cameras' },
  { q: 'bluetooth speaker waterproof', cat: 'phones-electronics', sub: 'bluetooth-speakers' },
  // solar-energy
  { q: 'solar inverter', cat: 'solar-energy', sub: 'inverters' },
  { q: 'solar charge controller', cat: 'solar-energy', sub: 'charge-controllers' },
  { q: 'solar lantern rechargeable', cat: 'solar-energy', sub: 'solar-flood-lights' },
  { q: 'solar garden light', cat: 'solar-energy', sub: 'solar-street-lights' },
  { q: 'solar panel foldable', cat: 'solar-energy', sub: 'solar-panels' },
  { q: 'solar rechargeable fan', cat: 'solar-energy', sub: 'solar-fans' },
  // auto-parts
  { q: 'car vacuum cleaner', cat: 'auto-parts', sub: 'motor-oil' },
  { q: 'car organizer', cat: 'auto-parts', sub: 'seat-covers' },
  { q: 'obd2 scanner', cat: 'auto-parts', sub: 'batteries' },
  { q: 'wiper blades', cat: 'auto-parts', sub: 'mirrors' },
  { q: 'car interior led', cat: 'auto-parts', sub: 'led-lights' },
  { q: 'steering wheel cover', cat: 'auto-parts', sub: 'seat-covers' },
  { q: 'car backup camera', cat: 'auto-parts', sub: 'mirrors' },
  { q: 'motorcycle phone mount', cat: 'auto-parts', sub: 'motorcycle-parts' },
  { q: 'car fast charger', cat: 'auto-parts', sub: 'batteries' },
  // home-kitchen
  { q: 'coffee maker', cat: 'home-kitchen', sub: 'kitchen-sets' },
  { q: 'hand mixer', cat: 'home-kitchen', sub: 'blenders' },
  { q: 'food processor', cat: 'home-kitchen', sub: 'blenders' },
  { q: 'cordless vacuum cleaner', cat: 'home-kitchen', sub: 'kitchen-sets' },
  { q: 'air humidifier', cat: 'home-kitchen', sub: 'fans' },
  { q: 'electric grill', cat: 'home-kitchen', sub: 'kitchen-sets' },
  { q: 'sandwich maker', cat: 'home-kitchen', sub: 'kitchen-sets' },
  { q: 'juicer machine', cat: 'home-kitchen', sub: 'blenders' },
  { q: 'knife set kitchen', cat: 'home-kitchen', sub: 'kitchen-sets' },
  { q: 'food storage container set', cat: 'home-kitchen', sub: 'kitchen-sets' },
  { q: 'led strip lights', cat: 'home-kitchen', sub: 'kitchen-sets' },
  { q: 'shower head', cat: 'home-kitchen', sub: 'kitchen-sets' },
  { q: 'pressure cooker', cat: 'home-kitchen', sub: 'pressure-cookers' },
  { q: 'rice cooker', cat: 'home-kitchen', sub: 'rice-cookers' },
  // construction-hardware
  { q: 'cordless drill', cat: 'construction-hardware', sub: 'tools' },
  { q: 'screwdriver set', cat: 'construction-hardware', sub: 'tools' },
  { q: 'tool kit household', cat: 'construction-hardware', sub: 'tools' },
  { q: 'digital multimeter', cat: 'construction-hardware', sub: 'tools' },
  { q: 'tape measure', cat: 'construction-hardware', sub: 'tools' },
  { q: 'wrench set', cat: 'construction-hardware', sub: 'tools' },
  { q: 'soldering iron kit', cat: 'construction-hardware', sub: 'tools' },
  { q: 'work gloves', cat: 'construction-hardware', sub: 'tools' },
  { q: 'rechargeable flashlight', cat: 'construction-hardware', sub: 'tools' },
  { q: 'led headlamp', cat: 'construction-hardware', sub: 'tools' },
  { q: 'padlock heavy duty', cat: 'construction-hardware', sub: 'switches' },
  { q: 'wall switch socket', cat: 'construction-hardware', sub: 'switches' },
  { q: 'circuit breaker', cat: 'construction-hardware', sub: 'breakers' },
  { q: 'extension cord', cat: 'construction-hardware', sub: 'electrical-wire' },
  // beauty-personal-care
  { q: 'hair dryer', cat: 'beauty-personal-care', sub: 'salon-equipment' },
  { q: 'hair straightener', cat: 'beauty-personal-care', sub: 'salon-equipment' },
  { q: 'curling iron', cat: 'beauty-personal-care', sub: 'salon-equipment' },
  { q: 'electric shaver men', cat: 'beauty-personal-care', sub: 'barbershop-supplies' },
  { q: 'facial steamer', cat: 'beauty-personal-care', sub: 'skin-care-products' },
  { q: 'makeup brush set', cat: 'beauty-personal-care', sub: 'cosmetics' },
  { q: 'false eyelashes', cat: 'beauty-personal-care', sub: 'cosmetics' },
  { q: 'massage gun', cat: 'beauty-personal-care', sub: 'salon-equipment' },
  { q: 'perfume women', cat: 'beauty-personal-care', sub: 'perfumes' },
  { q: 'skin care set', cat: 'beauty-personal-care', sub: 'skin-care-products' },
  // fashion
  { q: 'men t shirt', cat: 'fashion', sub: 'men-s-clothing' },
  { q: 'women dress', cat: 'fashion', sub: 'women-s-clothing' },
  { q: 'sunglasses', cat: 'fashion', sub: 'sunglasses' },
  { q: 'men wrist watch', cat: 'fashion', sub: 'watches' },
  { q: 'backpack', cat: 'fashion', sub: 'handbags' },
  { q: 'men wallet leather', cat: 'fashion', sub: 'handbags' },
  { q: 'leather belt men', cat: 'fashion', sub: 'men-s-clothing' },
  { q: 'men sneakers', cat: 'fashion', sub: 'sneakers' },
  { q: 'women sandals', cat: 'fashion', sub: 'shoes' },
  { q: 'baseball cap', cat: 'fashion', sub: 'men-s-clothing' },
  { q: 'women jewelry set', cat: 'fashion', sub: 'women-s-clothing' },
  { q: 'crossbody bag women', cat: 'fashion', sub: 'handbags' },
  // baby-family
  { q: 'baby carrier', cat: 'baby-family', sub: 'strollers' },
  { q: 'baby bottle set', cat: 'baby-family', sub: 'baby-formula' },
  { q: 'educational toys kids', cat: 'baby-family', sub: 'toys' },
  { q: 'building blocks toy', cat: 'baby-family', sub: 'toys' },
  { q: 'remote control car toy', cat: 'baby-family', sub: 'toys' },
  { q: 'plush toy', cat: 'baby-family', sub: 'toys' },
  { q: 'kids backpack', cat: 'baby-family', sub: 'baby-clothing' },
  { q: 'baby monitor', cat: 'baby-family', sub: 'strollers' },
  // medical-supplies
  { q: 'blood pressure monitor', cat: 'medical-supplies', sub: 'blood-pressure-monitors' },
  { q: 'digital thermometer', cat: 'medical-supplies', sub: 'thermometers' },
  { q: 'pulse oximeter', cat: 'medical-supplies', sub: 'first-aid-kits' },
  { q: 'first aid kit', cat: 'medical-supplies', sub: 'first-aid-kits' },
  { q: 'face mask', cat: 'medical-supplies', sub: 'masks' },
  { q: 'nitrile gloves', cat: 'medical-supplies', sub: 'gloves' },
  { q: 'knee brace support', cat: 'medical-supplies', sub: 'first-aid-kits' },
  { q: 'digital weight scale', cat: 'medical-supplies', sub: 'blood-pressure-monitors' },
  // agriculture
  { q: 'garden hose expandable', cat: 'agriculture', sub: 'irrigation-supplies' },
  { q: 'pruning shears', cat: 'agriculture', sub: 'farming-tools' },
  { q: 'garden sprayer', cat: 'agriculture', sub: 'sprayers' },
  { q: 'garden tool set', cat: 'agriculture', sub: 'farming-tools' },
  { q: 'water pump', cat: 'agriculture', sub: 'water-pumps' },
  { q: 'drip irrigation kit', cat: 'agriculture', sub: 'irrigation-supplies' },
  // business-supplies
  { q: 'thermal receipt printer', cat: 'business-supplies', sub: 'receipt-printers' },
  { q: 'barcode scanner', cat: 'business-supplies', sub: 'barcode-scanners' },
  { q: 'label maker', cat: 'business-supplies', sub: 'printers' },
  { q: 'calculator', cat: 'business-supplies', sub: 'office-furniture' },
  { q: 'money counter', cat: 'business-supplies', sub: 'cash-drawers' },
  { q: 'laminator machine', cat: 'business-supplies', sub: 'printers' }
];

var AVOID = ['furniture','sofa','couch','desk','table','chair','bed frame','mattress',
  'refrigerator','fridge','washing machine','dryer','dishwasher','wardrobe','cabinet',
  'bookshelf','oversized','treadmill','piano','engine block'];

function sleep(ms) { return new Promise(function(r){ setTimeout(r, ms); }); }

async function run() {
  await connectDB();

  var config = await SupplierConfig.findOne({ supplierType: 'CJ_USA' });
  if (!config || !config.credentials.accessToken) { console.error('No CJ access token'); process.exit(1); }
  var store = await InternationalStore.findOne({ supplierType: 'CJ_USA' });
  if (!store) { console.error('No CJ store'); process.exit(1); }

  var token = config.credentials.accessToken;
  var imported = 0, updated = 0, skipped = 0, errors = 0;
  var startCount = await InternationalProduct.countDocuments({ supplierType: 'CJ_USA' });
  var START_INDEX = parseInt(process.env.START_INDEX || '0', 10);
  console.log('START CJ product count: ' + startCount + ' | searches: ' + searches.length + ' | from index: ' + START_INDEX);

  for (var s = START_INDEX; s < searches.length; s++) {
    var search = searches[s];
    for (var page = 1; page <= MAX_PAGES; page++) {
      await sleep(SLEEP_MS);
      var data;
      try {
        var url = 'https://developers.cjdropshipping.com/api2.0/v1/product/list?pageNum=' + page +
          '&pageSize=' + PRODUCTS_PER_SEARCH + '&productNameEn=' + encodeURIComponent(search.q);
        var resp = await fetch(url, { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } });
        data = await resp.json();
      } catch (e) { console.log('  net err ' + search.q + ': ' + e.message); errors++; break; }

      if (data && data.code && data.code !== 200 && !data.result) {
        // rate limited or transient -> back off once and retry this page
        console.log('  api code ' + data.code + ' (' + data.message + ') on "' + search.q + '" p' + page + ' - backoff');
        await sleep(4000);
        continue;
      }
      if (!data.result || !data.data || !data.data.list) break;
      var list = data.data.list;
      if (list.length === 0) break;

      for (var i = 0; i < list.length; i++) {
        var p = list[i];
        var name = p.productNameEn || p.productName || '';
        var cost = parseFloat(p.sellPrice || p.productPrice || 0);
        if (cost <= 0 || cost > MAX_COST) { skipped++; continue; }
        var nameLower = name.toLowerCase();
        var blocked = false;
        for (var a = 0; a < AVOID.length; a++) { if (nameLower.indexOf(AVOID[a]) !== -1) { blocked = true; break; } }
        if (blocked) { skipped++; continue; }

        var images = [];
        if (p.productImage) images.push(p.productImage);

        try {
          var existing = await InternationalProduct.findOne({ externalId: p.pid, supplierType: 'CJ_USA' });
          if (existing) {
            existing.sourcePrice = cost;
            existing.finalPriceHTG = Math.round(cost * (1 + MARKUP) * EXCHANGE_RATE);
            existing.exchangeRate = EXCHANGE_RATE;
            existing.markupPercent = MARKUP * 100;
            if (images.length > 0) existing.images = images;
            existing.inStock = true;
            existing.lastSyncedAt = new Date();
            await existing.save();
            updated++;
            continue;
          }
          await InternationalProduct.create({
            store: store._id,
            name: name,
            description: p.description || '',
            category: search.cat,
            subcategory: search.sub,
            sku: p.productSku || '',
            externalId: p.pid,
            supplierType: 'CJ_USA',
            images: images,
            variants: [],
            weight: p.productWeight || 0,
            warehouse: 'CJ USA',
            sourcePrice: cost,
            sourceCurrency: 'USD',
            markupPercent: MARKUP * 100,
            exchangeRate: EXCHANGE_RATE,
            serviceFee: 0,
            logisticsFee: 0,
            customsDuty: 0,
            finalPriceHTG: Math.round(cost * (1 + MARKUP) * EXCHANGE_RATE),
            inventory: -1,
            inStock: true,
            estimatedDeliveryDays: 21,
            lastSyncedAt: new Date()
          });
          imported++;
        } catch (e) { errors++; }
      }
      if (list.length < PRODUCTS_PER_SEARCH) break;
    }
    console.log('[' + (s+1) + '/' + searches.length + '] "' + search.q + '" -> new:' + imported + ' upd:' + updated + ' skip:' + skipped + ' err:' + errors);
  }

  var endCount = await InternationalProduct.countDocuments({ supplierType: 'CJ_USA', isActive: true });
  await InternationalStore.findByIdAndUpdate(store._id, { 'stats.totalProducts': endCount });
  console.log('\n=== EXPAND COMPLETE ===');
  console.log('New imported: ' + imported + ' | Updated: ' + updated + ' | Skipped: ' + skipped + ' | Errors: ' + errors);
  console.log('CJ catalog now: ' + endCount + ' (was ' + startCount + ')');
  process.exit(0);
}

run().catch(function(err){ console.error(err); process.exit(1); });
