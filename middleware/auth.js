const jwt = require('jsonwebtoken');
const User = require('../models/User');

// Protect routes - require authentication
const protect = async (req, res, next) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({ success: false, message: 'Not authorized' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = await User.findById(decoded.id).select('-password');
    if (!req.user) {
      return res.status(401).json({ success: false, message: 'User not found' });
    }
    next();
  } catch (error) {
    return res.status(401).json({ success: false, message: 'Token invalid' });
  }
};

// Role-based access
const authorize = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ success: false, message: 'Not authorized for this action' });
    }
    next();
  };
};

/* 23 Oct 2026: driver screens and driver actions.
   An account has ONE role. Becoming a driver used to overwrite it, so the
   owner (an admin) or a shop that also delivers had to choose: lose the admin
   dashboard / the shop, or never drive. Now the driver PROFILE is what makes
   someone a driver: role 'driver' as before, OR any account that has a
   DriverProfile. What a driver may actually DO is still decided by that
   profile's status (dispatch, accept and handover all require 'approved'). */
const driverAccess = async (req, res, next) => {
  try {
    if (req.user.role === 'driver') { req.isDriver = true; return next(); }
    const DriverProfile = require('../models/DriverProfile');
    if (await DriverProfile.exists({ user: req.user._id })) { req.isDriver = true; return next(); }
    return res.status(403).json({ success: false, message: 'Not authorized for this action' });
  } catch (e) {
    return res.status(500).json({ success: false, message: 'Server error' });
  }
};

module.exports = { protect, authorize, driverAccess };
