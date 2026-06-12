var CJAdapter = require('./adapters/cj');
var ManualAdapter = require('./adapters/manual');

var adapters = {};

function register(supplierType, AdapterClass) {
  adapters[supplierType] = AdapterClass;
}

function get(supplierType) {
  var AdapterClass = adapters[supplierType];
  if (!AdapterClass) {
    return new ManualAdapter(supplierType);
  }
  if (typeof AdapterClass === 'function') {
    return new AdapterClass();
  }
  return AdapterClass;
}

function list() {
  return Object.keys(adapters);
}

// Register built-in adapters
register('CJ_USA', CJAdapter);
register('MANUAL', ManualAdapter);
register('HAITI_MERCHANT', function() { ManualAdapter.call(this, 'HAITI_MERCHANT'); });
register('CUSTOM_DR', function() { ManualAdapter.call(this, 'CUSTOM_DR'); });
register('CUSTOM_PA', function() { ManualAdapter.call(this, 'CUSTOM_PA'); });
register('CUSTOM_USA', function() { ManualAdapter.call(this, 'CUSTOM_USA'); });

// Fix prototype chain for factory-created adapters
['HAITI_MERCHANT', 'CUSTOM_DR', 'CUSTOM_PA', 'CUSTOM_USA'].forEach(function(type) {
  var Cls = adapters[type];
  Cls.prototype = Object.create(ManualAdapter.prototype);
  Cls.prototype.constructor = Cls;
});

module.exports = { register, get, list };
