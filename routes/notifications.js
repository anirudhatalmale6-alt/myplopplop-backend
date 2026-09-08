const express = require('express');
const router = express.Router();
const webpush = require('web-push');
const { protect } = require('../middleware/auth');
const PushSubscription = require('../models/PushSubscription');

const { loadVapid } = require('../utils/vapidKeys');

/* The pair now comes from the database, because render.yaml is public and the
   private key that was written there was the live one. Configured on first
   need rather than at require() time — at require() time there is no database
   connection yet. */
let vapidReady = null;
async function configureVapid() {
  if (!vapidReady) {
    vapidReady = loadVapid().then(k => {
      if (k.publicKey && k.privateKey) {
        webpush.setVapidDetails(
          process.env.VAPID_EMAIL || 'mailto:info@myplopplop.com',
          k.publicKey, k.privateKey
        );
      }
      return k;
    });
  }
  return vapidReady;
}

// GET /api/notifications/vapid-key - Get public VAPID key
// The phone needs the PUBLIC half to subscribe. It must be the same pair the
// server signs with, so it is read from the same place rather than from the
// environment, which may still hold the old one.
router.get('/vapid-key', async (req, res) => {
  try {
    const k = await configureVapid();
    res.json({ success: true, publicKey: k.publicKey || '' });
  } catch (e) {
    res.status(500).json({ success: false, message: 'key unavailable' });
  }
});

// POST /api/notifications/subscribe - Save push subscription
router.post('/subscribe', protect, async (req, res) => {
  try {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) {
      return res.status(400).json({ success: false, message: 'Invalid subscription' });
    }

    // Upsert: update if same endpoint exists, create otherwise
    await PushSubscription.findOneAndUpdate(
      { 'subscription.endpoint': subscription.endpoint },
      { user: req.user._id, subscription },
      { upsert: true, new: true }
    );

    res.json({ success: true, message: 'Subscribed to push notifications' });
  } catch (error) {
    console.error('Push subscribe error:', error);
    res.status(500).json({ success: false, message: 'Failed to subscribe' });
  }
});

// POST /api/notifications/unsubscribe - Remove push subscription
router.post('/unsubscribe', protect, async (req, res) => {
  try {
    const { endpoint } = req.body;
    await PushSubscription.deleteOne({ 'subscription.endpoint': endpoint });
    res.json({ success: true, message: 'Unsubscribed' });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Failed to unsubscribe' });
  }
});

module.exports = router;

// Helper: send push to a specific user (used by other routes)
module.exports.sendPushToUser = async function(userId, title, body, data = {}) {
  try {
    await configureVapid();   // the pair lives in the database now
    const subs = await PushSubscription.find({ user: userId });
    const payload = JSON.stringify({
      title,
      body,
      icon: '/assets/img/logo.png',
      badge: '/assets/img/logo.png',
      data: { url: data.url || '/', ...data }
    });

    const results = await Promise.allSettled(
      subs.map(sub => webpush.sendNotification(sub.subscription, payload).catch(err => {
        // Remove subscriptions that can never succeed again:
        //  410/404 - the browser threw the subscription away
        //  403     - signed with a different key pair than the one it was made
        //            with. That is what a key rotation looks like from here,
        //            and without this line every rotated-out subscription would
        //            be retried for ever and never work.
        if (err.statusCode === 410 || err.statusCode === 404 || err.statusCode === 403) {
          PushSubscription.deleteOne({ _id: sub._id }).catch(() => {});
        }
        throw err;
      }))
    );

    return results.filter(r => r.status === 'fulfilled').length;
  } catch (error) {
    console.error('Push send error:', error);
    return 0;
  }
};
