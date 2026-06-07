var Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch(e) { Anthropic = null; }

var Listing = require('../models/Listing');
var BuyerAlert = require('../models/BuyerAlert');
var SellerLead = require('../models/SellerLead');

var ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';

function getClient() {
  if (!Anthropic || !ANTHROPIC_KEY) return null;
  return new Anthropic({ apiKey: ANTHROPIC_KEY });
}

// AI Auto-Categorization
async function categorizeListingAI(listing) {
  var client = getClient();
  if (!client) return fallbackCategorize(listing);

  try {
    var message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: 'Analyze this listing and return ONLY valid JSON.\n\nTitle: ' + listing.title + '\nDescription: ' + (listing.description || '') + '\nPrice: ' + (listing.price || 'not specified') + ' HTG\n\nReturn JSON with:\n- category: one of [vehicles, real-estate, electronics, jobs, services, agriculture, construction, marketplace]\n- subcategory: specific type (e.g. "SUV", "apartment", "smartphone")\n- tags: array of 3-5 relevant search tags in Haitian Creole and French\n- confidence: 0-100 how confident you are\n\nJSON only, no explanation.'
      }]
    });

    var text = message.content[0].text.trim();
    var jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallbackCategorize(listing);

    var result = JSON.parse(jsonMatch[0]);
    return {
      category: result.category || listing.category,
      subcategory: result.subcategory || '',
      tags: result.tags || [],
      confidence: result.confidence || 50
    };
  } catch (err) {
    console.error('AI categorize error:', err.message);
    return fallbackCategorize(listing);
  }
}

function fallbackCategorize(listing) {
  var title = (listing.title || '').toLowerCase();
  var cat = listing.category || 'marketplace';
  var tags = [];

  var keywords = {
    vehicles: ['toyota', 'honda', 'nissan', 'machin', 'moto', 'camion', 'suv', 'rav4', 'corolla', 'civic', 'truck', 'voiture', 'car'],
    'real-estate': ['kay', 'maison', 'house', 'apartment', 'apatman', 'terrain', 'te', 'loye', 'rent', 'vann', 'chanm', 'room'],
    electronics: ['iphone', 'samsung', 'laptop', 'phone', 'telefon', 'tv', 'computer', 'tablet', 'generator', 'jeneratris'],
    jobs: ['travay', 'job', 'emploi', 'chofe', 'driver', 'secretary', 'manager', 'bezwen', 'hiring', 'salary'],
    services: ['plonbye', 'plumber', 'electrician', 'elektrisyen', 'painter', 'penti', 'mecanicien', 'repair', 'service'],
    agriculture: ['te', 'land', 'farm', 'jaden', 'semans', 'bef', 'kabrit', 'poul', 'agrikilti'],
    construction: ['siman', 'cement', 'bwa', 'wood', 'fer', 'iron', 'block', 'konstriksyon', 'material'],
  };

  for (var key in keywords) {
    for (var i = 0; i < keywords[key].length; i++) {
      if (title.indexOf(keywords[key][i]) !== -1) {
        cat = key;
        tags.push(keywords[key][i]);
      }
    }
  }

  var words = title.split(/\s+/).filter(function(w) { return w.length > 3; });
  tags = tags.concat(words.slice(0, 3));
  tags = tags.filter(function(t, idx, arr) { return arr.indexOf(t) === idx; }).slice(0, 5);

  return { category: cat, subcategory: '', tags: tags, confidence: 30 };
}

