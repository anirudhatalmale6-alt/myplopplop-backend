const SupplierConfig = require('../models/SupplierConfig');
const InternationalStore = require('../models/InternationalStore');
const InternationalProduct = require('../models/InternationalProduct');
const InternationalOrder = require('../models/InternationalOrder');

// Base adapter — every supplier implements these methods
// Adapters that don't support an operation return null or throw 'Not supported'

function BaseAdapter(supplierType) {
  this.supplierType = supplierType;
}

BaseAdapter.prototype.getConfig = async function() {
  var config = await SupplierConfig.findOne({ supplierType: this.supplierType });
  if (!config) throw new Error(this.supplierType + ' supplier not configured');
  return config;
};

BaseAdapter.prototype.getStore = async function() {
  return InternationalStore.findOne({ supplierType: this.supplierType });
};

// Override in each adapter
BaseAdapter.prototype.authenticate = async function(credentials) { throw new Error('Not supported for ' + this.supplierType); };
BaseAdapter.prototype.testConnection = async function() { throw new Error('Not supported for ' + this.supplierType); };
BaseAdapter.prototype.fetchProducts = async function(params) { throw new Error('Not supported for ' + this.supplierType); };
BaseAdapter.prototype.getProductDetail = async function(externalId) { throw new Error('Not supported for ' + this.supplierType); };
BaseAdapter.prototype.createSupplierOrder = async function(order) { throw new Error('Not supported for ' + this.supplierType); };
BaseAdapter.prototype.syncTracking = async function() { throw new Error('Not supported for ' + this.supplierType); };
BaseAdapter.prototype.getImportRules = function() { return null; };

// Shared: import product into our DB (works for all adapters)
BaseAdapter.prototype.importProduct = async function(rawProduct, categorySlug, subcategorySlug) {
  var config = await this.getConfig();
  var store = await this.getStore();
  if (!store) throw new Error(this.supplierType + ' store not found');

  var normalized = this.normalizeProduct(rawProduct);

  var costUSD = normalized.costUSD;
  var markup = config.settings.markupPercent / 100;
  var sellingUSD = costUSD * (1 + markup);
  var exchangeRate = config.settings.exchangeRateHTG;
  var finalHTG = Math.round(sellingUSD * exchangeRate);

  var existing = await InternationalProduct.findOne({ externalId: normalized.externalId, supplierType: this.supplierType });
  if (existing) {
    existing.name = normalized.name || existing.name;
    existing.description = normalized.description || existing.description;
    if (normalized.images.length > 0) existing.images = normalized.images;
    existing.sourcePrice = costUSD;
    existing.markupPercent = config.settings.markupPercent;
    existing.exchangeRate = exchangeRate;
    existing.finalPriceHTG = finalHTG;
    existing.variants = normalized.variants || existing.variants;
    existing.weight = normalized.weight || existing.weight;
    existing.inventory = normalized.inventory;
    existing.inStock = normalized.inventory === -1 || normalized.inventory > 0;
    existing.lastSyncedAt = new Date();
    if (categorySlug) existing.category = categorySlug;
    if (subcategorySlug) existing.subcategory = subcategorySlug;
    await existing.save();
    return existing;
  }

  var product = await InternationalProduct.create({
    store: store._id,
    name: normalized.name,
    description: normalized.description,
    category: categorySlug || 'General',
    subcategory: subcategorySlug || '',
    sku: normalized.sku,
    externalId: normalized.externalId,
    supplierType: this.supplierType,
    images: normalized.images,
    variants: normalized.variants,
    weight: normalized.weight,
    warehouse: normalized.warehouse || this.supplierType,
    sourcePrice: costUSD,
    sourceCurrency: 'USD',
    markupPercent: config.settings.markupPercent,
    exchangeRate: exchangeRate,
    serviceFee: 0,
    logisticsFee: 0,
    customsDuty: 0,
    finalPriceHTG: finalHTG,
    inventory: normalized.inventory,
    inStock: normalized.inventory === -1 || normalized.inventory > 0,
    estimatedDeliveryDays: config.settings.estimatedDeliveryDays,
    lastSyncedAt: new Date()
  });

  await InternationalStore.findByIdAndUpdate(store._id, { $inc: { 'stats.totalProducts': 1 } });
  return product;
};

// Override per adapter: transform raw API data into a standard shape
BaseAdapter.prototype.normalizeProduct = function(raw) {
  return {
    externalId: raw.id || '',
    name: raw.name || 'Unnamed',
    description: raw.description || '',
    costUSD: parseFloat(raw.price || 0),
    sku: raw.sku || '',
    images: raw.images || [],
    variants: [],
    weight: 0,
    inventory: -1,
    warehouse: ''
  };
};

