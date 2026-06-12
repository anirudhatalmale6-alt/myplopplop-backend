const SupplierConfig = require('../models/SupplierConfig');
const InternationalStore = require('../models/InternationalStore');
const InternationalProduct = require('../models/InternationalProduct');
const InternationalOrder = require('../models/InternationalOrder');

const CJ_BASE_URL = 'https://developers.cjdropshipping.com/api2.0/v1';

var IMPORT_RULES = {
  maxWholesaleCostUSD: 100,
  minRating: 4.5,
  warehouseFilter: 'US',
  phase1Categories: [
    { search: 'phone case', category: 'phones-electronics', subcategory: 'phone-cases' },
    { search: 'phone charger', category: 'phones-electronics', subcategory: 'chargers' },
    { search: 'fast charger', category: 'phones-electronics', subcategory: 'chargers' },
    { search: 'power bank', category: 'phones-electronics', subcategory: 'power-banks' },
    { search: 'bluetooth earbuds', category: 'phones-electronics', subcategory: 'earbuds' },
    { search: 'smart watch', category: 'phones-electronics', subcategory: 'smart-watches' },
    { search: 'phone holder', category: 'phones-electronics', subcategory: 'phone-holders' },
    { search: 'USB cable', category: 'phones-electronics', subcategory: 'chargers' },
    { search: 'wireless charger', category: 'phones-electronics', subcategory: 'chargers' },
    { search: 'solar flood light', category: 'solar-energy', subcategory: 'solar-flood-lights' },
    { search: 'solar street light', category: 'solar-energy', subcategory: 'solar-street-lights' },
    { search: 'solar security camera', category: 'solar-energy', subcategory: 'solar-panels' },
    { search: 'solar power bank', category: 'solar-energy', subcategory: 'solar-batteries' },
    { search: 'solar fan', category: 'solar-energy', subcategory: 'solar-fans' },
    { search: 'solar generator', category: 'solar-energy', subcategory: 'solar-generators' },
    { search: 'solar battery', category: 'solar-energy', subcategory: 'solar-batteries' },
    { search: 'LED headlight car', category: 'auto-parts', subcategory: 'led-lights' },
    { search: 'car phone mount', category: 'auto-parts', subcategory: 'phone-holders' },
    { search: 'dash camera', category: 'auto-parts', subcategory: 'mirrors' },
    { search: 'car seat cover', category: 'auto-parts', subcategory: 'seat-covers' },
    { search: 'car floor mat', category: 'auto-parts', subcategory: 'floor-mats' },
    { search: 'tire inflator', category: 'auto-parts', subcategory: 'tires' },
    { search: 'jump starter', category: 'auto-parts', subcategory: 'batteries' },
    { search: 'wig', category: 'beauty-personal-care', subcategory: 'wigs' },
    { search: 'hair extension', category: 'beauty-personal-care', subcategory: 'hair-extensions' },
    { search: 'ring light', category: 'beauty-personal-care', subcategory: 'salon-equipment' },
    { search: 'makeup organizer', category: 'beauty-personal-care', subcategory: 'cosmetics' },
    { search: 'beauty tools', category: 'beauty-personal-care', subcategory: 'cosmetics' },
    { search: 'nail kit', category: 'beauty-personal-care', subcategory: 'cosmetics' },
    { search: 'air fryer', category: 'home-kitchen', subcategory: 'air-fryers' },
    { search: 'blender', category: 'home-kitchen', subcategory: 'blenders' },
    { search: 'electric kettle', category: 'home-kitchen', subcategory: 'kitchen-sets' },
    { search: 'water dispenser', category: 'home-kitchen', subcategory: 'water-dispensers' },
    { search: 'mini fan', category: 'home-kitchen', subcategory: 'fans' },
    { search: 'security camera', category: 'phones-electronics', subcategory: 'security-cameras' }
  ],
  avoidKeywords: [
    'furniture', 'sofa', 'couch', 'desk', 'table', 'chair', 'bed', 'mattress',
    'refrigerator', 'fridge', 'washing machine', 'dryer', 'dishwasher',
    'wardrobe', 'cabinet', 'bookshelf', 'oversized'
  ]
};

