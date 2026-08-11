// Minimal Odoo external-API client (JSON-RPC).
//
// Odoo exposes both XML-RPC and JSON-RPC on every instance, community or
// enterprise, on-premise or hosted. JSON-RPC is used here so we need no extra
// dependency — one POST to /jsonrpc covers everything.
//
//   common.authenticate(db, login, password) -> uid
//   object.execute_kw(db, uid, password, model, method, args, kwargs)
//
// From Odoo 14 onwards "password" may be an API key (Settings → Users →
// Preferences → Account Security → New API Key), which is what we ask merchants
// for: it can be revoked without touching the user's real password.

const DEFAULT_TIMEOUT_MS = 30000;

function normalizeBaseUrl(baseUrl) {
  const url = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!url) throw new Error('Odoo base URL is not set');
  if (!/^https?:\/\//i.test(url)) throw new Error('Odoo base URL must start with http:// or https://');
  return url;
}

function OdooClient(config) {
  this.baseUrl = normalizeBaseUrl(config.baseUrl);
  this.db = String(config.database || '').trim();
  this.username = String(config.username || '').trim();
  this.apiKey = String(config.apiKey || '');
  this.timeout = config.timeoutMs || DEFAULT_TIMEOUT_MS;
  this.uid = null;
}

OdooClient.prototype._rpc = async function (service, method, args) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), this.timeout);

  let response;
  try {
    response = await fetch(this.baseUrl + '/jsonrpc', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        params: { service, method, args },
        id: Math.floor(Math.random() * 1e9)
      }),
      signal: controller.signal
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Odoo did not answer within ' + Math.round(this.timeout / 1000) + 's — is ' + this.baseUrl + ' reachable from the internet?');
    }
    throw new Error('Cannot reach Odoo at ' + this.baseUrl + ' (' + err.message + ')');
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();

  if (!response.ok && !text) {
    throw new Error('Odoo returned HTTP ' + response.status);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch (e) {
    // A login page or reverse-proxy error page instead of JSON almost always
    // means /jsonrpc is blocked or the URL points somewhere that isn't Odoo.
    throw new Error('Odoo returned a non-JSON response (HTTP ' + response.status + '). Check that ' + this.baseUrl + '/jsonrpc is reachable and not behind a login page or firewall.');
  }

  if (payload.error) {
    const data = payload.error.data || {};
    const msg = data.message || payload.error.message || 'Unknown Odoo error';
    const err = new Error(String(msg).trim());
    err.odooType = data.name || '';
    throw err;
  }

  return payload.result;
};

OdooClient.prototype.version = async function () {
  return this._rpc('common', 'version', []);
};

OdooClient.prototype.authenticate = async function () {
  if (!this.db) throw new Error('Odoo database name is not set');
  if (!this.username) throw new Error('Odoo username is not set');
  if (!this.apiKey) throw new Error('Odoo API key is not set');

  const uid = await this._rpc('common', 'authenticate', [this.db, this.username, this.apiKey, {}]);
  if (!uid) {
    throw new Error('Odoo rejected the login. Check the database name, the username, and that the API key belongs to that user.');
  }
  this.uid = uid;
  return uid;
};

OdooClient.prototype.execute = async function (model, method, args, kwargs) {
  if (!this.uid) await this.authenticate();
  return this._rpc('object', 'execute_kw', [
    this.db, this.uid, this.apiKey, model, method, args || [], kwargs || {}
  ]);
};

OdooClient.prototype.searchRead = function (model, domain, fields, opts) {
  const kwargs = { fields: fields || [] };
  if (opts && opts.limit) kwargs.limit = opts.limit;
  if (opts && opts.offset) kwargs.offset = opts.offset;
  if (opts && opts.order) kwargs.order = opts.order;
  if (opts && opts.context) kwargs.context = opts.context;
  return this.execute(model, 'search_read', [domain || []], kwargs);
};

OdooClient.prototype.searchCount = function (model, domain) {
  return this.execute(model, 'search_count', [domain || []]);
};

OdooClient.prototype.read = function (model, ids, fields) {
  return this.execute(model, 'read', [ids, fields || []]);
};

// Which of our fields actually exist on this Odoo instance. Studio/custom
// installs drop or rename fields, so ask before selecting them.
OdooClient.prototype.availableFields = async function (model, candidates) {
  const meta = await this.execute(model, 'fields_get', [candidates, ['type']]);
  return candidates.filter((f) => Object.prototype.hasOwnProperty.call(meta, f));
};

module.exports = { OdooClient, normalizeBaseUrl };