// Duplicate Detection
async function detectDuplicates(listing) {
  var duplicates = [];

  // Check by phone number
  if (listing.seller && listing.seller.phone) {
    var phoneDups = await Listing.find({
      'seller.phone': listing.seller.phone,
      status: 'active',
      _id: { $ne: listing._id }
    }).limit(5).lean();
    for (var i = 0; i < phoneDups.length; i++) {
      duplicates.push({ listing: phoneDups[i], reason: 'same_phone', score: 70 });
    }
  }

  // Check by similar title
  var titleWords = (listing.title || '').toLowerCase().split(/\s+/).filter(function(w) { return w.length > 3; });
  if (titleWords.length > 0) {
    var titleQuery = titleWords.join(' ');
    try {
      var titleDups = await Listing.find({
        $text: { $search: titleQuery },
        status: 'active',
        _id: { $ne: listing._id }
      }).limit(10).lean();

      for (var j = 0; j < titleDups.length; j++) {
        var dup = titleDups[j];
        var matchScore = 0;

        // Same category bonus
        if (dup.category === listing.category) matchScore += 20;

        // Price similarity (within 20%)
        if (listing.price && dup.price) {
          var priceDiff = Math.abs(listing.price - dup.price) / Math.max(listing.price, dup.price);
          if (priceDiff < 0.2) matchScore += 30;
        }

        // Title word overlap
        var dupWords = (dup.title || '').toLowerCase().split(/\s+/).filter(function(w) { return w.length > 3; });
        var overlap = titleWords.filter(function(w) { return dupWords.indexOf(w) !== -1; }).length;
        var overlapRatio = overlap / Math.max(titleWords.length, 1);
        matchScore += Math.round(overlapRatio * 50);

        if (matchScore > 40) {
          duplicates.push({ listing: dup, reason: 'similar_title', score: matchScore });
        }
      }
    } catch(e) {
      // Text search might not be indexed yet
    }
  }

  // Sort by score descending, remove duplicates
  var seen = {};
  duplicates = duplicates.filter(function(d) {
    var id = d.listing._id.toString();
    if (seen[id]) return false;
    seen[id] = true;
    return true;
  }).sort(function(a, b) { return b.score - a.score; });

  return duplicates.slice(0, 5);
}

// Trust Score
function calculateTrustScore(listing) {
  var score = 0;

  // Has title (+10)
  if (listing.title && listing.title.length > 5) score += 10;

  // Has description (+15)
  if (listing.description && listing.description.length > 20) score += 15;

  // Has price (+10)
  if (listing.price && listing.price > 0) score += 10;

  // Has images (+15)
  if (listing.images && listing.images.length > 0) score += 15;

  // Has location (+10)
  if (listing.location && listing.location.city) score += 10;

  // Seller has phone (+10)
  if (listing.seller && listing.seller.phone) score += 10;

  // Seller has email (+5)
  if (listing.seller && listing.seller.email) score += 5;

  // Seller has WhatsApp (+5)
  if (listing.seller && listing.seller.whatsapp) score += 5;

  // Is claimed/verified (+20)
  if (listing.claimedBy) score += 20;

  // Has a store (+20)
  if (listing.store) score += 20;

  return Math.min(100, score);
}

// Buyer Alert Matching
async function matchBuyerAlerts(listing) {
  var alerts = await BuyerAlert.find({ isActive: true }).lean();
  var matches = [];

  for (var i = 0; i < alerts.length; i++) {
    var alert = alerts[i];
    var isMatch = false;

    // Category match
    if (alert.category && alert.category === listing.category) {
      isMatch = true;
    }

    // Search query match
    if (alert.searchQuery) {
      var queryWords = alert.searchQuery.toLowerCase().split(/\s+/);
      var titleLower = (listing.title || '').toLowerCase();
      var descLower = (listing.description || '').toLowerCase();
      var matchCount = queryWords.filter(function(w) {
        return titleLower.indexOf(w) !== -1 || descLower.indexOf(w) !== -1;
      }).length;
      if (matchCount >= Math.ceil(queryWords.length * 0.5)) {
        isMatch = true;
      }
    }

    // Price match
    if (alert.maxPrice && listing.price && listing.price <= alert.maxPrice) {
      isMatch = true;
    }

    // Location match
    if (alert.location && listing.location && listing.location.city) {
      if (listing.location.city.toLowerCase().indexOf(alert.location.toLowerCase()) !== -1) {
        isMatch = true;
      }
    }

    if (isMatch) {
      matches.push(alert);
    }
  }

  return matches;
}

