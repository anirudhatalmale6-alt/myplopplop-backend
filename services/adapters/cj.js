const BaseAdapter = require('../supplierAdapter');
const InternationalOrder = require('../../models/InternationalOrder');
const InternationalProduct = require('../../models/InternationalProduct');

var CJ_BASE_URL = 'https://developers.cjdropshipping.com/api2.0/v1';

function CJAdapter() {
  BaseAdapter.call(this, 'CJ_USA');
}
CJAdapter.prototype = Object.create(BaseAdapter.prototype);
CJAdapter.prototype.constructor = CJAdapter;

CJAdapter.prototype.IMPORT_RULES = {
  maxWholesaleCostUSD: 100,
  minRating: 4.5,
  warehouseFilter: 'US',
  phase1: [
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

// ─── CJ API helpers ───

CJAdapter.prototype._fetch = async function(endpoint, options) {
  var config = await this.getConfig();
  var url = CJ_BASE_URL + endpoint;
  var fetchOptions = {
    method: (options && options.method) || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'CJ-Access-Token': config.credentials.accessToken
    }
  };
  if (options && options.body) fetchOptions.body = JSON.stringify(options.body);

  var response = await fetch(url, fetchOptions);
  var data = await response.json();
  if (!data.result) throw new Error('CJ API: ' + (data.message || 'Unknown error'));
  return data;
};

// ─── Interface implementations ───

CJAdapter.prototype.authenticate = async function(credentials) {
  var response = await fetch(CJ_BASE_URL + '/authentication/getAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: credentials.email, password: credentials.password })
  });
  var data = await response.json();
  if (!data.result) throw new Error('Auth failed: ' + data.message);

  var config = await this.getConfig().catch(async function() {
    return require('../../models/SupplierConfig').create({ supplierType: 'CJ_USA', name: 'CJ Dropshipping USA' });
  });
  config.credentials.accessToken = data.data.accessToken;
  config.credentials.refreshToken = data.data.refreshToken;
  config.credentials.tokenExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  config.isActive = true;
  await config.save();
  await this.ensureStore('CJ Dropshipping USA', 'US');

  return { success: true };
};

CJAdapter.prototype.testConnection = async function() {
  try {
    await this._fetch('/product/list?pageNum=1&pageSize=1', {});
    return { success: true, message: 'Connected to CJ Dropshipping' };
  } catch (err) {
    return { success: false, message: err.message };
  }
};

CJAdapter.prototype.fetchProducts = async function(params) {
  var query = '?pageNum=' + (params.page || 1) + '&pageSize=' + (params.limit || 20);
  if (params.categoryId) query += '&categoryId=' + params.categoryId;
  if (params.search) query += '&productNameEn=' + encodeURIComponent(params.search);

  var data = await this._fetch('/product/list' + query, {});
  return data.data;
};

CJAdapter.prototype.getProductDetail = async function(externalId) {
  var data = await this._fetch('/product/query?pid=' + externalId, {});
  return data.data;
};

CJAdapter.prototype.normalizeProduct = function(raw) {
  var images = [];
  if (raw.productImage) images.push(raw.productImage);
  if (raw.productImageSet) {
    raw.productImageSet.forEach(function(img) { if (img && images.length < 10) images.push(img); });
  }

  var variants = [];
  if (raw.variants && raw.variants.length > 0) {
    var groups = {};
    raw.variants.forEach(function(v) {
      if (!groups[v.variantProperty]) groups[v.variantProperty] = [];
      groups[v.variantProperty].push(v.variantValue);
    });
    Object.keys(groups).forEach(function(key) {
      variants.push({ name: key, options: groups[key], priceModifier: 0 });
    });
  }

  return {
    externalId: raw.pid || '',
    name: raw.productNameEn || raw.productName || 'Unnamed',
    description: raw.description || '',
    costUSD: parseFloat(raw.sellPrice || raw.productPrice || 0),
    sku: raw.productSku || '',
    images: images,
    variants: variants,
    weight: raw.productWeight || 0,
    inventory: raw.stock !== undefined ? raw.stock : -1,
    warehouse: 'CJ USA',
    rating: raw.productRating ? parseFloat(raw.productRating) : null,
    sourceFrom: raw.sourceFrom || ''
  };
};