// Shared: sync inventory for all products of this supplier
BaseAdapter.prototype.syncInventory = async function() {
  var config = await this.getConfig();
  var products = await InternationalProduct.find({ supplierType: this.supplierType, isActive: true });
  var updated = 0;
  var errors = [];
  var self = this;

  for (var i = 0; i < products.length; i++) {
    try {
      if (!products[i].externalId) continue;
      var detail = await self.getProductDetail(products[i].externalId);
      if (!detail) continue;

      var normalized = self.normalizeProduct(detail);
      var costUSD = normalized.costUSD;
      var sellingUSD = costUSD * (1 + config.settings.markupPercent / 100);
      var finalHTG = Math.round(sellingUSD * config.settings.exchangeRateHTG);

      products[i].sourcePrice = costUSD;
      products[i].finalPriceHTG = finalHTG;
      products[i].exchangeRate = config.settings.exchangeRateHTG;
      products[i].inventory = normalized.inventory;
      products[i].inStock = normalized.inventory === -1 || normalized.inventory > 0;
      products[i].lastSyncedAt = new Date();
      if (normalized.images.length > 0) products[i].images = normalized.images;

      await products[i].save();
      updated++;
    } catch (err) {
      errors.push({ productId: products[i]._id, error: err.message });
    }
  }

  config.lastSync.inventory = new Date();
  await config.save();

  return { updated, total: products.length, errors };
};

// Shared: get stats for any supplier type
BaseAdapter.prototype.getStats = async function() {
  var config = await this.getConfig();
  var type = this.supplierType;

  var totalProducts = await InternationalProduct.countDocuments({ supplierType: type, isActive: true });
  var totalOrders = await InternationalOrder.countDocuments({ supplierType: type });
  var lowStock = await InternationalProduct.countDocuments({ supplierType: type, isActive: true, inventory: { $gt: 0, $lt: 10 } });

  var revenueAgg = await InternationalOrder.aggregate([
    { $match: { supplierType: type, status: { $nin: ['cancelled', 'refunded'] } } },
    { $group: { _id: null, revenue: { $sum: '$totalHTG' }, cost: { $sum: '$settlement.supplierCostUSD' }, profit: { $sum: '$settlement.platformProfit' } } }
  ]);

  var topProducts = await InternationalProduct.find({ supplierType: type, isActive: true })
    .sort({ orderCount: -1 }).limit(10).select('name images orderCount finalPriceHTG sourcePrice');

  return {
    totalProducts,
    totalOrders,
    lowStockAlerts: lowStock,
    revenue: revenueAgg.length > 0 ? revenueAgg[0] : { revenue: 0, cost: 0, profit: 0 },
    topProducts,
    lastSync: config.lastSync,
    settings: config.settings
  };
};

// Shared: get featured products for any supplier
BaseAdapter.prototype.getFeaturedProducts = async function(limit) {
  return InternationalProduct.find({ supplierType: this.supplierType, isActive: true, inStock: true })
    .sort({ orderCount: -1 }).limit(limit || 20)
    .populate('store', 'name country logo');
};

BaseAdapter.prototype.getFeaturedByCategory = async function(categorySlug, limit) {
  return InternationalProduct.find({ supplierType: this.supplierType, isActive: true, inStock: true, category: categorySlug })
    .sort({ orderCount: -1 }).limit(limit || 10)
    .populate('store', 'name country logo');
};

// Shared: get orders for this supplier
BaseAdapter.prototype.getOrders = async function(query, page, limit) {
  page = page || 1;
  limit = limit || 50;
  var skip = (page - 1) * limit;
  var q = Object.assign({ supplierType: this.supplierType }, query);

  var orders = await InternationalOrder.find(q)
    .populate('customer', 'firstName lastName phone')
    .sort({ createdAt: -1 }).skip(skip).limit(limit);
  var total = await InternationalOrder.countDocuments(q);

  return { orders, pagination: { page, limit, total } };
};

// Shared: ensure store exists for this supplier
BaseAdapter.prototype.ensureStore = async function(name, country) {
  var store = await InternationalStore.findOne({ supplierType: this.supplierType });
  if (store) return store;

  return InternationalStore.create({
    name: name || this.supplierType,
    country: country || 'US',
    supplierType: this.supplierType,
    description: name + ' products',
    category: 'general',
    serviceFeePercent: 0,
    logisticsFeeHTG: 0,
    customsDutyPercent: 0,
    estimatedDeliveryDays: 21,
    isActive: true
  });
};

module.exports = BaseAdapter;
