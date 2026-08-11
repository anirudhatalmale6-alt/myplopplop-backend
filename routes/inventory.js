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

router.get('/template', (req, res) => {
  const data = [
    ['name', 'price', 'category', 'description', 'stockQuantity', 'unit', 'comparePrice', 'inStock', 'sku'],
    ['Diri Blan (Riz Blanc)', 150, 'grocery', 'Sak diri blan 5 liv', 200, 'bag', 180, 'true', 'DIRI-5LB'],
    ['Pwa Nwa (Black Beans)', 85, 'grocery', 'Pwa nwa sek 1 liv', 350, 'bag', 100, 'true', 'PWA-1LB'],
    ['Luil Maskreti', 250, 'grocery', 'Luil kwit manje 1 lit', 120, 'bottle', 300, 'true', 'LUIL-1L'],
    ['Pen Kreyol', 25, 'bakery', 'Pen fre chak jou', 50, 'piece', '', 'true', ''],
    ['Manba (Peanut Butter)', 75, 'grocery', 'Manba natiral 500g', 80, 'jar', 90, 'true', 'MANBA-500'],
    ['Dlo Filtre', 20, 'beverage', 'Dlo pwop 500ml', 500, 'bottle', 25, 'true', 'DLO-500'],
    ['Pikliz', 60, 'condiment', 'Pikliz tradisyonel 250ml', 45, 'jar', 75, 'true', 'PIK-250']
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
      ? XLSX.read(req.file.buffer.toString('utf8').replace(/^﻿/, ''), { type: 'string' })
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

      const price = parseFloat(row.price);
      if (isNaN(price) || price < 0) {
        errors.push({ row: rowNum, message: `Invalid price: ${row.price}` });
        continue;
      }

      const stockQuantity = row.stockQuantity !== '' ? parseInt(row.stockQuantity) : -1;
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

      if (row.comparePrice !== '' && !isNaN(parseFloat(row.comparePrice))) {
        productData.comparePrice = parseFloat(row.comparePrice);
      }

      if (row.sku !== undefined && String(row.sku).trim() !== '') {
        productData.sku = String(row.sku).trim();
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
