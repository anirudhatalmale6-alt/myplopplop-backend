const express = require('express');
const router = express.Router();
const webpush = require('web-push');
const { protect } = require('../middleware/auth');
const PushSubscription = require('../models/PushSubscription');

// Configure VAPID
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    process.env.VAPID_EMAIL || 'mailto:info@myplopplop.com',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}

// GET /api/notifications/vapid-key - Get public VAPID key
router.get('/vapid-key', (req, res) => {
  res.json({ success: true, publicKey: process.env.VAPID_PUBLIC_KEY || '' });
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
        // Remove expired subscriptions
        if (err.statusCode === 410 || err.statusCode === 404) {
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
