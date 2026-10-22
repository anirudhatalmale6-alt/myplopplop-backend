/* Server-to-server door: the caller must hold INTERNAL_SERVICE_KEY, the key
   haitibiznis-api and this service share. No key configured = door CLOSED
   (503), never open. Compared in constant time. */
const crypto = require('crypto');

module.exports = function requireInternalKey(req, res, next) {
  const expected = process.env.INTERNAL_SERVICE_KEY;
  if (!expected) return res.status(503).json({ error: 'link_not_configured' });
  const a = Buffer.from(String(req.get('x-internal-key') || ''));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(401).json({ error: 'unauthorized' });
  next();
};
