const mongoose = require('mongoose');

/* A single document holding the console code the owner has chosen for himself.
   It exists so that no working secret has to live in the source: what ships is
   only a derivation, and the code that is actually in force is stored here,
   salted, the moment he sets one. */
const adminSettingSchema = new mongoose.Schema({
  key: { type: String, default: 'console', unique: true, index: true },
  pinSalt: { type: String, select: false },
  pinHash: { type: String, select: false },
  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('AdminSetting', adminSettingSchema);
