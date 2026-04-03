const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const userSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Name is required'],
    trim: true,
    maxlength: 100
  },
  phone: {
    type: String,
    required: [true, 'Phone number is required'],
    unique: true,
    trim: true
  },
  email: {
    type: String,
    sparse: true,
    trim: true,
    lowercase: true
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: 6,
    select: false
  },
  role: {
    type: String,
    enum: ['customer', 'driver', 'merchant', 'admin'],
    default: 'customer'
  },
  avatar: String,
  language: {
    type: String,
    enum: ['fr', 'en', 'kr', 'es'],
    default: 'fr'
  },
  isDiaspora: {
    type: Boolean,
    default: false
  },
  country: String,
  wallet: {
    balance: { type: Number, default: 0 },
    currency: { type: String, default: 'HTG' }
  },
  referralCode: {
    type: String,
    unique: true,
    sparse: true
  },
  referredBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  referralEarnings: {
    type: Number,
    default: 0
  },
  referralCount: {
    type: Number,
    default: 0
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastLogin: Date
}, {
  timestamps: true
});

// Generate referral code for new drivers
userSchema.pre('save', async function(next) {
  if (this.isNew && this.role === 'driver' && !this.referralCode) {
    var namePart = this.name.replace(/[^a-zA-Z]/g, '').substring(0, 4).toUpperCase();
    var randPart = Math.random().toString(36).substring(2, 6).toUpperCase();
    this.referralCode = 'PP' + namePart + randPart;
  }
  if (!this.isModified('password')) return next();
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
  next();
});

// Compare password
userSchema.methods.matchPassword = async function(enteredPassword) {
  return await bcrypt.compare(enteredPassword, this.password);
};

// Generate JWT
userSchema.methods.getSignedJwtToken = function() {
  return jwt.sign({ id: this._id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRE || '7d'
  });
};

module.exports = mongoose.model('User', userSchema);
