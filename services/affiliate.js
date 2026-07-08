// Global Product Search Engine — modular affiliate layer.
//
// Two modules, one catalog:
//   Module 1 (Affiliate)      -> buildAffiliateUrl(): tagged "Buy on X" link, we earn commission.
//   Module 2 (Order Through)  -> computeLanded(): customer pays MyPlopPlop in HTG, we import + deliver.
//
// Adding a retailer = add one entry to LINK_BUILDERS. Nothing else changes.

// ---------------------------------------------------------------------------
// Module 1 — affiliate link builders (one function per retailer)
// ---------------------------------------------------------------------------

var LINK_BUILDERS = {
  // Amazon Associates: append/replace the ?tag= parameter.
  amazon: function(product, affiliateId) {
    if (!affiliateId) return product.url || '';
    var base = product.url || ('https://www.amazon.com/dp/' + (product.externalId || ''));
    return base + (base.indexOf('?') === -1 ? '?' : '&') + 'tag=' + encodeURIComponent(affiliateId);
  },

  // eBay Partner Network — real EPN rover deep-link format (campid = Campaign ID).
  ebay: function(product, affiliateId) {
    var dest = product.url || ('https://www.ebay.com/itm/' + (product.externalId || ''));
    if (!affiliateId) return dest;
    return 'https://rover.ebay.com/rover/1/711-53200-19255-0/1?mpre=' +
      encodeURIComponent(dest) + '&campid=' + encodeURIComponent(affiliateId) + '&toolid=10001';
  },

  // Walmart (Impact publisher) — wrap the product URL with the publisher id.
  walmart: function(product, affiliateId) {
    var dest = product.url || '';
    if (!affiliateId) return dest;
    return 'https://goto.walmart.com/c/' + encodeURIComponent(affiliateId) +
      '/568844/9383?veh=aff&sourceid=imp&u=' + encodeURIComponent(dest);
  },

  // AliExpress portals — pid-tagged link.
  aliexpress: function(product, affiliateId) {
    var dest = product.url || '';
    if (!affiliateId) return dest;
    return 'https://s.click.aliexpress.com/deep_link.htm?aff_short_key=' +
      encodeURIComponent(affiliateId) + '&dl_target_url=' + encodeURIComponent(dest);
  },

  // Temu — affiliate program via query param (plugs in when approved).
  temu: function(product, affiliateId) {
    var dest = product.url || '';
    if (!affiliateId || !dest) return dest;
    return dest + (dest.indexOf('?') === -1 ? '?' : '&') + '_p_rfs=1&refer_share_id=' + encodeURIComponent(affiliateId);
  },

  // CJ Dropshipping is import-only (no consumer affiliate program).
  cj: function(product) { return product.url || ''; }
};

function buildAffiliateUrl(retailerKey, product, affiliateId) {
  var fn = LINK_BUILDERS[retailerKey];
  if (!fn) return product.url || '';
  return fn(product, affiliateId);
}

// ---------------------------------------------------------------------------
// Module 2 — landed price (what the customer pays MyPlopPlop, in HTG)
// ---------------------------------------------------------------------------

function computeLanded(priceUSD, fees) {
  priceUSD = parseFloat(priceUSD) || 0;
  var rate = fees.exchangeRateHTG || 135;
  var baseHTG = priceUSD * rate;

  var shippingMarkup = baseHTG * (fees.shippingMarkupPercent || 0) / 100;
  var serviceFee = baseHTG * (fees.serviceFeePercent || 0) / 100;
  var importFee = baseHTG * (fees.importFeePercent || 0) / 100;
  var deliveryFee = fees.deliveryFeeHTG || 0;

  var totalHTG = Math.round(baseHTG + shippingMarkup + serviceFee + importFee + deliveryFee);

  return {
    exchangeRateHTG: rate,
    breakdown: {
      productHTG: Math.round(baseHTG),
      shippingMarkupHTG: Math.round(shippingMarkup),
      serviceFeeHTG: Math.round(serviceFee),
      importFeeHTG: Math.round(importFee),
      deliveryFeeHTG: Math.round(deliveryFee)
    },
    totalHTG: totalHTG
  };
}

// ---------------------------------------------------------------------------
// Unified result shaping — turns any raw product into the two-option card.
// ---------------------------------------------------------------------------

function shapeResult(retailer, product, cfg) {
  // retailer: the config entry { key, name, affiliateId, affiliateEnabled, orderThroughEnabled }
  var landed = computeLanded(product.priceUSD, cfg.fees);
  return {
    id: retailer.key + ':' + (product.externalId || product.sku || product.name),
    retailer: retailer.key,
    store: retailer.name,
    name: product.name,
    image: product.image || '',
    priceUSD: parseFloat(product.priceUSD) || 0,
    rating: product.rating || null,
    affiliate: {
      enabled: !!retailer.affiliateEnabled && !!retailer.affiliateId,
      configured: !!retailer.affiliateId,
      url: buildAffiliateUrl(retailer.key, product, retailer.affiliateId)
    },
    orderThrough: retailer.orderThroughEnabled ? {
      enabled: true,
      totalHTG: landed.totalHTG,
      exchangeRateHTG: landed.exchangeRateHTG,
      breakdown: landed.breakdown
    } : { enabled: false }
  };
}

// ---------------------------------------------------------------------------
// Demo catalog — realistic sample products so the engine is fully
// demonstrable before live retailer APIs are approved/keyed.
// Each live adapter replaces its slice here as its API comes online.
// ---------------------------------------------------------------------------

