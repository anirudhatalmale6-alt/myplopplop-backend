require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const Category = require('../models/Category');

var categories = [
  {
    name: 'Auto Parts',
    icon: 'car',
    displayOrder: 1,
    isHomepage: true,
    subcategories: [
      { name: 'Headlights' }, { name: 'Tail Lights' }, { name: 'Mirrors' },
      { name: 'Batteries' }, { name: 'Tires' }, { name: 'Seat Covers' },
      { name: 'Floor Mats' }, { name: 'Phone Holders' }, { name: 'LED Lights' },
      { name: 'Motor Oil' }, { name: 'Motorcycle Parts' }
    ]
  },
  {
    name: 'Phones & Electronics',
    icon: 'smartphone',
    displayOrder: 2,
    isHomepage: true,
    subcategories: [
      { name: 'Smartphones' }, { name: 'Tablets' }, { name: 'Smart Watches' },
      { name: 'Bluetooth Speakers' }, { name: 'Earbuds' }, { name: 'Chargers' },
      { name: 'Power Banks' }, { name: 'Phone Cases' }, { name: 'Security Cameras' },
      { name: 'Laptops' }
    ]
  },
  {
    name: 'Solar & Energy',
    icon: 'sun',
    displayOrder: 3,
    isHomepage: true,
    subcategories: [
      { name: 'Solar Panels' }, { name: 'Solar Generators' }, { name: 'Solar Flood Lights' },
      { name: 'Solar Street Lights' }, { name: 'Solar Batteries' }, { name: 'Inverters' },
      { name: 'Charge Controllers' }, { name: 'Solar Fans' }
    ]
  },
  {
    name: 'Home & Kitchen',
    icon: 'home',
    displayOrder: 4,
    isHomepage: true,
    subcategories: [
      { name: 'Gas Stoves' }, { name: 'Blenders' }, { name: 'Rice Cookers' },
      { name: 'Pressure Cookers' }, { name: 'Water Dispensers' }, { name: 'Fans' },
      { name: 'Air Fryers' }, { name: 'Microwaves' }, { name: 'Refrigerators' },
      { name: 'Kitchen Sets' }
    ]
  },
  {
    name: 'Construction & Hardware',
    icon: 'hammer',
    displayOrder: 5,
    isHomepage: true,
    subcategories: [
      { name: 'Cement' }, { name: 'Rebar' }, { name: 'Paint' },
      { name: 'Electrical Wire' }, { name: 'Breakers' }, { name: 'Switches' },
      { name: 'PVC Pipes' }, { name: 'Plumbing Supplies' }, { name: 'Tools' },
      { name: 'Generators' }
    ]
  },
  {
    name: 'Beauty & Personal Care',
    icon: 'sparkles',
    displayOrder: 6,
    isHomepage: true,
    subcategories: [
      { name: 'Hair Extensions' }, { name: 'Wigs' }, { name: 'Hair Products' },
      { name: 'Cosmetics' }, { name: 'Perfumes' }, { name: 'Skin Care Products' },
      { name: 'Barbershop Supplies' }, { name: 'Salon Equipment' }
    ]
  },
  {
    name: 'Fashion',
    icon: 'shirt',
    displayOrder: 7,
    isHomepage: true,
    subcategories: [
      { name: "Men's Clothing" }, { name: "Women's Clothing" }, { name: 'Shoes' },
      { name: 'Sneakers' }, { name: 'Handbags' }, { name: 'Watches' },
      { name: 'Sunglasses' }, { name: 'Uniforms' }
    ]
  },
  {
    name: 'Made in Haiti',
    icon: 'flag',
    displayOrder: 8,
    isHomepage: true,
    subcategories: [
      { name: 'Coffee' }, { name: 'Chocolate' }, { name: 'Arts & Crafts' },
      { name: 'Paintings' }, { name: 'Fashion' }, { name: 'Beauty Products' },
      { name: 'Spices' }, { name: 'Agricultural Products' }
    ]
  },
  {
    name: 'Baby & Family',
    icon: 'baby',
    displayOrder: 9,
    isHomepage: false,
    subcategories: [
      { name: 'Diapers' }, { name: 'Baby Formula' }, { name: 'Strollers' },
      { name: 'Car Seats' }, { name: 'Baby Clothing' }, { name: 'Toys' }
    ]
  },
  {
    name: 'Medical Supplies',
    icon: 'medical',
    displayOrder: 10,
    isHomepage: false,
    subcategories: [
      { name: 'Blood Pressure Monitors' }, { name: 'Thermometers' },
      { name: 'Wheelchairs' }, { name: 'Walkers' }, { name: 'First Aid Kits' },
      { name: 'Gloves' }, { name: 'Masks' }
    ]
  },
  {
    name: 'Agriculture',
    icon: 'leaf',
    displayOrder: 11,
    isHomepage: false,
    subcategories: [
      { name: 'Seeds' }, { name: 'Fertilizers' }, { name: 'Water Pumps' },
      { name: 'Sprayers' }, { name: 'Farming Tools' }, { name: 'Irrigation Supplies' }
    ]
  },
  {
    name: 'Business Supplies',
    icon: 'building',
    displayOrder: 12,
    isHomepage: false,
    subcategories: [
      { name: 'Printers' }, { name: 'POS Systems' }, { name: 'Barcode Scanners' },
      { name: 'Receipt Printers' }, { name: 'Cash Drawers' }, { name: 'Office Furniture' }
    ]
  }
];

async function seed() {
  await connectDB();
  console.log('Seeding categories...');

  for (var i = 0; i < categories.length; i++) {
    var cat = categories[i];
    var existing = await Category.findOne({ name: cat.name });
    if (existing) {
      console.log('  Updating: ' + cat.name);
      existing.icon = cat.icon;
      existing.displayOrder = cat.displayOrder;
      existing.isHomepage = cat.isHomepage;
      var existingSlugs = existing.subcategories.map(function(s) { return s.slug; });
      cat.subcategories.forEach(function(sub) {
        var slug = sub.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
        if (existingSlugs.indexOf(slug) === -1) {
          existing.subcategories.push({ name: sub.name, slug: slug });
        }
      });
      await existing.save();
    } else {
      console.log('  Creating: ' + cat.name);
      cat.subcategories = cat.subcategories.map(function(sub) {
        return { name: sub.name, slug: sub.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') };
      });
      await Category.create(cat);
    }
  }

  console.log('Done! ' + categories.length + ' categories seeded.');
  process.exit(0);
}

seed().catch(function(err) {
  console.error('Seed error:', err);
  process.exit(1);
});
