var BaseAdapter = require('../supplierAdapter');
var InternationalOrder = require('../../models/InternationalOrder');
var InternationalProduct = require('../../models/InternationalProduct');

var RAPIDAPI_HOST = 'shein-scraper-api.p.rapidapi.com';
var RAPIDAPI_BASE = 'https://' + RAPIDAPI_HOST;

function SheinAdapter() {
  BaseAdapter.call(this, 'SHEIN_USA');
}
SheinAdapter.prototype = Object.create(BaseAdapter.prototype);
SheinAdapter.prototype.constructor = SheinAdapter;

SheinAdapter.prototype.IMPORT_RULES = {
  maxWholesaleCostUSD: 80,
  minRating: 4.0,
  phase1: [
    { search: 'dress', category: 'clothing', subcategory: 'dresses' },
    { search: 'women tops', category: 'clothing', subcategory: 'tops' },
    { search: 'jeans', category: 'clothing', subcategory: 'jeans' },
    { search: 'sneakers', category: 'shoes', subcategory: 'sneakers' },
    { search: 'sandals women', category: 'shoes', subcategory: 'sandals' },
    { search: 'heels', category: 'shoes', subcategory: 'heels' },
    { search: 'handbag', category: 'accessories', subcategory: 'bags' },
    { search: 'backpack', category: 'accessories', subcategory: 'bags' },
    { search: 'sunglasses', category: 'accessories', subcategory: 'sunglasses' },
    { search: 'jewelry set', category: 'accessories', subcategory: 'jewelry' },
    { search: 'necklace', category: 'accessories', subcategory: 'jewelry' },
    { search: 'watch women', category: 'accessories', subcategory: 'watches' },
    { search: 'men t-shirt', category: 'clothing', subcategory: 'mens-tops' },
    { search: 'men shorts', category: 'clothing', subcategory: 'mens-bottoms' },
    { search: 'swimsuit', category: 'clothing', subcategory: 'swimwear' },
    { search: 'lingerie set', category: 'clothing', subcategory: 'lingerie' },
    { search: 'makeup brush set', category: 'beauty', subcategory: 'makeup-tools' },
    { search: 'false eyelashes', category: 'beauty', subcategory: 'eyelashes' },
    { search: 'hair accessories', category: 'beauty', subcategory: 'hair-accessories' },
    { search: 'phone case', category: 'accessories', subcategory: 'phone-cases' },
    { search: 'kids dress', category: 'kids', subcategory: 'kids-dresses' },
    { search: 'baby clothes', category: 'kids', subcategory: 'baby-clothes' },
    { search: 'home decor', category: 'home', subcategory: 'decor' },
    { search: 'bedding set', category: 'home', subcategory: 'bedding' }
  ],
  avoidKeywords: [
    'furniture', 'sofa', 'couch', 'desk', 'table', 'chair', 'bed frame',
    'mattress', 'wardrobe', 'cabinet', 'bookshelf', 'oversized', 'plus size 5xl'
  ]
};

SheinAdapter.prototype._fetch = async function(endpoint, options) {
  var config = await this.getConfig();
  var apiKey = config.credentials.apiKey;

  if (!apiKey) {
    throw new Error('Shein API key not configured. Set RapidAPI key.');
  }

  var url = RAPIDAPI_BASE + endpoint;
  var fetchOptions = {
    method: (options && options.method) || 'GET',
    headers: {
      'x-rapidapi-key': apiKey,
      'x-rapidapi-host': RAPIDAPI_HOST
    }
  };

  var response = await fetch(url, fetchOptions);
  if (!response.ok) {
    var errText = await response.text();
    throw new Error('Shein API ' + response.status + ': ' + errText.substring(0, 200));
  }
  return response.json();
};

SheinAdapter.prototype.authenticate = async function(credentials) {
  var SupplierConfig = require('../../models/SupplierConfig');
  var config = await this.getConfig().catch(async function() {
    return SupplierConfig.create({ supplierType: 'SHEIN_USA', name: 'SHEIN USA' });
  });

  config.credentials.apiKey = credentials.rapidApiKey;
  config.isActive = true;
  await config.save();
  await this.ensureStore('SHEIN USA', 'US');

  return { success: true };
};

SheinAdapter.prototype.testConnection = async function() {
  try {
    await this._fetch('/shein/product/details?goods_id=16477544&currency=usd&country=us&language=en', {});
    return { success: true, message: 'Connected to SHEIN API' };
  } catch (err) {
    return { success: false, message: err.message };
  }
};

SheinAdapter.prototype.fetchProducts = async function(params) {
  var query = '/shein/product/search?language=en&country=us&currency=usd';
  query += '&q=' + encodeURIComponent(params.search || params.productName || 'fashion');
  query += '&limit=' + (params.limit || 20);
  query += '&page=' + (params.page || 1);

  if (params.sort) query += '&sort=' + params.sort;

  var data = await this._fetch(query, {});

  var items = [];
  if (data.data && data.data.products) {
    items = data.data.products;
  } else if (data.info && data.info.products) {
    items = data.info.products;
  } else if (data.products) {
    items = data.products;
  } else if (Array.isArray(data.data)) {
    items = data.data;
  } else if (Array.isArray(data)) {
    items = data;
  }

  return {
    list: items,
    total: (data.data && data.data.total) || (data.info && data.info.total) || items.length,
    pageSize: params.limit || 20,
    pageNum: params.page || 1
  };
};

