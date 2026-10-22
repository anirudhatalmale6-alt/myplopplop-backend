const express = require('express');
const router = express.Router();
const multer = require('multer');
const XLSX = require('xlsx');
const { protect } = require('../middleware/auth');
const Product = require('../models/Product');
const Store = require('../models/Store');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = [
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/octet-stream'
    ];
    if (allowed.includes(file.mimetype) || file.originalname.match(/\.(csv|xlsx|xls)$/i)) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV and XLSX files are allowed'));
    }
  }
});

const verifyStoreAccess = async (req, res) => {
  const store = await Store.findById(req.params.storeId);
  if (!store) {
    res.status(404).json({ success: false, message: 'Store not found' });
    return null;
  }
  if (store.owner.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
    res.status(403).json({ success: false, message: 'Not authorized for this store' });
    return null;
  }
  return store;
};

/* 22 Oct 2026 - the CSV can carry product photos: an "image" column holding a
   public link (https://…/photo.jpg). Several links in one cell are separated by
   "|" or ";" - the first one is the photo the store shows. A cell left EMPTY
   never wipes the photos a product already has, so re-uploading a price list
   is safe. A bad link is reported on its row and skipped; the row still saves.
   The store puts this value straight into <img src>, so only a plain http(s)
   URL with no quotes, brackets or spaces gets through. */
const IMAGE_HEADERS = ['image', 'images', 'imageurl', 'image_url', 'photo', 'foto', 'imaj'];
const readImageCell = (row) => {
  for (const k of Object.keys(row)) {
    if (IMAGE_HEADERS.includes(k.trim().toLowerCase())) return String(row[k] || '').trim();
  }
  return '';
};
const parseImageLinks = (cell) => {
  const good = [];
  const bad = [];
  for (const part of cell.split(/[|;\n]+/).map(x => x.trim()).filter(Boolean)) {
    let ok = false;
    if (part.length <= 500 && !/["'<>\s`\\]/.test(part)) {
      try {
        const u = new URL(part);
        ok = (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname;
      } catch (e) { ok = false; }
    }
    (ok ? good : bad).push(part);
  }
  return { good: good.slice(0, 10), bad };
};

/* 22 Oct 2026: prices and quantities were read with parseFloat/parseInt,
   which stop at the first non-digit - "1,200" became 1 HTG, a stock of
   "1,000" became 1, and "120 goud" slipped through. A spreadsheet cell is
   either a real number (XLSX) or text that must be a number and nothing else:
     1200 · 1 200 · 1,200 · 1.200,50 · 1,200.50 · 49,99 · 49.99
   Anything else is refused on its row so the merchant sees it. */
const parseNum = (v, { int = false } = {}) => {
  if (typeof v === 'number') return Number.isFinite(v) && (!int || Number.isInteger(v)) ? v : NaN;
  let t = String(v == null ? '' : v).trim().replace(/[\s\u00a0\u202f]/g, '');
  if (!t) return NaN;
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) t = t.replace(/,/g, '');                    // 1,200 / 1,200.50
  else if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '').replace(',', '.'); // 1.200 / 1.200,50
  else if (/^\d+,\d{1,2}$/.test(t)) t = t.replace(',', '.');                                // 49,99
  if (!/^\d+(\.\d+)?$/.test(t)) return NaN;
  const n = Number(t);
  return int && !Number.isInteger(n) ? NaN : n;
};