// Process a listing through the full AI pipeline
async function processListing(listingId) {
  try {
    var listing = await Listing.findById(listingId);
    if (!listing) return null;

    // 1. AI Categorization
    var aiResult = await categorizeListingAI(listing);
    if (aiResult.category && aiResult.confidence > 25) {
      listing.category = aiResult.category;
    }
    if (aiResult.subcategory) listing.subcategory = aiResult.subcategory;
    if (aiResult.tags && aiResult.tags.length > 0) {
      listing.tags = aiResult.tags;
    }

    // 2. Trust Score
    listing.trustScore = calculateTrustScore(listing);

    // 3. Duplicate Detection
    var duplicates = await detectDuplicates(listing);
    if (duplicates.length > 0 && duplicates[0].score > 80) {
      listing.status = 'flagged';
    }

    await listing.save();

    // 4. Match Buyer Alerts
    var alertMatches = await matchBuyerAlerts(listing);
    if (alertMatches.length > 0) {
      console.log('BiznisIQ: ' + alertMatches.length + ' buyer alerts matched for listing ' + listing.title);
      // TODO: Send WhatsApp/SMS notifications to matched alert subscribers
    }

    // 5. Create/Update Seller Lead
    if (listing.seller && listing.seller.phone && !listing.claimedBy) {
      var existingLead = await SellerLead.findOne({ phone: listing.seller.phone });
      if (existingLead) {
        existingLead.listingCount += 1;
        if (existingLead.listings.indexOf(listing._id) === -1) {
          existingLead.listings.push(listing._id);
        }
        await existingLead.save();
      } else {
        await SellerLead.create({
          name: listing.seller.name || '',
          phone: listing.seller.phone,
          email: listing.seller.email || '',
          category: listing.category,
          location: listing.location ? listing.location.city : '',
          listings: [listing._id]
        });
      }
    }

    return {
      listing: listing,
      duplicates: duplicates,
      alertMatches: alertMatches.length,
      trustScore: listing.trustScore
    };
  } catch (err) {
    console.error('AI processListing error:', err);
    return null;
  }
}

// AI Lead Scoring
function scoreSellerLead(lead) {
  var score = 30;

  var highValueCategories = { 'electronics': 25, 'vehicles': 25, 'real-estate': 20, 'supermarket': 20, 'restaurant': 15, 'pharmacy': 15, 'hardware': 15, 'wholesale': 20 };
  var mediumCategories = { 'retail': 10, 'construction': 10, 'agriculture': 10, 'bakery': 10, 'services': 10, 'marketplace': 5 };

  var cat = (lead.category || '').toLowerCase();
  if (highValueCategories[cat]) score += highValueCategories[cat];
  else if (mediumCategories[cat]) score += mediumCategories[cat];

  if (lead.listingCount > 5) score += 15;
  else if (lead.listingCount > 1) score += 8;

  if (lead.facebookUrl) score += 10;
  if (lead.whatsapp) score += 5;
  if (lead.email) score += 5;
  if (lead.phone) score += 5;
  if (lead.name && lead.name.length > 3) score += 5;

  return Math.min(100, score);
}

// WhatsApp Outreach Templates
function getOutreachTemplates(lead) {
  var name = lead.name || 'zanmi';
  var storeUrl = '';
  if (lead.listings && lead.listings.length > 0) {
    storeUrl = 'myplopplop.com/biznisiq/';
  }

  return {
    initial: 'Bonjou ' + name + '! Nou remake w ap vann pwodwi sou entènèt. Nou kapab kreye yon magazen GRATIS pou ou sou MyPlopPlop ki aksepte MonCash, NatCash, Kat Kredi ak livrezon entegre. Enterese? Vizite: myplopplop.com',
    followUp: 'Bonjou ' + name + '! Mwen te kontakte ou konsènan MyPlopPlop. Magazen gratis la toujou disponib. Ou vle kòmanse jodi a? Klike la: myplopplop.com',
    storeReady: 'Bòn nouvèl ' + name + '! Magazen ou a sou MyPlopPlop prè! ' + (storeUrl ? 'Klike la pou wè li: ' + storeUrl + '. ' : '') + 'Kounye a ou ka ajoute pwodwi ou yo epi kòmanse vann!',
    activation: 'Felisitasyon ' + name + '! Magazen ou a aktif sou MyPlopPlop. Ou ka resevwa peman MonCash, NatCash, ak Kat Kredi. Kòmanse pataje lyen magazen ou a ak kliyan ou yo!'
  };
}

module.exports = {
  categorizeListingAI: categorizeListingAI,
  detectDuplicates: detectDuplicates,
  calculateTrustScore: calculateTrustScore,
  matchBuyerAlerts: matchBuyerAlerts,
  processListing: processListing,
  scoreSellerLead: scoreSellerLead,
  getOutreachTemplates: getOutreachTemplates
};
