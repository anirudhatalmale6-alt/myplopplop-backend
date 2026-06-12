const express = require('express');
const router = express.Router();
const { body, validationResult } = require('express-validator');
const { protect, authorize } = require('../middleware/auth');
const Category = require('../models/Category');

router.get('/', async (req, res) => {
  try {
    var query = { isActive: true };
    if (req.query.homepage === 'true') query.isHomepage = true;

    var categories = await Category.find(query).sort({ displayOrder: 1 });
    res.json({ success: true, data: categories });
  } catch (err) {
    console.error('Categories error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/:slug', async (req, res) => {
  try {
    var category = await Category.findOne({ slug: req.params.slug, isActive: true });
    if (!category) return res.status(404).json({ success: false, message: 'Category not found' });
    res.json({ success: true, data: category });
  } catch (err) {
    console.error('Category detail error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/', protect, authorize('admin'), [
  body('name').notEmpty().withMessage('Category name required')
], async (req, res) => {
  var errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    var category = await Category.create(req.body);
    res.status(201).json({ success: true, data: category });
  } catch (err) {
    console.error('Create category error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.put('/:id', protect, authorize('admin'), async (req, res) => {
  try {
    var category = await Category.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
    if (!category) return res.status(404).json({ success: false, message: 'Category not found' });
    res.json({ success: true, data: category });
  } catch (err) {
    console.error('Update category error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.post('/:id/subcategories', protect, authorize('admin'), [
  body('name').notEmpty().withMessage('Subcategory name required')
], async (req, res) => {
  var errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(400).json({ success: false, errors: errors.array() });

  try {
    var category = await Category.findById(req.params.id);
    if (!category) return res.status(404).json({ success: false, message: 'Category not found' });

    category.subcategories.push({ name: req.body.name, slug: req.body.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') });
    await category.save();
    res.json({ success: true, data: category });
  } catch (err) {
    console.error('Add subcategory error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.delete('/:id', protect, authorize('admin'), async (req, res) => {
  try {
    var category = await Category.findByIdAndUpdate(req.params.id, { isActive: false }, { new: true });
    if (!category) return res.status(404).json({ success: false, message: 'Category not found' });
    res.json({ success: true, message: 'Category deactivated' });
  } catch (err) {
    console.error('Delete category error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
