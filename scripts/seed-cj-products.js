require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
var mongoose = require('mongoose');
var connectDB = require('../config/db');
var InternationalStore = require('../models/InternationalStore');
var InternationalProduct = require('../models/InternationalProduct');
var SupplierConfig = require('../models/SupplierConfig');

var EXCHANGE_RATE = 135;
var MARKUP = 0.30;

function calcHTG(costUSD) {
  return Math.round(costUSD * (1 + MARKUP) * EXCHANGE_RATE);
}

var products = [
  // ── PHONES & ELECTRONICS ──
  { name: 'Shockproof Clear Phone Case iPhone 15/14/13', category: 'phones-electronics', subcategory: 'phone-cases', cost: 2.50, img: 'phone-case-clear', delivery: 21 },
  { name: 'Heavy Duty Armor Phone Case Samsung Galaxy', category: 'phones-electronics', subcategory: 'phone-cases', cost: 3.80, img: 'phone-case-armor', delivery: 21 },
  { name: 'Silicone Soft TPU Phone Case Universal', category: 'phones-electronics', subcategory: 'phone-cases', cost: 1.90, img: 'phone-case-silicone', delivery: 21 },
  { name: 'USB-C Fast Charger 20W PD Wall Adapter', category: 'phones-electronics', subcategory: 'chargers', cost: 4.50, img: 'fast-charger-20w', delivery: 21 },
  { name: 'USB-C to Lightning Cable 6ft Braided', category: 'phones-electronics', subcategory: 'chargers', cost: 3.20, img: 'usb-cable-braided', delivery: 21 },
  { name: '65W GaN Fast Charger USB-C Dual Port', category: 'phones-electronics', subcategory: 'chargers', cost: 12.50, img: 'gan-charger-65w', delivery: 21 },
  { name: '15W Magnetic Wireless Charger Pad', category: 'phones-electronics', subcategory: 'chargers', cost: 6.80, img: 'wireless-charger', delivery: 21 },
  { name: '20000mAh Power Bank Fast Charging USB-C', category: 'phones-electronics', subcategory: 'power-banks', cost: 15.90, img: 'powerbank-20000', delivery: 21 },
  { name: '10000mAh Slim Power Bank Portable', category: 'phones-electronics', subcategory: 'power-banks', cost: 8.50, img: 'powerbank-10000', delivery: 21 },
  { name: '30000mAh Solar Power Bank Waterproof', category: 'phones-electronics', subcategory: 'power-banks', cost: 18.90, img: 'powerbank-solar', delivery: 21 },
  { name: 'TWS Bluetooth 5.3 Earbuds Noise Cancelling', category: 'phones-electronics', subcategory: 'earbuds', cost: 8.90, img: 'earbuds-tws', delivery: 21 },
  { name: 'Pro Wireless Earbuds ANC Transparency Mode', category: 'phones-electronics', subcategory: 'earbuds', cost: 14.50, img: 'earbuds-pro', delivery: 21 },
  { name: 'Bone Conduction Bluetooth Headphones Sport', category: 'phones-electronics', subcategory: 'earbuds', cost: 11.80, img: 'bone-conduction', delivery: 21 },
  { name: 'Smart Watch Fitness Tracker Heart Rate BP', category: 'phones-electronics', subcategory: 'smart-watches', cost: 12.90, img: 'smartwatch-fitness', delivery: 21 },
  { name: 'Smart Watch 1.85" HD Bluetooth Call', category: 'phones-electronics', subcategory: 'smart-watches', cost: 16.50, img: 'smartwatch-hd', delivery: 21 },
  { name: 'Kids Smart Watch GPS Tracker SOS Call', category: 'phones-electronics', subcategory: 'smart-watches', cost: 18.90, img: 'smartwatch-kids', delivery: 21 },
  { name: 'Magnetic Car Phone Mount Dashboard', category: 'phones-electronics', subcategory: 'phone-holders', cost: 4.20, img: 'phone-mount-car', delivery: 21 },
  { name: 'Adjustable Phone Stand Foldable Desktop', category: 'phones-electronics', subcategory: 'phone-holders', cost: 3.50, img: 'phone-stand', delivery: 21 },
  { name: '1080P WiFi Security Camera Indoor Pan/Tilt', category: 'phones-electronics', subcategory: 'security-cameras', cost: 15.90, img: 'security-cam-indoor', delivery: 21 },
  { name: '4MP Outdoor Security Camera Night Vision WiFi', category: 'phones-electronics', subcategory: 'security-cameras', cost: 22.50, img: 'security-cam-outdoor', delivery: 21 },
  { name: 'Solar Powered Security Camera Wireless 2K', category: 'phones-electronics', subcategory: 'security-cameras', cost: 28.90, img: 'security-cam-solar', delivery: 21 },

  // ── SOLAR & ENERGY ──
  { name: 'Solar Flood Light 300W Outdoor Motion Sensor', category: 'solar-energy', subcategory: 'solar-flood-lights', cost: 18.90, img: 'solar-flood-300w', delivery: 21 },
  { name: 'Solar Flood Light 100W Remote Control', category: 'solar-energy', subcategory: 'solar-flood-lights', cost: 12.50, img: 'solar-flood-100w', delivery: 21 },
  { name: 'Solar Flood Light 500W Ultra Bright Yard', category: 'solar-energy', subcategory: 'solar-flood-lights', cost: 25.90, img: 'solar-flood-500w', delivery: 21 },
  { name: 'Solar Street Light 200W Dusk to Dawn', category: 'solar-energy', subcategory: 'solar-street-lights', cost: 22.50, img: 'solar-street-200w', delivery: 21 },
  { name: 'Solar Street Light 400W All-in-One Pole Mount', category: 'solar-energy', subcategory: 'solar-street-lights', cost: 35.90, img: 'solar-street-400w', delivery: 21 },
  { name: 'Solar Garden Path Light 8-Pack LED', category: 'solar-energy', subcategory: 'solar-flood-lights', cost: 9.90, img: 'solar-garden-path', delivery: 21 },
  { name: 'Solar Power Bank 30000mAh Camping', category: 'solar-energy', subcategory: 'solar-batteries', cost: 19.90, img: 'solar-powerbank', delivery: 21 },
  { name: 'Solar Generator 300W Portable Power Station', category: 'solar-energy', subcategory: 'solar-generators', cost: 89.90, img: 'solar-generator-300w', delivery: 21 },
  { name: 'Solar Panel 100W Foldable Portable Camping', category: 'solar-energy', subcategory: 'solar-panels', cost: 45.90, img: 'solar-panel-100w', delivery: 21 },
  { name: 'Solar Desk Fan 12" Rechargeable Battery', category: 'solar-energy', subcategory: 'solar-fans', cost: 14.90, img: 'solar-fan-desk', delivery: 21 },
  { name: 'Solar Standing Fan 16" Remote Control', category: 'solar-energy', subcategory: 'solar-fans', cost: 28.50, img: 'solar-fan-standing', delivery: 21 },
  { name: 'Solar Battery 12V 20Ah LiFePO4', category: 'solar-energy', subcategory: 'solar-batteries', cost: 59.90, img: 'solar-battery-12v', delivery: 21 },

  // ── AUTO PARTS ──
  { name: 'LED Headlight Bulbs H11 H7 H4 6000K White', category: 'auto-parts', subcategory: 'led-lights', cost: 12.90, img: 'led-headlight-h11', delivery: 21 },
  { name: 'LED Headlight Bulbs 9005/9006 Pair 300% Brighter', category: 'auto-parts', subcategory: 'led-lights', cost: 15.50, img: 'led-headlight-9005', delivery: 21 },
  { name: 'LED Light Bar 22" Off-Road Truck SUV', category: 'auto-parts', subcategory: 'led-lights', cost: 25.90, img: 'led-light-bar', delivery: 21 },
  { name: 'Car Phone Mount Vent Clip 360 Rotation', category: 'auto-parts', subcategory: 'phone-holders', cost: 4.90, img: 'car-phone-vent', delivery: 21 },
  { name: 'Dash Camera 1080P Night Vision Wide Angle', category: 'auto-parts', subcategory: 'mirrors', cost: 18.90, img: 'dashcam-1080p', delivery: 21 },
  { name: 'Dash Camera 4K Front and Rear Dual', category: 'auto-parts', subcategory: 'mirrors', cost: 35.90, img: 'dashcam-4k-dual', delivery: 21 },
  { name: 'Universal Car Seat Cover Set 5-Seat PU Leather', category: 'auto-parts', subcategory: 'seat-covers', cost: 32.90, img: 'seat-cover-leather', delivery: 21 },
  { name: 'Car Floor Mats All Weather Custom Fit 4-Piece', category: 'auto-parts', subcategory: 'floor-mats', cost: 22.50, img: 'floor-mats-rubber', delivery: 21 },
  { name: 'Portable Tire Inflator 150PSI Digital', category: 'auto-parts', subcategory: 'tires', cost: 18.90, img: 'tire-inflator', delivery: 21 },
  { name: 'Jump Starter 3000A Peak 20000mAh Portable', category: 'auto-parts', subcategory: 'batteries', cost: 35.90, img: 'jump-starter', delivery: 21 },
  { name: 'Car Battery Charger 12V Smart Automatic', category: 'auto-parts', subcategory: 'batteries', cost: 14.50, img: 'battery-charger', delivery: 21 },
  { name: 'LED Interior Car Lights RGB Ambient Strip', category: 'auto-parts', subcategory: 'led-lights', cost: 7.90, img: 'car-led-interior', delivery: 21 },

  // ── BEAUTY & PERSONAL CARE ──
  { name: 'Body Wave Lace Front Wig Human Hair 18"', category: 'beauty-personal-care', subcategory: 'wigs', cost: 35.90, img: 'wig-body-wave', delivery: 21 },
  { name: 'Straight Lace Front Wig 20" Natural Black', category: 'beauty-personal-care', subcategory: 'wigs', cost: 32.50, img: 'wig-straight', delivery: 21 },
  { name: 'Curly Bob Wig Short 12" Glueless', category: 'beauty-personal-care', subcategory: 'wigs', cost: 22.90, img: 'wig-curly-bob', delivery: 21 },
  { name: 'Clip-in Hair Extensions 22" 7-Piece Set', category: 'beauty-personal-care', subcategory: 'hair-extensions', cost: 18.50, img: 'hair-extensions-clip', delivery: 21 },
  { name: 'Tape-in Hair Extensions 20" Remy Human Hair', category: 'beauty-personal-care', subcategory: 'hair-extensions', cost: 28.90, img: 'hair-extensions-tape', delivery: 21 },
  { name: '10" Ring Light with Tripod Stand Phone Holder', category: 'beauty-personal-care', subcategory: 'salon-equipment', cost: 12.90, img: 'ring-light-10', delivery: 21 },
  { name: '18" Ring Light Professional LED Dimmable', category: 'beauty-personal-care', subcategory: 'salon-equipment', cost: 25.90, img: 'ring-light-18', delivery: 21 },
  { name: 'Makeup Organizer Rotating 360 Acrylic', category: 'beauty-personal-care', subcategory: 'cosmetics', cost: 8.90, img: 'makeup-organizer', delivery: 21 },
  { name: 'Professional Nail Kit Electric File Drill Set', category: 'beauty-personal-care', subcategory: 'cosmetics', cost: 14.50, img: 'nail-kit-electric', delivery: 21 },
  { name: 'Facial Steamer Nano Ionic Deep Cleaning', category: 'beauty-personal-care', subcategory: 'cosmetics', cost: 11.90, img: 'facial-steamer', delivery: 21 },
  { name: 'Hair Clipper Professional Cordless T-Blade', category: 'beauty-personal-care', subcategory: 'barbershop-supplies', cost: 9.90, img: 'hair-clipper', delivery: 21 },

  // ── HOME & KITCHEN ──
  { name: 'Air Fryer 5.5L Digital Touch Screen 1700W', category: 'home-kitchen', subcategory: 'air-fryers', cost: 32.90, img: 'air-fryer-5l', delivery: 21 },
  { name: 'Air Fryer 3.5L Compact Family Size', category: 'home-kitchen', subcategory: 'air-fryers', cost: 22.50, img: 'air-fryer-3l', delivery: 21 },
  { name: 'Air Fryer Oven 12L Rotisserie Dehydrator', category: 'home-kitchen', subcategory: 'air-fryers', cost: 45.90, img: 'air-fryer-oven', delivery: 21 },
  { name: 'Blender 2L Heavy Duty 2200W Smoothie Maker', category: 'home-kitchen', subcategory: 'blenders', cost: 28.90, img: 'blender-heavy', delivery: 21 },
  { name: 'Personal Blender Portable USB Rechargeable', category: 'home-kitchen', subcategory: 'blenders', cost: 8.90, img: 'blender-portable', delivery: 21 },
  { name: 'Hand Blender Immersion Stick 5-in-1 Set', category: 'home-kitchen', subcategory: 'blenders', cost: 15.50, img: 'blender-immersion', delivery: 21 },
  { name: 'Electric Kettle 1.7L Stainless Steel Auto Shutoff', category: 'home-kitchen', subcategory: 'kitchen-sets', cost: 12.50, img: 'electric-kettle', delivery: 21 },
  { name: 'Water Dispenser Bottom Loading Hot & Cold', category: 'home-kitchen', subcategory: 'water-dispensers', cost: 65.90, img: 'water-dispenser', delivery: 21 },
  { name: 'Mini Table Fan USB Rechargeable Clip-on', category: 'home-kitchen', subcategory: 'fans', cost: 6.90, img: 'mini-fan-clip', delivery: 21 },
  { name: 'Tower Fan 40" Oscillating Remote Control', category: 'home-kitchen', subcategory: 'fans', cost: 35.90, img: 'tower-fan', delivery: 21 },
  { name: 'Rice Cooker 5L Multi-Function Digital', category: 'home-kitchen', subcategory: 'kitchen-sets', cost: 22.50, img: 'rice-cooker', delivery: 21 },
  { name: 'Electric Pressure Cooker 6L 12-in-1', category: 'home-kitchen', subcategory: 'kitchen-sets', cost: 35.90, img: 'pressure-cooker', delivery: 21 },
];

