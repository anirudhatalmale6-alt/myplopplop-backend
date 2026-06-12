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

var searches = [
  { q: 'phone case', cat: 'phones-electronics', sub: 'phone-cases' },
  { q: 'fast charger USB', cat: 'phones-electronics', sub: 'chargers' },
  { q: 'power bank', cat: 'phones-electronics', sub: 'power-banks' },
  { q: 'bluetooth earbuds', cat: 'phones-electronics', sub: 'earbuds' },
  { q: 'smart watch', cat: 'phones-electronics', sub: 'smart-watches' },
  { q: 'wireless charger', cat: 'phones-electronics', sub: 'chargers' },
  { q: 'phone holder car', cat: 'phones-electronics', sub: 'phone-holders' },
  { q: 'security camera wifi', cat: 'phones-electronics', sub: 'security-cameras' },
  { q: 'USB cable type C', cat: 'phones-electronics', sub: 'chargers' },
  { q: 'solar flood light', cat: 'solar-energy', sub: 'solar-flood-lights' },
  { q: 'solar street light', cat: 'solar-energy', sub: 'solar-street-lights' },
  { q: 'solar fan', cat: 'solar-energy', sub: 'solar-fans' },
  { q: 'solar generator portable', cat: 'solar-energy', sub: 'solar-generators' },
  { q: 'solar panel portable', cat: 'solar-energy', sub: 'solar-panels' },
  { q: 'solar power bank', cat: 'solar-energy', sub: 'solar-batteries' },
  { q: 'LED headlight car', cat: 'auto-parts', sub: 'led-lights' },
  { q: 'dash camera car', cat: 'auto-parts', sub: 'mirrors' },
  { q: 'car seat cover', cat: 'auto-parts', sub: 'seat-covers' },
  { q: 'tire inflator portable', cat: 'auto-parts', sub: 'tires' },
  { q: 'jump starter car', cat: 'auto-parts', sub: 'batteries' },
  { q: 'car floor mat', cat: 'auto-parts', sub: 'floor-mats' },
  { q: 'wig human hair', cat: 'beauty-personal-care', sub: 'wigs' },
  { q: 'hair extension clip', cat: 'beauty-personal-care', sub: 'hair-extensions' },
  { q: 'ring light tripod', cat: 'beauty-personal-care', sub: 'salon-equipment' },
  { q: 'makeup organizer', cat: 'beauty-personal-care', sub: 'cosmetics' },
  { q: 'nail drill electric', cat: 'beauty-personal-care', sub: 'cosmetics' },
  { q: 'hair clipper professional', cat: 'beauty-personal-care', sub: 'barbershop-supplies' },
  { q: 'air fryer', cat: 'home-kitchen', sub: 'air-fryers' },
  { q: 'blender portable', cat: 'home-kitchen', sub: 'blenders' },
  { q: 'electric kettle', cat: 'home-kitchen', sub: 'kitchen-sets' },
  { q: 'mini fan USB', cat: 'home-kitchen', sub: 'fans' },
  { q: 'rice cooker', cat: 'home-kitchen', sub: 'kitchen-sets' },
  { q: 'water dispenser', cat: 'home-kitchen', sub: 'water-dispensers' },
];

var AVOID = ['furniture','sofa','couch','desk','table','chair','bed','mattress','refrigerator','fridge','washing machine','dryer','dishwasher','wardrobe','cabinet','bookshelf','oversized'];

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

async function run() {
  await connectDB();

  var config = await SupplierConfig.findOne({ supplierType: 'CJ_USA' });
  if (!config || !config.credentials.accessToken) {
    console.error('No CJ access token found');
    process.exit(1);
  }

  var store = await InternationalStore.findOne({ supplierType: 'CJ_USA' });
  if (!store) {
    console.error('No CJ store found');
    process.exit(1);
  }

  var token = config.credentials.accessToken;
  var imported = 0;
  var skipped = 0;
  var errors = 0;

  for (var s = 0; s < searches.length; s++) {
    var search = searches[s];
    console.log('[' + (s+1) + '/' + searches.length + '] Searching: "' + search.q + '"');

    for (var page = 1; page <= MAX_PAGES; page++) {
      await sleep(1100);

      try {
        var url = 'https://developers.cjdropshipping.com/api2.0/v1/product/list?pageNum=' + page + '&pageSize=' + PRODUCTS_PER_SEARCH + '&productNameEn=' + encodeURIComponent(search.q);
        var resp = await fetch(url, { headers: { 'CJ-Access-Token': token, 'Content-Type': 'application/json' } });
        var data = await resp.json();

        if (!data.result || !data.data || !data.data.list) {
          console.log('  No results page ' + page);
          break;
        }

        var list = data.data.list;
        if (list.length === 0) break;

        for (var i = 0; i < list.length; i++) {
          var p = list[i];
          var name = p.productNameEn || p.productName || '';
          var cost = parseFloat(p.sellPrice || p.productPrice || 0);

          if (cost <= 0 || cost > MAX_COST) { skipped++; continue; }

          var nameLower = name.toLowerCase();
          var blocked = false;
          for (var a = 0; a < AVOID.length; a++) {
            if (nameLower.indexOf(AVOID[a]) !== -1) { blocked = true; break; }
          }
          if (blocked) { skipped++; continue; }

          var images = [];
          if (p.productImage) images.push(p.productImage);

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
            continue;
          }

          try {
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
          } catch (e) {
            errors++;
          }
        }

        if (list.length < PRODUCTS_PER_SEARCH) break;
      } catch (e) {
        console.log('  Error: ' + e.message);
        errors++;
      }
    }

    console.log('  Imported so far: ' + imported + ' | Skipped: ' + skipped);
  }

  await InternationalStore.findByIdAndUpdate(store._id, { 'stats.totalProducts': await InternationalProduct.countDocuments({ supplierType: 'CJ_USA', isActive: true }) });

  console.log('\n=== IMPORT COMPLETE ===');
  console.log('Imported: ' + imported);
  console.log('Skipped: ' + skipped);
  console.log('Errors: ' + errors);
  process.exit(0);
}

run().catch(function(err) { console.error(err); process.exit(1); });