function passesImportFilter(product) {
  var cost = parseFloat(product.sellPrice || product.productPrice || 0);
  if (cost > IMPORT_RULES.maxWholesaleCostUSD) return false;
  if (cost <= 0) return false;

  var name = (product.productNameEn || product.productName || '').toLowerCase();
  for (var i = 0; i < IMPORT_RULES.avoidKeywords.length; i++) {
    if (name.indexOf(IMPORT_RULES.avoidKeywords[i]) !== -1) return false;
  }

  if (product.productRating && parseFloat(product.productRating) < IMPORT_RULES.minRating) return false;

  return true;
}

async function getConfig() {
  var config = await SupplierConfig.findOne({ supplierType: 'CJ_USA' });
  if (!config) throw new Error('CJ USA supplier not configured');
  if (!config.isActive) throw new Error('CJ USA supplier is disabled');
  return config;
}

async function cjFetch(endpoint, options) {
  var config = await getConfig();
  var url = CJ_BASE_URL + endpoint;
  var headers = {
    'Content-Type': 'application/json',
    'CJ-Access-Token': config.credentials.accessToken
  };

  var fetchOptions = {
    method: options.method || 'GET',
    headers: headers
  };
  if (options.body) fetchOptions.body = JSON.stringify(options.body);

  var response = await fetch(url, fetchOptions);
  var data = await response.json();

  if (!data.result) {
    throw new Error('CJ API error: ' + (data.message || 'Unknown error'));
  }
  return data;
}

async function refreshAccessToken() {
  var config = await getConfig();
  var response = await fetch(CJ_BASE_URL + '/authentication/refreshAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken: config.credentials.refreshToken })
  });
  var data = await response.json();
  if (!data.result) throw new Error('Token refresh failed: ' + data.message);

  config.credentials.accessToken = data.data.accessToken;
  config.credentials.refreshToken = data.data.refreshToken;
  config.credentials.tokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  await config.save();
  return config;
}

