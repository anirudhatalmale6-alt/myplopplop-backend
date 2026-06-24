var crypto = require('crypto');
var BaseAdapter = require('../supplierAdapter');
var InternationalOrder = require('../../models/InternationalOrder');
var InternationalProduct = require('../../models/InternationalProduct');

var WALMART_BASE_URL = 'https://developer.api.walmart.com/api-proxy/service/affil/product/v2';

function WalmartAdapter() {
  BaseAdapter.call(this, 'WALMART_USA');
}
WalmartAdapter.prototype = Object.create(BaseAdapter.prototype);
WalmartAdapter.prototype.constructor = WalmartAdapter;

WalmartAdapter.prototype.IMPORT_RULES = {
  maxWholesaleCostUSD: 150,
  minRating: 3.5,
  phase1: [
    { search: 'phone case', category: 'phones-electronics', subcategory: 'phone-cases' },
    { search: 'bluetooth earbuds', category: 'phones-electronics', subcategory: 'earbuds' },
    { search: 'smart watch', category: 'phones-electronics', subcategory: 'smart-watches' },
    { search: 'power bank', category: 'phones-electronics', subcategory: 'power-banks' },
    { search: 'wireless charger', category: 'phones-electronics', subcategory: 'chargers' },
    { search: 'security camera', category: 'phones-electronics', subcategory: 'security-cameras' },
    { search: 'solar light outdoor', category: 'solar-energy', subcategory: 'solar-flood-lights' },
    { search: 'solar power bank', category: 'solar-energy', subcategory: 'solar-batteries' },
    { search: 'solar generator portable', category: 'solar-energy', subcategory: 'solar-generators' },
    { search: 'car phone mount', category: 'auto-parts', subcategory: 'phone-holders' },
    { search: 'dash cam', category: 'auto-parts', subcategory: 'mirrors' },
    { search: 'LED headlight bulb', category: 'auto-parts', subcategory: 'led-lights' },
    { search: 'tire inflator portable', category: 'auto-parts', subcategory: 'tires' },
    { search: 'jump starter', category: 'auto-parts', subcategory: 'batteries' },
    { search: 'wig human hair', category: 'beauty-personal-care', subcategory: 'wigs' },
    { search: 'hair extensions', category: 'beauty-personal-care', subcategory: 'hair-extensions' },
    { search: 'ring light', category: 'beauty-personal-care', subcategory: 'salon-equipment' },
    { search: 'makeup organizer', category: 'beauty-personal-care', subcategory: 'cosmetics' },
    { search: 'air fryer', category: 'home-kitchen', subcategory: 'air-fryers' },
    { search: 'portable blender', category: 'home-kitchen', subcategory: 'blenders' },
    { search: 'electric kettle', category: 'home-kitchen', subcategory: 'kitchen-sets' },
    { search: 'mini fan portable', category: 'home-kitchen', subcategory: 'fans' },
    { search: 'baby monitor', category: 'phones-electronics', subcategory: 'security-cameras' },
    { search: 'portable speaker bluetooth', category: 'phones-electronics', subcategory: 'earbuds' }
  ],
  avoidKeywords: [
    'furniture', 'sofa', 'couch', 'desk', 'table', 'chair', 'bed', 'mattress',
    'refrigerator', 'fridge', 'washing machine', 'dryer', 'dishwasher',
    'wardrobe', 'cabinet', 'bookshelf', 'oversized', 'patio', 'grill'
  ]
};

WalmartAdapter.prototype._generateSignature = function(consumerId, privateKeyPem, keyVersion, timestamp) {
  var signData = consumerId + '\n' + timestamp + '\n' + keyVersion + '\n';
  var sign = crypto.createSign('RSA-SHA256');
  sign.update(signData);
  return sign.sign(privateKeyPem, 'base64');
};

WalmartAdapter.prototype._fetch = async function(endpoint, options) {
  var config = await this.getConfig();

  var consumerId = config.credentials.apiKey;
  var privateKeyPem = config.credentials.apiSecret;
  var keyVersion = config.credentials.extra.keyVersion || '1';

  if (!consumerId || !privateKeyPem) {
    throw new Error('Walmart API credentials not configured. Set Consumer ID and Private Key.');
  }

  var timestamp = Date.now().toString();
  var signature = this._generateSignature(consumerId, privateKeyPem, keyVersion, timestamp);

  var url = WALMART_BASE_URL + endpoint;
  var headers = {
    'WM_CONSUMER.ID': consumerId,
    'WM_CONSUMER.INTIMESTAMP': timestamp,
    'WM_SEC.KEY_VERSION': keyVersion,
    'WM_SEC.AUTH_SIGNATURE': signature,
    'Accept': 'application/json'
  };

  if (config.credentials.extra.publisherId) {
    url += (url.indexOf('?') === -1 ? '?' : '&') + 'publisherId=' + config.credentials.extra.publisherId;
  }

  var fetchOptions = {
    method: (options && options.method) || 'GET',
    headers: headers
  };

  var response = await fetch(url, fetchOptions);
  if (!response.ok) {
    var errText = await response.text();
    throw new Error('Walmart API ' + response.status + ': ' + errText.substring(0, 200));
  }
  return response.json();
};

WalmartAdapter.prototype.authenticate = async function(credentials) {
  var SupplierConfig = require('../../models/SupplierConfig');
  var config = await this.getConfig().catch(async function() {
    return SupplierConfig.create({ supplierType: 'WALMART_USA', name: 'Walmart USA' });
  });

  config.credentials.apiKey = credentials.consumerId;
  config.credentials.apiSecret = credentials.privateKey;
  config.credentials.extra = {
    keyVersion: credentials.keyVersion || '1',
    publisherId: credentials.publisherId || ''
  };
  config.isActive = true;
  await config.save();
  await this.ensureStore('Walmart USA', 'US');

  return { success: true };
};

