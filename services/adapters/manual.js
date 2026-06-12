var BaseAdapter = require('../supplierAdapter');

function ManualAdapter(supplierType) {
  BaseAdapter.call(this, supplierType || 'MANUAL');
}
ManualAdapter.prototype = Object.create(BaseAdapter.prototype);
ManualAdapter.prototype.constructor = ManualAdapter;

// Manual suppliers don't have API endpoints
ManualAdapter.prototype.testConnection = async function() {
  return { success: true, message: 'Manual supplier — no API connection needed' };
};

ManualAdapter.prototype.normalizeProduct = function(raw) {
  return {
    externalId: raw.externalId || raw.sku || '',
    name: raw.name || 'Unnamed',
    description: raw.description || '',
    costUSD: parseFloat(raw.sourcePrice || raw.costUSD || 0),
    sku: raw.sku || '',
    images: raw.images || [],
    variants: raw.variants || [],
    weight: raw.weight || 0,
    inventory: raw.inventory !== undefined ? raw.inventory : -1,
    warehouse: raw.warehouse || ''
  };
};

module.exports = ManualAdapter;
