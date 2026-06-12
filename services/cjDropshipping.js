const SupplierConfig = require('../models/SupplierConfig');
const InternationalStore = require('../models/InternationalStore');
const InternationalProduct = require('../models/InternationalProduct');
const InternationalOrder = require('../models/InternationalOrder');

const CJ_BASE_URL = 'https://developers.cjdropshipping.com/api2.0/v1';

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
  getConfig
};