CJAdapter.prototype.passesFilter = function(rawProduct) {
  var normalized = this.normalizeProduct(rawProduct);
  if (normalized.costUSD > this.IMPORT_RULES.maxWholesaleCostUSD) return false;
  if (normalized.costUSD <= 0) return false;

  var name = normalized.name.toLowerCase();
  for (var i = 0; i < this.IMPORT_RULES.avoidKeywords.length; i++) {
    if (name.indexOf(this.IMPORT_RULES.avoidKeywords[i]) !== -1) return false;
  }
  if (normalized.rating !== null && normalized.rating < this.IMPORT_RULES.minRating) return false;

  return true;
};

CJAdapter.prototype.createSupplierOrder = async function(order) {
  var config = await this.getConfig();

  var orderItems = [];
  for (var i = 0; i < order.items.length; i++) {
    var product = await InternationalProduct.findById(order.items[i].product);
    if (!product || !product.externalId) continue;
    orderItems.push({
      vid: product.externalId,
      quantity: order.items[i].quantity,
      shippingName: order.deliveryAddress.street || ''
    });
  }
  if (orderItems.length === 0) throw new Error('No valid CJ products in order');

  var data = await this._fetch('/shopping/order/createOrder', {
    method: 'POST',
    body: {
      orderNumber: order.orderNumber,
      shippingZip: '',
      shippingCountry: 'HT',
      shippingProvince: order.deliveryAddress.zone || '',
      shippingCity: order.deliveryAddress.city || '',
      shippingAddress: order.deliveryAddress.street || '',
      shippingCustomerName: order.deliveryAddress.street || '',
      shippingPhone: order.deliveryAddress.phone || '',
      products: orderItems
    }
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
};

CJAdapter.prototype.syncTracking = async function() {
  var config = await this.getConfig();
  var self = this;
  var orders = await InternationalOrder.find({
    supplierType: 'CJ_USA',
    status: { $in: ['purchased', 'pickup', 'shipping'] },
    supplierOrderId: { $exists: true, $ne: '' }
  });

  var updated = 0;
  var errors = [];

  for (var i = 0; i < orders.length; i++) {
    try {
      var data = await self._fetch('/shopping/order/getOrderDetail?orderId=' + orders[i].supplierOrderId, {});
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
};

CJAdapter.prototype.smartImport = async function(progressCallback) {
  var self = this;
  var imported = 0;
  var skipped = 0;
  var errors = [];
  var categories = this.IMPORT_RULES.phase1;

  for (var c = 0; c < categories.length; c++) {
    var cat = categories[c];
    if (progressCallback) progressCallback({ step: c + 1, total: categories.length, search: cat.search, imported: imported });

    try {
      var page = 1;
      while (page <= 5 && imported < 1000) {
        var results = await self.fetchProducts({ page: page, limit: 20, search: cat.search });
        if (!results || !results.list || results.list.length === 0) break;

        for (var i = 0; i < results.list.length; i++) {
          var p = results.list[i];
          if (!self.passesFilter(p)) { skipped++; continue; }

          var norm = self.normalizeProduct(p);
          if (norm.sourceFrom && norm.sourceFrom.indexOf('US') === -1) { skipped++; continue; }

          try {
            await self.importProduct(p, cat.category, cat.subcategory);
            imported++;
          } catch (err) {
            errors.push({ product: norm.name, error: err.message });
          }
        }
        if (results.list.length < 20) break;
        page++;
      }
    } catch (err) {
      errors.push({ category: cat.search, error: err.message });
    }
  }

  var config = await self.getConfig();
  config.lastSync.products = new Date();
  await config.save();

  return { imported, skipped, errors, totalSearches: categories.length };
};

CJAdapter.prototype.getImportRules = function() {
  return this.IMPORT_RULES;
};

module.exports = CJAdapter;