WalmartAdapter.prototype.testConnection = async function() {
  try {
    await this._fetch('/search?query=phone&count=1', {});
    return { success: true, message: 'Connected to Walmart API' };
  } catch (err) {
    return { success: false, message: err.message };
  }
};

WalmartAdapter.prototype.fetchProducts = async function(params) {
  var query = '/search?query=' + encodeURIComponent(params.search || params.productName || 'electronics');
  query += '&count=' + (params.limit || 20);
  query += '&start=' + (((params.page || 1) - 1) * (params.limit || 20) + 1);

  if (params.categoryId) query += '&categoryId=' + params.categoryId;
  query += '&sort=relevance';

  var data = await this._fetch(query, {});

  var items = data.items || [];
  return {
    list: items,
    total: data.totalResults || items.length,
    pageSize: params.limit || 20,
    pageNum: params.page || 1
  };
};

WalmartAdapter.prototype.getProductDetail = async function(externalId) {
  var data = await this._fetch('/items/' + externalId, {});
  return data;
};

WalmartAdapter.prototype.normalizeProduct = function(raw) {
  var images = [];
  if (raw.largeImage) images.push(raw.largeImage);
  if (raw.mediumImage && images.length < 10) images.push(raw.mediumImage);
  if (raw.thumbnailImage && images.length < 10) images.push(raw.thumbnailImage);
  if (raw.imageEntities) {
    raw.imageEntities.forEach(function(img) {
      if (img.largeImage && images.length < 10) images.push(img.largeImage);
    });
  }

  var variants = [];
  if (raw.variants && raw.variants.length > 0) {
    raw.variants.forEach(function(v) {
      if (v.variantType && v.variantValue) {
        var existing = variants.find(function(vr) { return vr.name === v.variantType; });
        if (existing) {
          existing.options.push(v.variantValue);
        } else {
          variants.push({ name: v.variantType, options: [v.variantValue], priceModifier: 0 });
        }
      }
    });
  }

  var price = parseFloat(raw.salePrice || raw.msrp || 0);

  return {
    externalId: (raw.itemId || raw.usItemId || '').toString(),
    name: raw.name || 'Unnamed',
    description: raw.shortDescription || raw.longDescription || '',
    costUSD: price,
    sku: raw.upc || raw.modelNumber || '',
    images: images,
    variants: variants,
    weight: raw.weight ? parseFloat(raw.weight) : 0,
    inventory: raw.stock === 'Available' || raw.availableOnline ? -1 : 0,
    warehouse: 'Walmart USA',
    rating: raw.customerRating ? parseFloat(raw.customerRating) : null,
    numReviews: raw.numReviews || 0,
    brand: raw.brandName || '',
    affiliateUrl: raw.addToCartUrl || raw.productUrl || ''
  };
};

WalmartAdapter.prototype.passesFilter = function(rawProduct) {
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

WalmartAdapter.prototype.createSupplierOrder = async function(order) {
  var items = [];
  for (var i = 0; i < order.items.length; i++) {
    var product = await InternationalProduct.findById(order.items[i].product);
    if (!product || !product.externalId) continue;
    items.push({
      itemId: product.externalId,
      name: product.name,
      quantity: order.items[i].quantity,
      price: product.sourcePrice
    });
  }
  if (items.length === 0) throw new Error('No valid Walmart products in order');

  order.supplierOrderData = {
    source: 'walmart',
    items: items,
    purchaseMethod: 'manual',
    note: 'Purchase from walmart.com and ship to freight forwarder'
  };
  order.status = 'pending_purchase';
  order.statusHistory.push({
    status: 'pending_purchase',
    note: 'Walmart order created — awaiting manual purchase from walmart.com'
  });

  var totalCost = 0;
  for (var j = 0; j < order.items.length; j++) {
    totalCost += order.items[j].sourcePrice * order.items[j].quantity;
  }

  var config = await this.getConfig();
  order.settlement.supplierCostUSD = totalCost;
  order.settlement.exchangeRateUsed = config.settings.exchangeRateHTG;
  order.settlement.platformProfit = order.totalHTG - Math.round(totalCost * config.settings.exchangeRateHTG);
  await order.save();

  config.stats.totalOrders++;
  config.stats.totalSupplierCost += totalCost;
  await config.save();

  return order;
};

WalmartAdapter.prototype.syncTracking = async function() {
  var config = await this.getConfig();
  var orders = await InternationalOrder.find({
    supplierType: 'WALMART_USA',
    status: { $in: ['purchased', 'pickup', 'shipping'] },
    trackingNumber: { $exists: true, $ne: '' }
  });

  config.lastSync.tracking = new Date();
  await config.save();

  return { updated: 0, total: orders.length, errors: [], note: 'Walmart tracking synced manually' };
};

WalmartAdapter.prototype.smartImport = async function(progressCallback) {
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
      while (page <= 3 && imported < 500) {
        var results = await self.fetchProducts({ page: page, limit: 25, search: cat.search });
        if (!results || !results.list || results.list.length === 0) break;

        for (var i = 0; i < results.list.length; i++) {
          var p = results.list[i];
          if (!self.passesFilter(p)) { skipped++; continue; }

          try {
            await self.importProduct(p, cat.category, cat.subcategory);
            imported++;
          } catch (err) {
            errors.push({ product: (p.name || '').substring(0, 50), error: err.message });
          }
        }
        if (results.list.length < 25) break;
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

WalmartAdapter.prototype.getImportRules = function() {
  return this.IMPORT_RULES;
};

module.exports = WalmartAdapter;