router.get('/template', (req, res) => {
  const data = [
    ['name', 'price', 'category', 'description', 'stockQuantity', 'unit', 'comparePrice', 'inStock', 'sku', 'image'],
    ['Diri Blan (Riz Blanc)', 150, 'grocery', 'Sak diri blan 5 liv', 200, 'bag', 180, 'true', 'DIRI-5LB', ''],
    ['Pwa Nwa (Black Beans)', 85, 'grocery', 'Pwa nwa sek 1 liv', 350, 'bag', 100, 'true', 'PWA-1LB', ''],
    ['Luil Maskreti', 250, 'grocery', 'Luil kwit manje 1 lit', 120, 'bottle', 300, 'true', 'LUIL-1L', ''],
    ['Pen Kreyol', 25, 'bakery', 'Pen fre chak jou', 50, 'piece', '', 'true', '', ''],
    ['Manba (Peanut Butter)', 75, 'grocery', 'Manba natiral 500g', 80, 'jar', 90, 'true', 'MANBA-500', ''],
    ['Dlo Filtre', 20, 'beverage', 'Dlo pwop 500ml', 500, 'bottle', 25, 'true', 'DLO-500', ''],
    ['Pikliz', 60, 'condiment', 'Pikliz tradisyonel 250ml', 45, 'jar', 75, 'true', 'PIK-250', '']
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Template');
  const csvContent = XLSX.utils.sheet_to_csv(ws);
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=inventory_template.csv');
  res.send(csvContent);
});

router.post('/:storeId/upload', protect, upload.single('file'), async (req, res) => {
  try {
    const store = await verifyStoreAccess(req, res);
    if (!store) return;

    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No file uploaded' });
    }

    // CSV: decode as UTF-8 so accented Kreyòl/French text (è, ò, é…) imports
    // correctly. Reading a CSV as a raw buffer lets XLSX guess the codepage and
    // mangle accents into mojibake. XLSX binary formats stay as a buffer.
    const isCsv = /\.csv$/i.test(req.file.originalname) || req.file.mimetype === 'text/csv';
    const workbook = isCsv
      /* raw: keep every CSV cell as the text the merchant typed. Left to
         guess, the library read "49,99" as 4999; parseNum decides instead. */
      ? XLSX.read(req.file.buffer.toString('utf8').replace(/^﻿/, ''), { type: 'string', raw: true })
      : XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (!rows.length) {
      return res.status(400).json({ success: false, message: 'File is empty' });
    }

    let created = 0;
    let updated = 0;
    const errors = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNum = i + 2;

      if (!row.name || row.name.toString().trim() === '') {
        errors.push({ row: rowNum, message: 'Name is required' });
        continue;
      }

      const price = parseNum(row.price);
      if (isNaN(price) || price < 0) {
        errors.push({ row: rowNum, message: `Invalid price: ${row.price}` });
        continue;
      }

      const stockQuantity = row.stockQuantity !== '' ? parseNum(row.stockQuantity, { int: true }) : -1;
      if (row.stockQuantity !== '' && isNaN(stockQuantity)) {
        errors.push({ row: rowNum, message: `Invalid stockQuantity: ${row.stockQuantity}` });
        continue;
      }

      const inStockVal = row.inStock !== '' ? String(row.inStock).toLowerCase() : 'true';
      const inStock = inStockVal !== 'false' && inStockVal !== '0' && inStockVal !== 'no';

      const productData = {
        name: row.name.toString().trim(),
        price,
        category: row.category ? row.category.toString().trim() : undefined,
        description: row.description ? row.description.toString().trim() : undefined,
        stockQuantity,
        unit: row.unit ? row.unit.toString().trim() : 'piece',
        inStock,
        store: store._id
      };

      if (row.comparePrice !== '' && row.comparePrice !== undefined) {
        const cp = parseNum(row.comparePrice);
        if (isNaN(cp)) errors.push({ row: rowNum, message: `Invalid comparePrice (ignored): ${row.comparePrice}` });
        else productData.comparePrice = cp;
      }

      if (row.sku !== undefined && String(row.sku).trim() !== '') {
        productData.sku = String(row.sku).trim();
      }

      const imageCell = readImageCell(row);
      if (imageCell) {
        const links = parseImageLinks(imageCell);
        if (links.good.length) productData.images = links.good;
        if (links.bad.length) {
          errors.push({ row: rowNum, message: `Image link not valid (product saved without it): ${links.bad[0].slice(0, 80)}` });
        }
      }

      try {
        // Prefer the SKU when the sheet carries one — a merchant renaming a
        // product should update the row, not create a second one.
        const existing = productData.sku
          ? await Product.findOne({ store: store._id, sku: productData.sku })
            || await Product.findOne({ name: productData.name, store: store._id })
          : await Product.findOne({ name: productData.name, store: store._id });
        if (existing) {
          await Product.updateOne({ _id: existing._id }, { $set: productData });
          updated++;
        } else {
          await Product.create(Object.assign({ source: 'csv' }, productData));
          created++;
        }
      } catch (err) {
        errors.push({ row: rowNum, message: err.message });
      }
    }

    await Store.findByIdAndUpdate(store._id, {
      'stats.totalProducts': await Product.countDocuments({ store: store._id, isActive: true })
    });

    res.json({ success: true, created, updated, errors });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/:storeId/dashboard', protect, async (req, res) => {
  try {
    const store = await verifyStoreAccess(req, res);
    if (!store) return;

    const storeId = store._id;

    const [totalProducts, totalInStock, totalOutOfStock, lowStockProducts, valueAgg, categoryAgg] = await Promise.all([
      Product.countDocuments({ store: storeId, isActive: true }),
      Product.countDocuments({ store: storeId, isActive: true, inStock: true }),
      Product.countDocuments({ store: storeId, isActive: true, inStock: false }),
      Product.countDocuments({ store: storeId, isActive: true, stockQuantity: { $gt: 0, $lt: 10 } }),
      Product.aggregate([
        { $match: { store: storeId, isActive: true, stockQuantity: { $gt: 0 } } },
        { $group: { _id: null, totalValue: { $sum: { $multiply: ['$price', '$stockQuantity'] } } } }
      ]),
      Product.aggregate([
        { $match: { store: storeId, isActive: true } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ])
    ]);

    const categoryCounts = {};
    categoryAgg.forEach(c => { categoryCounts[c._id || 'uncategorized'] = c.count; });

    res.json({
      success: true,
      data: {
        totalProducts,
        totalInStock,
        totalOutOfStock,
        lowStockProducts,
        totalValue: valueAgg.length ? valueAgg[0].totalValue : 0,
        categoryCounts
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/:storeId/products', protect, async (req, res) => {
  try {
    const store = await verifyStoreAccess(req, res);
    if (!store) return;

    const { search, category, stockStatus, sortBy, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit) || 20));

    const filter = { store: store._id, isActive: true };

    if (search) {
      filter.$text = { $search: search };
    }

    if (category) {
      filter.category = category;
    }

    if (stockStatus === 'inStock') {
      filter.inStock = true;
    } else if (stockStatus === 'outOfStock') {
      filter.inStock = false;
    } else if (stockStatus === 'lowStock') {
      filter.stockQuantity = { $gt: 0, $lt: 10 };
    }

    let sort = { createdAt: -1 };
    if (sortBy === 'name') sort = { name: 1 };
    else if (sortBy === 'price') sort = { price: 1 };
    else if (sortBy === 'stock') sort = { stockQuantity: -1 };
    else if (sortBy === 'updated') sort = { updatedAt: -1 };

    const [products, total] = await Promise.all([
      Product.find(filter).sort(sort).skip((pageNum - 1) * limitNum).limit(limitNum),
      Product.countDocuments(filter)
    ]);

    res.json({
      success: true,
      data: products,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum)
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.put('/:storeId/bulk-update', protect, async (req, res) => {
  try {
    const store = await verifyStoreAccess(req, res);
    if (!store) return;

    const { updates } = req.body;
    if (!Array.isArray(updates) || !updates.length) {
      return res.status(400).json({ success: false, message: 'Updates array is required' });
    }

    const results = { updated: 0, errors: [] };

    const ops = updates.map(item => {
      const setFields = {};
      if (item.stockQuantity !== undefined) setFields.stockQuantity = item.stockQuantity;
      if (item.price !== undefined) setFields.price = item.price;
      if (item.inStock !== undefined) setFields.inStock = item.inStock;

      return {
        updateOne: {
          filter: { _id: item.productId, store: store._id },
          update: { $set: setFields }
        }
      };
    });

    const bulkResult = await Product.bulkWrite(ops);
    results.updated = bulkResult.modifiedCount;

    res.json({ success: true, ...results });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/:storeId/alerts', protect, async (req, res) => {
  try {
    const store = await verifyStoreAccess(req, res);
    if (!store) return;

    const [lowStock, outOfStock] = await Promise.all([
      Product.find({ store: store._id, isActive: true, stockQuantity: { $gt: 0, $lt: 10 } })
        .sort({ stockQuantity: 1 }),
      Product.find({ store: store._id, isActive: true, stockQuantity: 0 })
        .sort({ updatedAt: -1 })
    ]);

    res.json({
      success: true,
      data: {
        lowStock,
        outOfStock,
        lowStockCount: lowStock.length,
        outOfStockCount: outOfStock.length
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

router.get('/:storeId/export', protect, async (req, res) => {
  try {
    const store = await verifyStoreAccess(req, res);
    if (!store) return;

    const products = await Product.find({ store: store._id, isActive: true }).lean();

    const data = products.map(p => ({
      name: p.name,
      price: p.price,
      category: p.category || '',
      description: p.description || '',
      stockQuantity: p.stockQuantity,
      unit: p.unit || 'piece',
      comparePrice: p.comparePrice || '',
      inStock: p.inStock
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const csvContent = XLSX.utils.sheet_to_csv(ws);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename=${store.slug}_inventory_${Date.now()}.csv`);
    res.send(csvContent);
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

module.exports = router;