var DEMO_CATALOG = [
  { retailer: 'amazon', name: 'Sony WH-1000XM5 Wireless Noise-Cancelling Headphones', priceUSD: 328.00, externalId: 'B09XS7JWHH', url: 'https://www.amazon.com/dp/B09XS7JWHH', rating: 4.7, keywords: 'headphones sony audio wireless bluetooth' },
  { retailer: 'amazon', name: 'Anker 737 Power Bank 24000mAh 140W', priceUSD: 109.99, externalId: 'B09VPHVT2Z', url: 'https://www.amazon.com/dp/B09VPHVT2Z', rating: 4.6, keywords: 'power bank charger anker battery phone' },
  { retailer: 'amazon', name: 'Apple AirPods Pro (2nd Generation)', priceUSD: 189.99, externalId: 'B0BDHWDR12', url: 'https://www.amazon.com/dp/B0BDHWDR12', rating: 4.8, keywords: 'airpods apple earbuds audio wireless phone' },
  { retailer: 'walmart', name: 'onn. 50" Class 4K UHD LED Roku Smart TV', priceUSD: 228.00, externalId: '910480139', url: 'https://www.walmart.com/ip/910480139', rating: 4.4, keywords: 'tv television smart roku 4k electronics' },
  { retailer: 'walmart', name: 'HP 15.6" Laptop, Intel Core i3, 8GB RAM, 256GB SSD', priceUSD: 349.00, externalId: '5032900420', url: 'https://www.walmart.com/ip/5032900420', rating: 4.3, keywords: 'laptop hp computer notebook electronics' },
  { retailer: 'walmart', name: 'Mainstays 4-Piece Bath Towel Set', priceUSD: 12.97, externalId: '827344521', url: 'https://www.walmart.com/ip/827344521', rating: 4.5, keywords: 'towel bath home cotton household' },
  { retailer: 'ebay', name: 'Samsung Galaxy S23 128GB Unlocked Smartphone', priceUSD: 469.99, externalId: '256123456789', url: 'https://www.ebay.com/itm/256123456789', rating: 4.6, keywords: 'phone samsung galaxy smartphone android unlocked' },
  { retailer: 'ebay', name: 'Casio G-Shock GA-2100 Watch', priceUSD: 89.95, externalId: '256987654321', url: 'https://www.ebay.com/itm/256987654321', rating: 4.9, keywords: 'watch casio gshock time wrist accessory' },
  { retailer: 'aliexpress', name: 'Wireless Bluetooth Earbuds TWS Touch Control', priceUSD: 14.32, externalId: '1005004321', url: 'https://www.aliexpress.com/item/1005004321.html', rating: 4.4, keywords: 'earbuds bluetooth wireless audio tws phone cheap' },
  { retailer: 'aliexpress', name: 'LED Strip Lights 10m RGB with Remote', priceUSD: 8.76, externalId: '1005006789', url: 'https://www.aliexpress.com/item/1005006789.html', rating: 4.5, keywords: 'led lights strip rgb home decor lighting' },
  { retailer: 'aliexpress', name: 'Foldable Phone Stand Aluminum Desktop Holder', priceUSD: 5.49, externalId: '1005007777', url: 'https://www.aliexpress.com/item/1005007777.html', rating: 4.7, keywords: 'phone stand holder desk aluminum accessory' },
  { retailer: 'cj', name: 'Portable Mini Blender USB Rechargeable 380ml', priceUSD: 11.20, externalId: 'CJ-BL380', url: '', rating: 4.3, keywords: 'blender kitchen portable usb home smoothie' }
];

// image url per demo item (Unsplash source keyword thumbnails; frontend has SVG fallback)
function demoImage(item) {
  var kw = (item.keywords || 'product').split(' ')[0];
  return 'https://source.unsplash.com/400x400/?' + encodeURIComponent(kw);
}

// ---------------------------------------------------------------------------
// searchDemo — unified search over the demo catalog (no DB needed).
// Live adapters override per-retailer slices as their APIs come online.
// ---------------------------------------------------------------------------

function searchDemo(query, cfg, retailerFilter) {
  var q = (query || '').toLowerCase().trim();
  var retailerMap = {};
  cfg.retailers.forEach(function(r) { retailerMap[r.key] = r; });

  var matches = DEMO_CATALOG.filter(function(item) {
    var r = retailerMap[item.retailer];
    if (!r) return false;
    // hide retailers with BOTH modules off
    if (!r.affiliateEnabled && !r.orderThroughEnabled) return false;
    if (retailerFilter && item.retailer !== retailerFilter) return false;
    if (!q) return true;
    var hay = (item.name + ' ' + (item.keywords || '')).toLowerCase();
    // match any query token
    return q.split(/\s+/).some(function(tok) { return hay.indexOf(tok) !== -1; });
  });

  return matches.map(function(item) {
    var r = retailerMap[item.retailer];
    return shapeResult(r, {
      externalId: item.externalId,
      name: item.name,
      priceUSD: item.priceUSD,
      url: item.url,
      rating: item.rating,
      image: demoImage(item)
    }, cfg);
  });
}

module.exports = {
  LINK_BUILDERS: LINK_BUILDERS,
  buildAffiliateUrl: buildAffiliateUrl,
  computeLanded: computeLanded,
  shapeResult: shapeResult,
  searchDemo: searchDemo,
  DEMO_CATALOG: DEMO_CATALOG
};