async function getAccessToken(email, password) {
  var response = await fetch(CJ_BASE_URL + '/authentication/getAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  var data = await response.json();
  if (!data.result) throw new Error('Auth failed: ' + data.message);
  return data.data;
}

async function testConnection() {
  try {
    var data = await cjFetch('/product/list', { method: 'GET' });
    return { success: true, message: 'Connected to CJ Dropshipping' };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

async function fetchProducts(params) {
  var query = '?pageNum=' + (params.page || 1) + '&pageSize=' + (params.limit || 20);
  if (params.categoryId) query += '&categoryId=' + params.categoryId;
  if (params.productName) query += '&productNameEn=' + encodeURIComponent(params.productName);

  var data = await cjFetch('/product/list' + query, { method: 'GET' });
  return data.data;
}

async function getProductDetail(pid) {
  var data = await cjFetch('/product/query?pid=' + pid, { method: 'GET' });
  return data.data;
}

async function importProduct(cjProduct, categorySlug, subcategorySlug) {
  var config = await getConfig();
  var store = await InternationalStore.findOne({ supplierType: 'CJ_USA' });
  if (!store) throw new Error('CJ USA store not found');

  var costUSD = parseFloat(cjProduct.sellPrice || cjProduct.productPrice || 0);
  var markup = config.settings.markupPercent / 100;
  var sellingUSD = costUSD * (1 + markup);
  var exchangeRate = config.settings.exchangeRateHTG;
  var finalHTG = Math.round(sellingUSD * exchangeRate);

  var images = [];
  if (cjProduct.productImage) images.push(cjProduct.productImage);
  if (cjProduct.productImageSet) {
    cjProduct.productImageSet.forEach(function(img) {
      if (img && images.length < 10) images.push(img);
    });
  }

  var variants = [];
  if (cjProduct.variants && cjProduct.variants.length > 0) {
    var variantGroups = {};
    cjProduct.variants.forEach(function(v) {
      if (!variantGroups[v.variantProperty]) variantGroups[v.variantProperty] = [];
      variantGroups[v.variantProperty].push(v.variantValue);
    });
    Object.keys(variantGroups).forEach(function(key) {
      variants.push({ name: key, options: variantGroups[key], priceModifier: 0 });
    });
  }

  var existing = await InternationalProduct.findOne({ externalId: cjProduct.pid, supplierType: 'CJ_USA' });
  if (existing) {
    existing.name = cjProduct.productNameEn || cjProduct.productName || existing.name;
    existing.description = cjProduct.description || existing.description;
    existing.images = images.length > 0 ? images : existing.images;
    existing.sourcePrice = costUSD;
    existing.markupPercent = config.settings.markupPercent;
    existing.exchangeRate = exchangeRate;
    existing.finalPriceHTG = finalHTG;
    existing.variants = variants;
    existing.weight = cjProduct.productWeight || 0;
    existing.inventory = cjProduct.stock !== undefined ? cjProduct.stock : -1;
    existing.inStock = cjProduct.stock === undefined || cjProduct.stock > 0;
    existing.lastSyncedAt = new Date();
    if (categorySlug) existing.category = categorySlug;
    if (subcategorySlug) existing.subcategory = subcategorySlug;
    await existing.save();
    return existing;
  }

  var product = await InternationalProduct.create({
    store: store._id,
    name: cjProduct.productNameEn || cjProduct.productName || 'Unnamed Product',
    description: cjProduct.description || '',
    category: categorySlug || 'General',
    subcategory: subcategorySlug || '',
    sku: cjProduct.productSku || '',
    externalId: cjProduct.pid,
    supplierType: 'CJ_USA',
    images: images,
    variants: variants,
    weight: cjProduct.productWeight || 0,
    warehouse: 'CJ USA',
    sourcePrice: costUSD,
    sourceCurrency: 'USD',
    markupPercent: config.settings.markupPercent,
    exchangeRate: exchangeRate,
    serviceFee: 0,
    logisticsFee: 0,
    customsDuty: 0,
    finalPriceHTG: finalHTG,
    inventory: cjProduct.stock !== undefined ? cjProduct.stock : -1,
    inStock: cjProduct.stock === undefined || cjProduct.stock > 0,
    estimatedDeliveryDays: config.settings.estimatedDeliveryDays,
    lastSyncedAt: new Date()
  });

  await InternationalStore.findByIdAndUpdate(store._id, { $inc: { 'stats.totalProducts': 1 } });
  return product;
}

async function syncInventory() {
  var config = await getConfig();
  var store = await InternationalStore.findOne({ supplierType: 'CJ_USA' });
  if (!store) return { updated: 0, errors: [] };

  var products = await InternationalProduct.find({ supplierType: 'CJ_USA', isActive: true });
  var updated = 0;
  var errors = [];

  for (var i = 0; i < products.length; i++) {
    try {
      if (!products[i].externalId) continue;
      var detail = await getProductDetail(products[i].externalId);
      if (!detail) continue;

      var costUSD = parseFloat(detail.sellPrice || detail.productPrice || products[i].sourcePrice);
      var sellingUSD = costUSD * (1 + config.settings.markupPercent / 100);
      var finalHTG = Math.round(sellingUSD * config.settings.exchangeRateHTG);

      products[i].sourcePrice = costUSD;
      products[i].finalPriceHTG = finalHTG;
      products[i].exchangeRate = config.settings.exchangeRateHTG;
      products[i].inventory = detail.stock !== undefined ? detail.stock : -1;
      products[i].inStock = detail.stock === undefined || detail.stock > 0;
      products[i].lastSyncedAt = new Date();

      if (detail.productImage) {
        var imgs = [detail.productImage];
        if (detail.productImageSet) {
          detail.productImageSet.forEach(function(img) { if (img && imgs.length < 10) imgs.push(img); });
        }
        products[i].images = imgs;
      }

      await products[i].save();
      updated++;
    } catch (err) {
      errors.push({ productId: products[i]._id, error: err.message });
    }
  }

  config.lastSync.inventory = new Date();
  await config.save();

  return { updated, total: products.length, errors };
}

async function createCJOrder(order) {
  var config = await getConfig();

  var orderItems = [];
  for (var i = 0; i < order.items.length; i++) {
    var item = order.items[i];
    var product = await InternationalProduct.findById(item.product);
    if (!product || !product.externalId) continue;

    orderItems.push({
      vid: product.externalId,
      quantity: item.quantity,
      shippingName: order.deliveryAddress.street || ''
    });
  }

  if (orderItems.length === 0) {
    throw new Error('No valid CJ products in order');
  }

  var payload = {
    orderNumber: order.orderNumber,
    shippingZip: '',
    shippingCountry: 'HT',
    shippingProvince: order.deliveryAddress.zone || '',
    shippingCity: order.deliveryAddress.city || '',
    shippingAddress: order.deliveryAddress.street || '',
    shippingCustomerName: order.deliveryAddress.street || '',
    shippingPhone: order.deliveryAddress.phone || '',
    products: orderItems
  };

  var data = await cjFetch('/shopping/order/createOrder', {
    method: 'POST',
    body: payload
  });

  order.supplierOrderId = data.data.orderId || data.data.orderNum || '';
  order.supplierOrderData = data.data;
  order.status = 'purchased';
  order.statusHistory.push({ status: 'purchased', note: 'Order created in CJ Dropshipping' });

  var totalCost = 0;
  for (var j = 0; j < order.items.length; j++) {
    totalCost += order.items[j].sourcePrice * order.items[j].quantity;
  }
  order.settlement.supplierCostUSD = totalCost;
  order.settlement.exchangeRateUsed = config.settings.exchangeRateHTG;
  order.settlement.platformProfit = order.totalHTG - Math.round(totalCost * config.settings.exchangeRateHTG);

  await order.save();

  config.stats.totalOrders++;
  config.stats.totalSupplierCost += totalCost;
  await config.save();

  return order;
}

async function syncTracking() {
  var config = await getConfig();
  var orders = await InternationalOrder.find({
    supplierType: 'CJ_USA',
    status: { $in: ['purchased', 'pickup', 'shipping'] },
    supplierOrderId: { $exists: true, $ne: '' }
  });

  var updated = 0;
  var errors = [];

  for (var i = 0; i < orders.length; i++) {
    try {
      var data = await cjFetch('/shopping/order/getOrderDetail?orderId=' + orders[i].supplierOrderId, { method: 'GET' });
      if (!data.data) continue;

      var cjOrder = data.data;
      if (cjOrder.trackNumber && cjOrder.trackNumber !== orders[i].trackingNumber) {
        orders[i].trackingNumber = cjOrder.trackNumber;

        if (!orders[i].logistics.legs || orders[i].logistics.legs.length === 0) {
          orders[i].logistics.legs = [
            { label: 'CJ Warehouse to Miami', carrier: cjOrder.logisticName || 'CJ Logistics', trackingNumber: cjOrder.trackNumber, status: 'in_transit', origin: 'CJ USA Warehouse', destination: 'Miami Freight Hub' },
            { label: 'Miami to Haiti', carrier: 'Freight Forwarder', trackingNumber: '', status: 'pending', origin: 'Miami', destination: 'Haiti' },
            { label: 'Haiti Local Delivery', carrier: 'MsouWout Delivery', trackingNumber: '', status: 'pending', origin: 'Haiti Port/Airport', destination: 'Customer' }
          ];
        }

        if (orders[i].status === 'purchased') {
          orders[i].status = 'shipping';
          orders[i].statusHistory.push({ status: 'shipping', note: 'Tracking: ' + cjOrder.trackNumber });
        }
        await orders[i].save();
        updated++;
      }
    } catch (err) {
      errors.push({ orderId: orders[i]._id, error: err.message });
    }
  }

  config.lastSync.tracking = new Date();
  await config.save();

  return { updated, total: orders.length, errors };
}

async function getOrCreateCJStore() {
  var store = await InternationalStore.findOne({ supplierType: 'CJ_USA' });
  if (store) return store;

  store = await InternationalStore.create({
    name: 'CJ Dropshipping USA',
    country: 'US',
    supplierType: 'CJ_USA',
    description: 'CJ Dropshipping US warehouse products',
    category: 'general',
    serviceFeePercent: 0,
    logisticsFeeHTG: 0,
    customsDutyPercent: 0,
    estimatedDeliveryDays: 21,
    isActive: true
  });
  return store;
}

async function smartImportPhase1(progressCallback) {
  var config = await getConfig();
  var store = await getOrCreateCJStore();
  var imported = 0;
  var skipped = 0;
  var errors = [];
  var categories = IMPORT_RULES.phase1Categories;

  for (var c = 0; c < categories.length; c++) {
    var cat = categories[c];
    if (progressCallback) progressCallback({ step: c + 1, total: categories.length, search: cat.search, imported: imported });

    try {
      var page = 1;
      var maxPages = 5;

      while (page <= maxPages && imported < 1000) {
        var results = await fetchProducts({ page: page, limit: 20, productName: cat.search });
        if (!results || !results.list || results.list.length === 0) break;

        for (var i = 0; i < results.list.length; i++) {
          var p = results.list[i];

          if (!passesImportFilter(p)) {
            skipped++;
            continue;
          }

          // Check USA warehouse
          var hasUSWarehouse = true;
          if (p.sourceFrom) {
            hasUSWarehouse = p.sourceFrom.indexOf('US') !== -1 || p.sourceFrom.indexOf('USA') !== -1;
          }
          if (p.countryCode && p.countryCode !== 'US') {
            hasUSWarehouse = false;
          }

          if (!hasUSWarehouse) {
            skipped++;
            continue;
          }

          try {
            await importProduct(p, cat.category, cat.subcategory);
            imported++;
          } catch (err) {
            errors.push({ product: p.productNameEn || p.pid, error: err.message });
          }
        }

        if (results.list.length < 20) break;
        page++;
      }
    } catch (err) {
      errors.push({ category: cat.search, error: err.message });
    }
  }

  config.lastSync.products = new Date();
  await config.save();

  return { imported, skipped, errors, totalSearches: categories.length };
}

async function getFeaturedProducts(limit) {
  var products = await InternationalProduct.find({
    supplierType: 'CJ_USA',
    isActive: true,
    inStock: true
  }).sort({ orderCount: -1 }).limit(limit || 20)
    .populate('store', 'name country logo');

  return products;
}

async function getFeaturedByCategory(categorySlug, limit) {
  var products = await InternationalProduct.find({
    supplierType: 'CJ_USA',
    isActive: true,
    inStock: true,
    category: categorySlug
  }).sort({ orderCount: -1 }).limit(limit || 10)
    .populate('store', 'name country logo');

  return products;
}

module.exports = {
  testConnection,
  getAccessToken,
  refreshAccessToken,
  fetchProducts,
  getProductDetail,
  importProduct,
  syncInventory,
  createCJOrder,
  syncTracking,
  getOrCreateCJStore,
  getConfig,
  smartImportPhase1,
  getFeaturedProducts,
  getFeaturedByCategory,
  passesImportFilter,
  IMPORT_RULES
};