SheinAdapter.prototype.getProductDetail = async function(externalId) {
  var data = await this._fetch('/shein/product/details?goods_id=' + externalId + '&language=en&country=us&currency=usd', {});
  return data.data || data.info || data;
};

SheinAdapter.prototype.normalizeProduct = function(raw) {
  var images = [];
  if (raw.goods_img) images.push(raw.goods_img);
  if (raw.original_img) images.push(raw.original_img);
  if (raw.detail_image) {
    raw.detail_image.forEach(function(img) {
      var url = typeof img === 'string' ? img : (img.origin_image || img.medium_image || '');
      if (url && images.length < 10) images.push(url);
    });
  }
  if (raw.goods_imgs && raw.goods_imgs.detail_image) {
    raw.goods_imgs.detail_image.forEach(function(img) {
      var url = typeof img === 'string' ? img : (img.origin_image || '');
      if (url && images.length < 10) images.push(url);
    });
  }

  var variants = [];
  if (raw.productDetails) {
    raw.productDetails.forEach(function(attr) {
      if (attr.attr_name && attr.attr_value) {
        variants.push({ name: attr.attr_name, options: [attr.attr_value], priceModifier: 0 });
      }
    });
  }
  if (raw.relation_color) {
    var colors = raw.relation_color.map(function(c) { return c.goods_title || c.color_name || ''; }).filter(Boolean);
    if (colors.length > 0) {
      variants.push({ name: 'Color', options: colors, priceModifier: 0 });
    }
  }

  var price = 0;
  if (raw.salePrice && raw.salePrice.amount) {
    price = parseFloat(raw.salePrice.amount);
  } else if (raw.sale_price) {
    price = parseFloat(typeof raw.sale_price === 'object' ? raw.sale_price.amount : raw.sale_price);
  } else if (raw.retailPrice && raw.retailPrice.amount) {
    price = parseFloat(raw.retailPrice.amount);
  } else if (raw.retail_price) {
    price = parseFloat(typeof raw.retail_price === 'object' ? raw.retail_price.amount : raw.retail_price);
  }

  var rating = null;
  if (raw.comment_rank_average) rating = parseFloat(raw.comment_rank_average);
  else if (raw.averageRating) rating = parseFloat(raw.averageRating);

  return {
    externalId: (raw.goods_id || raw.goods_sn || raw.id || '').toString(),
    name: raw.goods_name || raw.goods_title || raw.name || 'Unnamed',
    description: raw.detail || raw.goods_desc || '',
    costUSD: price,
    sku: raw.goods_sn || raw.productCode || '',
    images: images,
    variants: variants,
    weight: 0,
    inventory: raw.is_on_sale === 0 ? 0 : -1,
    warehouse: 'SHEIN USA',
    rating: rating,
    brand: 'SHEIN',
    productUrl: raw.goods_url_name ? ('https://us.shein.com/' + raw.goods_url_name) : ''
  };
};

SheinAdapter.prototype.passesFilter = function(rawProduct) {
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

SheinAdapter.prototype.createSupplierOrder = async function(order) {
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
  if (items.length === 0) throw new Error('No valid SHEIN products in order');

  order.supplierOrderData = {
    source: 'shein',
    items: items,
    purchaseMethod: 'manual',
    note: 'Purchase from us.shein.com and ship to freight forwarder in Florida'
  };
  order.status = 'pending_purchase';
  order.statusHistory.push({
    status: 'pending_purchase',
    note: 'SHEIN order created — awaiting manual purchase from us.shein.com'
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

SheinAdapter.prototype.syncTracking = async function() {
  var config = await this.getConfig();
  var orders = await InternationalOrder.find({
    supplierType: 'SHEIN_USA',
    status: { $in: ['purchased', 'pickup', 'shipping'] }
  });

  config.lastSync.tracking = new Date();
  await config.save();

  return { updated: 0, total: orders.length, errors: [], note: 'SHEIN tracking synced manually' };
};

SheinAdapter.prototype.smartImport = async function(progressCallback) {
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
        var results = await self.fetchProducts({ page: page, limit: 20, search: cat.search });
        if (!results || !results.list || results.list.length === 0) break;

        for (var i = 0; i < results.list.length; i++) {
          var p = results.list[i];
          if (!self.passesFilter(p)) { skipped++; continue; }

          try {
            await self.importProduct(p, cat.category, cat.subcategory);
            imported++;
          } catch (err) {
            errors.push({ product: (self.normalizeProduct(p).name || '').substring(0, 50), error: err.message });
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

SheinAdapter.prototype.getImportRules = function() {
  return this.IMPORT_RULES;
};

module.exports = SheinAdapter;
