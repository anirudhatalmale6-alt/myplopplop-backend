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

/* ─── 4 Nov 2026 (Jeffery, PATENTE) ───
   A Patente has no expiry date: it is valid for ONE fiscal year (1 Oct - 30 Sep, "Exercice Fiscal 2025-2026")
   and the next one is paid between 1 Oct and 31 Jan (dgi.gouv.ht). fy = the start year of that fiscal year.
   current = this fiscal year · grace = last year's, while renewal is still open (Oct-Jan) · expired = older. */
function fiscalStart(now) { now = now || new Date(); return now.getUTCMonth() >= 9 ? now.getUTCFullYear() : now.getUTCFullYear() - 1; }
function patenteFreshness(fy, now) {
  fy = Number(fy); now = now || new Date();
  if (!fy) return 'none';
  const cur = fiscalStart(now);
  if (fy > cur) return 'future';
  if (fy === cur) return 'current';
  const m = now.getUTCMonth();                       // renewal window: October (9) to January (0)
  if (fy === cur - 1 && (m >= 9 || m === 0)) return 'grace';
  return 'expired';
}
/* fiscal years a merchant may pick: this one, last one, and the one before (so an old certificate is still
   recorded honestly - it then shows as "pa ajou", it is never refused) */
function fiscalChoices(now) { const c = fiscalStart(now); return [c, c - 1, c - 2]; }

/* 🟢 needs: approved by Jennifer + Patente verified by her + a fiscal year that is current or in renewal.
   Everything else that is approved is 🟡 - identity verified, never presented as legally registered. */
function trustOf(v) {
  if (!v || v.state !== 'approved') return null;
  const p = v.patente || {};
  if (p.state === 'verified' && p.fy) return { level: 'patente', fy: p.fy };
  return { level: 'id' };
}
async function syncTrust(Store, id) {
  const s = await Store.findById(id).select('+verification').lean();
  if (!s) return null;
  const t = trustOf(s.verification);
  await Store.updateOne({ _id: id }, t ? { $set: { trust: t } } : { $unset: { trust: 1 } });
  return t;
}

/* Activities that need another authorisation on top of the Patente (servicespublics.gouv.ht: "Commerce de
   produits pharmaceutiques : Autorisation du Ministère de la Santé"). MyPlopPlop category: pharmacy. */
const LICENSED = { pharmacy: ['patente', 'mspp'] };
function licenceMissing(category, v, docTypes, now) {
  const need = LICENSED[category];
  if (!need) return [];
  const p = (v && v.patente) || {}, miss = [];
  if (need.indexOf('patente') >= 0) {
    const fresh = patenteFreshness(p.fy, now);
    if (docTypes.indexOf('patente') < 0) miss.push('patente');
    else if (p.state !== 'verified') miss.push('patente_unverified');
    else if (fresh !== 'current' && fresh !== 'grace') miss.push('patente_expired');
  }
  if (need.indexOf('mspp') >= 0 && docTypes.indexOf('mspp') < 0) miss.push('mspp');
  return miss;
}

module.exports = { waiting, notWaiting, OPEN, fiscalStart, patenteFreshness, fiscalChoices, trustOf, syncTrust, LICENSED, licenceMissing };
