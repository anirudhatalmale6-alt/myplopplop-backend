/* 4 Nov 2026 - THE one rule every "make this store active" door asks (same idea as the MsouWout driver
   approvalGate): a store an Ajan registered becomes public ONLY through Jennifer's approval
   (routes/merchantVerification.js). Stores created before that have no verification and are untouched. */
const OPEN = ['pending', 'fix', 'rejected'];

function waiting(store) {
  const v = store && store.verification;
  return !!(v && v.state && OPEN.indexOf(v.state) >= 0);
}
/* Mongo filter: stores NOT waiting for verification (for bulk updates) */
const notWaiting = { 'verification.state': { $nin: OPEN } };

module.exports = { waiting, notWaiting, OPEN };
