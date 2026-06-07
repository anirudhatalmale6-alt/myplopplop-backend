const express = require('express');
const router = express.Router();
const Listing = require('../models/Listing');
const BuyerAlert = require('../models/BuyerAlert');
const SellerLead = require('../models/SellerLead');
const { protect, authorize } = require('../middleware/auth');

// ═══ PUBLIC ROUTES ═══

// ─── GET ALL ACTIVE LISTINGS (public, search/browse) ───
router.get('/listings', async function(req, res) {
  try {
    var page = parseInt(req.query.page) || 1;
    var limit = parseInt(req.query.limit) || 20;
    var query = { status: 'active' };

    // Text search
    if (req.query.q) {
      query.$text = { $search: req.query.q };
    }

    // Category filter
    if (req.query.category) {
      query.category = req.query.category;
    }

    // City filter
    if (req.query.city) {
      query['location.city'] = { $regex: req.query.city, $options: 'i' };
    }

    // Price range
    if (req.query.minPrice || req.query.maxPrice) {
      query.price = {};
      if (req.query.minPrice) query.price.$gte = parseFloat(req.query.minPrice);
      if (req.query.maxPrice) query.price.$lte = parseFloat(req.query.maxPrice);
    }

    // Sort options
    var sortOption = {};
    switch (req.query.sort) {
      case 'price-asc':
        sortOption = { price: 1 };
        break;
      case 'price-desc':
        sortOption = { price: -1 };
        break;
      case 'newest':
      default:
        sortOption = { isFeatured: -1, createdAt: -1 };
        break;
    }

    var listings = await Listing.find(query)
      .sort(sortOption)
      .skip((page - 1) * limit)
      .limit(limit);

    var total = await Listing.countDocuments(query);

    res.json({
      success: true,
      data: listings,
      pagination: { page: page, limit: limit, total: total }
    });
  } catch (err) {
    console.error('Get listings error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET LISTING BY ID (public, increments views) ───
router.get('/listings/:id', async function(req, res) {
  try {
    var listing = await Listing.findById(req.params.id)
      .populate('sellerUser', 'name phone')
      .populate('store', 'name slug')
      .populate('claimedBy', 'name');

    if (!listing) {
      return res.status(404).json({ success: false, message: 'Listing not found' });
    }

    // Increment views
    listing.stats.views += 1;
    await listing.save();

    res.json({ success: true, data: listing });
  } catch (err) {
    console.error('Get listing error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET CATEGORY COUNTS (public) ───
router.get('/categories', async function(req, res) {
  try {
    var categories = await Listing.aggregate([
      { $match: { status: 'active' } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    var result = {};
    categories.forEach(function(cat) {
      result[cat._id] = cat.count;
    });

    res.json({ success: true, data: result });
  } catch (err) {
    console.error('Get categories error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ═══ AUTHENTICATED ROUTES ═══

// ─── SUBMIT A NEW LISTING ───
router.post('/listings', protect, async function(req, res) {
  try {
    var listing = await Listing.create({
      title: req.body.title,
      description: req.body.description || '',
      category: req.body.category,
      subcategory: req.body.subcategory || '',
      price: req.body.price,
      currency: req.body.currency || 'HTG',
      images: req.body.images || [],
      location: req.body.location || {},
      seller: req.body.seller || {},
      sellerUser: req.user._id,
      store: req.body.store || undefined,
      source: 'user-submitted',
      tags: req.body.tags || [],
      expiresAt: req.body.expiresAt || undefined
    });

    res.status(201).json({ success: true, data: listing });
  } catch (err) {
    console.error('Create listing error:', err);
    if (err.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── UPDATE OWN LISTING ───
router.put('/listings/:id', protect, async function(req, res) {
  try {
    var listing = await Listing.findById(req.params.id);
    if (!listing) {
      return res.status(404).json({ success: false, message: 'Listing not found' });
    }

    // Only owner or admin can update
    if (listing.sellerUser && listing.sellerUser.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    var allowed = ['title', 'description', 'category', 'subcategory', 'price', 'currency', 'images', 'location', 'seller', 'tags', 'expiresAt', 'status', 'isFeatured'];
    allowed.forEach(function(field) {
      if (req.body[field] !== undefined) listing[field] = req.body[field];
    });

    await listing.save();
    res.json({ success: true, data: listing });
  } catch (err) {
    console.error('Update listing error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── DEACTIVATE OWN LISTING ───
router.delete('/listings/:id', protect, async function(req, res) {
  try {
    var listing = await Listing.findById(req.params.id);
    if (!listing) {
      return res.status(404).json({ success: false, message: 'Listing not found' });
    }

    // Only owner or admin can deactivate
    if (listing.sellerUser && listing.sellerUser.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    listing.status = 'expired';
    await listing.save();

    res.json({ success: true, message: 'Listing deactivated' });
  } catch (err) {
    console.error('Delete listing error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── CLAIM A BUSINESS LISTING ───
router.post('/listings/:id/claim', protect, async function(req, res) {
  try {
    var listing = await Listing.findById(req.params.id);
    if (!listing) {
      return res.status(404).json({ success: false, message: 'Listing not found' });
    }

    if (listing.status === 'claimed') {
      return res.status(400).json({ success: false, message: 'Listing already claimed' });
    }

    listing.claimedBy = req.user._id;
    listing.claimedAt = new Date();
    listing.status = 'claimed';
    listing.sellerUser = req.user._id;
    await listing.save();

    // Create a seller lead
    await SellerLead.create({
      name: req.body.name || req.user.name,
      phone: req.body.phone || req.user.phone,
      email: req.body.email || req.user.email,
      category: listing.category,
      location: listing.location ? listing.location.city : '',
      listings: [listing._id],
      status: 'new'
    });

    res.json({ success: true, data: listing, message: 'Listing claimed successfully' });
  } catch (err) {
    console.error('Claim listing error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── RECORD AN INQUIRY ───
router.post('/listings/:id/inquiry', protect, async function(req, res) {
  try {
    var listing = await Listing.findById(req.params.id);
    if (!listing) {
      return res.status(404).json({ success: false, message: 'Listing not found' });
    }

    listing.stats.inquiries += 1;
    await listing.save();

    res.json({ success: true, message: 'Inquiry recorded', inquiries: listing.stats.inquiries });
  } catch (err) {
    console.error('Inquiry error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ═══ BUYER ALERTS ═══

// ─── CREATE BUYER ALERT ───
router.post('/alerts', protect, async function(req, res) {
  try {
    var alert = await BuyerAlert.create({
      user: req.user._id,
      phone: req.body.phone || '',
      email: req.body.email || '',
      whatsapp: req.body.whatsapp || '',
      searchQuery: req.body.searchQuery,
      category: req.body.category || '',
      maxPrice: req.body.maxPrice || undefined,
      location: req.body.location || ''
    });

    res.status(201).json({ success: true, data: alert });
  } catch (err) {
    console.error('Create alert error:', err);
    if (err.name === 'ValidationError') {
      return res.status(400).json({ success: false, message: err.message });
    }
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET MY ALERTS ───
router.get('/alerts/my', protect, async function(req, res) {
  try {
    var alerts = await BuyerAlert.find({ user: req.user._id }).sort('-createdAt');
    res.json({ success: true, data: alerts });
  } catch (err) {
    console.error('Get my alerts error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── DELETE MY ALERT ───
router.delete('/alerts/:id', protect, async function(req, res) {
  try {
    var alert = await BuyerAlert.findById(req.params.id);
    if (!alert) {
      return res.status(404).json({ success: false, message: 'Alert not found' });
    }

    if (alert.user.toString() !== req.user._id.toString()) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    await alert.deleteOne();
    res.json({ success: true, message: 'Alert deleted' });
  } catch (err) {
    console.error('Delete alert error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ═══ ADMIN ROUTES ═══

// ─── GET ALL SELLER LEADS ───
router.get('/leads', protect, authorize('admin'), async function(req, res) {
  try {
    var page = parseInt(req.query.page) || 1;
    var limit = parseInt(req.query.limit) || 20;
    var query = {};

    if (req.query.status) query.status = req.query.status;
    if (req.query.category) query.category = req.query.category;

    var leads = await SellerLead.find(query)
      .populate('assignedKoutye', 'name phone')
      .populate('listings', 'title category')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(limit);

    var total = await SellerLead.countDocuments(query);

    res.json({
      success: true,
      data: leads,
      pagination: { page: page, limit: limit, total: total }
    });
  } catch (err) {
    console.error('Get leads error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── UPDATE SELLER LEAD ───
router.put('/leads/:id', protect, authorize('admin'), async function(req, res) {
  try {
    var lead = await SellerLead.findById(req.params.id);
    if (!lead) {
      return res.status(404).json({ success: false, message: 'Lead not found' });
    }

    var allowed = ['status', 'assignedKoutye', 'leadScore', 'conversionValue', 'notes'];
    allowed.forEach(function(field) {
      if (req.body[field] !== undefined) lead[field] = req.body[field];
    });

    await lead.save();
    res.json({ success: true, data: lead });
  } catch (err) {
    console.error('Update lead error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── ADMIN DASHBOARD STATS ───
router.get('/dashboard', protect, authorize('admin'), async function(req, res) {
  try {
    // Total listings
    var totalListings = await Listing.countDocuments();

    // Listings by category
    var listingsByCategory = await Listing.aggregate([
      { $group: { _id: '$category', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    // Active alerts count
    var activeAlerts = await BuyerAlert.countDocuments({ isActive: true });

    // Leads by status
    var leadsByStatus = await SellerLead.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    // Conversion rate
    var totalLeads = await SellerLead.countDocuments();
    var convertedLeads = await SellerLead.countDocuments({ status: 'converted' });
    var conversionRate = totalLeads > 0 ? Math.round((convertedLeads / totalLeads) * 100) : 0;

    // Top searched (based on buyer alert queries)
    var topSearched = await BuyerAlert.aggregate([
      { $match: { isActive: true } },
      { $group: { _id: '$searchQuery', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);

    res.json({
      success: true,
      data: {
        totalListings: totalListings,
        listingsByCategory: listingsByCategory,
        topSearched: topSearched,
        activeAlerts: activeAlerts,
        leadsByStatus: leadsByStatus,
        conversionRate: conversionRate
      }
    });
  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
