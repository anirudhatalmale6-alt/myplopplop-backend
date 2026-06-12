const mongoose = require('mongoose');

const subcategorySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  slug: { type: String, required: true },
  isActive: { type: Boolean, default: true }
}, { _id: true });

const categorySchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, unique: true },
  slug: { type: String, unique: true, lowercase: true },
  icon: { type: String, default: '' },
  image: { type: String, default: '' },
  displayOrder: { type: Number, default: 0 },
  isHomepage: { type: Boolean, default: false },
  isActive: { type: Boolean, default: true },
  subcategories: [subcategorySchema],
  productCount: { type: Number, default: 0 }
}, { timestamps: true });

categorySchema.pre('save', function(next) {
  if (this.isNew || this.isModified('name')) {
    this.slug = this.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  }
  this.subcategories.forEach(function(sub) {
    if (!sub.slug) {
      sub.slug = sub.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
    }
  });
  next();
});

categorySchema.index({ slug: 1 });
categorySchema.index({ isHomepage: 1, displayOrder: 1 });

module.exports = mongoose.model('Category', categorySchema);