async function seed() {
  await connectDB();
  console.log('Setting up CJ USA supplier...');

  var config = await SupplierConfig.findOne({ supplierType: 'CJ_USA' });
  if (!config) {
    config = await SupplierConfig.create({
      supplierType: 'CJ_USA',
      name: 'CJ Dropshipping USA',
      isActive: true,
      settings: { markupPercent: 30, exchangeRateHTG: EXCHANGE_RATE, estimatedDeliveryDays: 21 }
    });
  }

  var store = await InternationalStore.findOne({ supplierType: 'CJ_USA' });
  if (!store) {
    store = await InternationalStore.create({
      name: 'CJ Dropshipping USA',
      country: 'US',
      supplierType: 'CJ_USA',
      description: 'USA warehouse products shipped to Haiti',
      category: 'general',
      serviceFeePercent: 0,
      logisticsFeeHTG: 0,
      customsDutyPercent: 0,
      estimatedDeliveryDays: 21,
      isActive: true
    });
  }

  console.log('Store: ' + store.name + ' (' + store._id + ')');
  console.log('Importing ' + products.length + ' products...');

  var imported = 0;
  var updated = 0;

  for (var i = 0; i < products.length; i++) {
    var p = products[i];
    var existing = await InternationalProduct.findOne({ name: p.name, supplierType: 'CJ_USA' });

    var data = {
      store: store._id,
      name: p.name,
      description: '',
      category: p.category,
      subcategory: p.subcategory,
      sku: p.img,
      externalId: 'seed-' + p.img,
      supplierType: 'CJ_USA',
      images: [],
      variants: [],
      weight: 0,
      warehouse: 'CJ USA',
      sourcePrice: p.cost,
      sourceCurrency: 'USD',
      markupPercent: 30,
      exchangeRate: EXCHANGE_RATE,
      serviceFee: 0,
      logisticsFee: 0,
      customsDuty: 0,
      finalPriceHTG: calcHTG(p.cost),
      inventory: -1,
      inStock: true,
      estimatedDeliveryDays: p.delivery,
      lastSyncedAt: new Date()
    };

    if (existing) {
      Object.assign(existing, data);
      await existing.save();
      updated++;
    } else {
      await InternationalProduct.create(data);
      imported++;
    }
  }

  await InternationalStore.findByIdAndUpdate(store._id, { 'stats.totalProducts': imported + updated });

  console.log('Done! ' + imported + ' imported, ' + updated + ' updated.');
  console.log('Total: ' + products.length + ' products across 5 categories');
  console.log('');
  console.log('Category breakdown:');

  var cats = {};
  products.forEach(function(p) {
    cats[p.category] = (cats[p.category] || 0) + 1;
  });
  Object.keys(cats).forEach(function(c) {
    console.log('  ' + c + ': ' + cats[c] + ' products');
  });

  process.exit(0);
}

seed().catch(function(err) {
  console.error('Seed error:', err);
  process.exit(1);
});
