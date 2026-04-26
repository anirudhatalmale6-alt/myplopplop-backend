const express = require('express');
const router = express.Router();
const FeaturedListing = require('../models/FeaturedListing');
const Store = require('../models/Store');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { protect, authorize } = require('../middleware/auth');

const PRICES = {
  product: 500,  // 500 HTG/week
  shop: 1500,    // 1,500 HTG/week
  banner: 3000   // 3,000 HTG/week
};

// ─── BOOST PRODUCT/SHOP/BANNER ───
router.post('/boost', protect, authorize('merchant'), async function(req, res) {
  try {
    var { type, storeId, productId, weeks } = req.body;
    if (!type || !PRICES[type]) {
      return res.status(400).json({ success: false, message: 'Type must be: product, shop, or banner' });
    }

    weeks = parseInt(weeks) || 1;
    var price = PRICES[type] * weeks;

    var user = await User.findById(req.user._id);
    if (user.wallet.balance < price) {
      return res.status(400).json({ success: false, message: 'Balans ensifizan. Bezwen ' + price + ' HTG' });
    }

    user.wallet.balance -= price;
    await user.save();

    var endDate = new Date();
    endDate.setDate(endDate.getDate() + (weeks * 7));

    var listing = await FeaturedListing.create({
      vendor: req.user._id,
      store: storeId || null,
      product: productId || null,
      type: type,
      price: price,
      endDate: endDate
    });

    await Transaction.create({
      user: req.user._id,
      type: 'payment',
      amount: price,
      currency: 'HTG',
      method: 'wallet',
      status: 'completed',
      description: 'Featured ' + type + ' (' + weeks + ' weeks)'
    });

    if (type === 'shop' && storeId) {
      await Store.findByIdAndUpdate(storeId, { isFeatured: true });
    }

    res.status(201).json({ success: true, data: listing });
  } catch (err) {
    console.error('Boost error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET ACTIVE FEATURED ───
router.get('/active', async function(req, res) {
  try {
    var now = new Date();
    var listings = await FeaturedListing.find({
      status: 'active',
      endDate: { $gte: now }
    })
      .populate('store', 'name logo category')
      .populate('product', 'name price images')
      .sort('-createdAt');

    res.json({ success: true, data: listings });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── TRACK IMPRESSION/CLICK ───
router.post('/:id/track', async function(req, res) {
  try {
    var field = req.body.type === 'click' ? 'clicks' : 'impressions';
    await FeaturedListing.findByIdAndUpdate(req.params.id, { $inc: { [field]: 1 } });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

module.exports = router;
