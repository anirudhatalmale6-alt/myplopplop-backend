const mongoose = require('mongoose');

// Lightweight lead-capture for public "Parenaj Biznis" (Koutye) sign-ups made
// through the marketing form (koutye.html / parenaj.html). These are captured
// with just name + phone (no account/PIN) so the admin can see and follow up.
// An admin can later convert an approved signup into a full Koutye ambassador.
const parenajSignupSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  phone: { type: String, required: true, unique: true, trim: true },
  koutyeCode: { type: String, required: true, trim: true },
  referredBy: { type: String, trim: true, default: '' },
  source: { type: String, default: 'koutye.html' },
  status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' }
}, { timestamps: true });

parenajSignupSchema.index({ createdAt: -1 });

module.exports = mongoose.model('ParenajSignup', parenajSignupSchema);
