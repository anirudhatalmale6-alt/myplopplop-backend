const express = require('express');
const router = express.Router();
const Order = require('../models/Order');
const Store = require('../models/Store');
const { protect } = require('../middleware/auth');

const MSOUWOUT_API = process.env.MSOUWOUT_API_URL || 'https://msouwout-backend.onrender.com';

async function callMsouWout(path, body) {
  const res = await globalThis.fetch(MSOUWOUT_API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

router.post('/:orderId/request-driver', protect, async function(req, res) {
  try {
    var order = await Order.findById(req.params.orderId)
      .populate('store', 'name address phone')
      .populate('customer', 'name phone');

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    var store = await Store.findById(order.store._id);
    var isMerchant = store && store.owner.toString() === req.user._id.toString();
    var isAdmin = req.user.role === 'admin';

    if (!isMerchant && !isAdmin) {
      return res.status(403).json({ success: false, message: 'Not authorized' });
    }

    if (order.status !== 'ready') {
      return res.status(400).json({ success: false, message: 'Order must be in ready status to request driver' });
    }

    if (order.deliveryType !== 'delivery') {
      return res.status(400).json({ success: false, message: 'Pickup orders do not need a driver' });
    }

    var storeAddr = order.store.address || {};
    var deliveryAddr = order.deliveryAddress || {};

    var pickupLat = storeAddr.coordinates ? storeAddr.coordinates.coordinates[1] : 18.5425;
    var pickupLng = storeAddr.coordinates ? storeAddr.coordinates.coordinates[0] : -72.3386;
    var dropoffLat = deliveryAddr.coordinates ? deliveryAddr.coordinates.coordinates[1] : 18.54;
    var dropoffLng = deliveryAddr.coordinates ? deliveryAddr.coordinates.coordinates[0] : -72.34;

    var rideData = {
      pickup_lat: pickupLat,
      pickup_lng: pickupLng,
      pickup_address: storeAddr.street || store.name,
      dropoff_lat: dropoffLat,
      dropoff_lng: dropoffLng,
      dropoff_address: deliveryAddr.street || deliveryAddr.city || 'Delivery address',
      ride_type: 'moto',
      customer_name: 'MyPlopPlop Delivery',
      customer_phone: order.store.phone || '50900000000',
      payment_method: 'cash',
      notes: 'MyPlopPlop Order #' + order.orderNumber + ' from ' + store.name
    };

    try {
      var msouwoutRes = await callMsouWout('/api/rides/request', rideData);

      if (msouwoutRes.success || msouwoutRes.ride_id) {
        order.msouwoutRideId = msouwoutRes.ride_id || msouwoutRes.data?.id;
        order.msouwoutTrackingCode = msouwoutRes.tracking_code || msouwoutRes.data?.tracking_code;
        await order.save();

        var io = req.app.get('io');
        if (io) {
          io.to('store_' + store._id).emit('driver_requested', {
            orderId: order._id,
            trackingCode: msouwoutRes.tracking_code
          });
        }

        return res.json({
          success: true,
          message: 'Driver requested via MsouWout',
          trackingCode: msouwoutRes.tracking_code,
          rideId: msouwoutRes.ride_id
        });
      } else {
        return res.json({
          success: false,
          message: 'MsouWout dispatch failed: ' + (msouwoutRes.message || 'Unknown error'),
          fallback: true
        });
      }
    } catch (dispatchErr) {
      console.error('MsouWout dispatch error:', dispatchErr.message);
      return res.json({
        success: false,
        message: 'Could not reach MsouWout. Driver can be assigned manually.',
        fallback: true
      });
    }
  } catch (err) {
    console.error('Request driver error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

router.get('/:orderId/driver-status', protect, async function(req, res) {
  try {
    var order = await Order.findById(req.params.orderId);
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    if (!order.msouwoutRideId) {
      return res.json({ success: true, data: { driverStatus: 'not_dispatched' } });
    }

    try {
      var trackRes = await globalThis.fetch(MSOUWOUT_API + '/api/rides/' + order.msouwoutRideId + '/track');
      var trackData = await trackRes.json();

      return res.json({
        success: true,
        data: {
          driverStatus: trackData.status || 'searching',
          driverName: trackData.driver_name,
          driverPhone: trackData.driver_phone,
          driverLat: trackData.current_lat,
          driverLng: trackData.current_lng,
          trackingCode: order.msouwoutTrackingCode
        }
      });
    } catch (err) {
      return res.json({
        success: true,
        data: { driverStatus: 'searching', trackingCode: order.msouwoutTrackingCode }
      });
    }
  } catch (err) {
    console.error('Driver status error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
