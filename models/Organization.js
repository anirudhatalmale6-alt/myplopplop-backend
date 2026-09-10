/* A partner organization: FTPH, Église Shalom, SPAP, Renaissance Ayiti, a
 * cooperative, a university, a modelling agency.
 *
 * Until now these were two lines of JavaScript hard-coded into
 * partner-dashboard.html, so adding one meant editing a file and deploying.
 * They are records now, and he can add them himself from the console.
 *
 * `slug` is the important field. It is what already appears in every referral
 * link a partner has handed out — myplopplop.com/merchant/register.html?ref=SPAP
 * — and what is written onto a shop's `referralPartner` and a driver's
 * `referral_partner`. ⛔ It must never be regenerated for an existing partner or
 * every link they have already printed and sent stops matching.
 */
const crypto = require('crypto');
const mongoose = require('mongoose');

const ACCESS_ROUNDS = 100000;

const organizationSchema = new mongoose.Schema({
  /* Exactly as it is written on the existing records. Matched without regard
     to case, because people type it however they like. */
  slug: { type: String, required: true, unique: true, index: true, trim: true, maxlength: 80 },
  name: { type: String, required: true, trim: true, maxlength: 80 },
  fullName: { type: String, trim: true, maxlength: 160, default: '' },
  logo: { type: String, trim: true, default: '' },
  color: { type: String, trim: true, default: '#00209F' },

  /* The code the organization's own administrator types to open their
     dashboard. Stored as a derivation with its own salt, never in the clear —
     same reasoning as the console code. */
  accessSalt: { type: String, select: false },
  accessHash: { type: String, select: false },

  status: { type: String, enum: ['active', 'suspended'], default: 'active' },
  note: { type: String, default: '', maxlength: 200 },
  lastOpenedAt: Date
}, { timestamps: true });

organizationSchema.methods.setAccessCode = function (raw) {
  const norm = String(raw || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (norm.length < 6) {
    const e = new Error('An access code needs at least 6 letters or numbers');
    e.status = 400;
    throw e;
  }
  this.accessSalt = crypto.randomBytes(16).toString('hex');
  this.accessHash = crypto.pbkdf2Sync(norm, this.accessSalt, ACCESS_ROUNDS, 32, 'sha256').toString('hex');
};

organizationSchema.methods.checkAccessCode = function (raw) {
  if (!this.accessSalt || !this.accessHash) return false;
  const norm = String(raw || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  if (!norm) return false;
  const got = crypto.pbkdf2Sync(norm, this.accessSalt, ACCESS_ROUNDS, 32, 'sha256').toString('hex');
  /* Constant time: the code is short and guessable-looking, so do not let the
     comparison itself leak how much of it was right. */
  const a = Buffer.from(got, 'utf8');
  const b = Buffer.from(this.accessHash, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

module.exports = mongoose.model('Organization', organizationSchema);
