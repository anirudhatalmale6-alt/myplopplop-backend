/* ---------------------------------------------------------------------------
   The code that opens the ecosystem console.

   It used to be a literal in the route files, which meant anyone who read the
   repository could open the whole console. Nothing usable ships here any more:
   this file carries only a derivation of the one-time bootstrap code, and the
   code actually in force is whatever the owner sets for himself, stored salted
   in the database. The bootstrap keeps working as a recovery code — 100k
   PBKDF2 rounds over a random 10-character code is not something you can grind
   through from the derivation alone.

   There is deliberately no ADMIN_PIN environment escape hatch. One existed and
   the same weak value was configured for both services, so an override that
   cannot be inspected from here is a place for the old code to survive a fix.

   The same file lives in the haitibiznis backend: one console talks to both
   APIs, so both have to accept the same code.
   --------------------------------------------------------------------------- */
const crypto = require('crypto');
const AdminSetting = require('../models/AdminSetting');

const BOOTSTRAP_SALT = 'ecosystem-console-v1';
const BOOTSTRAP_HASH = '72d4e38371c145159f90c1f6d2e52ba973071fcb9d9bd1a34c10e1c5a653c7a8';
const PIN_ROUNDS = 100000;
const PIN_MIN = 6;

/* Typed on a phone, so spaces, dashes and lower case all have to pass. */
function normPin(s) {
  return String(s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}
function derive(code, salt) {
  return crypto.pbkdf2Sync(code, salt, PIN_ROUNDS, 32, 'sha256').toString('hex');
}
function sameSecret(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

let cache = { at: 0, doc: null };
async function setting() {
  if (Date.now() - cache.at < 15000) return cache.doc;
  try {
    const doc = await AdminSetting.findOne({ key: 'console' }).select('+pinSalt +pinHash');
    cache = { at: Date.now(), doc };
    return doc;
  } catch (e) {
    // A database hiccup must not lock him out of his own console — fall back
    // to the bootstrap code rather than answering 500 to every admin request.
    return null;
  }
}

async function pinIsValid(raw) {
  const supplied = String(raw || '');
  if (!supplied) return false;
  const norm = normPin(supplied);
  if (!norm) return false;
  const doc = await setting();
  if (doc && doc.pinHash && doc.pinSalt &&
      sameSecret(derive(norm, doc.pinSalt), doc.pinHash)) return true;
  return sameSecret(derive(norm, BOOTSTRAP_SALT), BOOTSTRAP_HASH);
}

async function requirePin(req, res, next) {
  try {
    const pin = req.headers['x-admin-pin'] || req.query.pin;
    if (!(await pinIsValid(pin))) return res.status(403).json({ error: 'Invalid PIN' });
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

/* Has he replaced the bootstrap code yet? The console nags until he has. */
async function isCustom() {
  const doc = await setting();
  return !!(doc && doc.pinHash);
}

async function setConsolePin(raw) {
  const norm = normPin(raw);
  if (norm.length < PIN_MIN) {
    const err = new Error('Use at least ' + PIN_MIN + ' letters or numbers');
    err.status = 400;
    throw err;
  }
  const salt = crypto.randomBytes(16).toString('hex');
  await AdminSetting.findOneAndUpdate(
    { key: 'console' },
    { key: 'console', pinSalt: salt, pinHash: derive(norm, salt), updatedAt: new Date() },
    { upsert: true, new: true }
  );
  cache = { at: 0, doc: null };
}

module.exports = { requirePin, pinIsValid, isCustom, setConsolePin, PIN_MIN };
