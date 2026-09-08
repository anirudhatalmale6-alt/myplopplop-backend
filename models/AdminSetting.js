const mongoose = require('mongoose');

/* A single document holding the console code the owner has chosen for himself.
   It exists so that no working secret has to live in the source: what ships is
   only a derivation, and the code that is actually in force is stored here,
   salted, the moment he sets one. */
const adminSettingSchema = new mongoose.Schema({
  key: { type: String, default: 'console', unique: true, index: true },
  pinSalt: { type: String, select: false },
  pinHash: { type: String, select: false },

  /* The web-push signing pair, under key 'vapid'.
     It used to live in render.yaml, which is a PUBLIC repository — so the
     private half of the live key was readable by anyone, and I confirmed it was
     the live one by comparing it with what the server hands out. It belongs
     here for the same reason the console code does: what ships in the source
     must never be a working secret.
     `select: false` so it cannot leave through a stray .find(). */
  vapidPublic: { type: String, select: false },
  vapidPrivate: { type: String, select: false },

  updatedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('AdminSetting', adminSettingSchema);
