const express = require('express');
const router = express.Router();
const { protect } = require('../middleware/auth');
const ChatMessage = require('../models/ChatMessage');
const Ride = require('../models/Ride');
const { sendPushToUser } = require('./notifications');

// ─── Get chat messages for a ride ───
// GET /api/chat/:rideId
router.get('/:rideId', protect, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.rideId);
    if (!ride) {
      return res.status(404).json({ success: false, message: 'Ride not found' });
    }

    // Only customer or driver of this ride can view chat
    const userId = req.user._id.toString();
    if (ride.customer.toString() !== userId && (!ride.driver || ride.driver.toString() !== userId)) {
      return res.status(403).json({ success: false, message: 'Not authorized for this chat' });
    }

    const messages = await ChatMessage.find({ ride: req.params.rideId })
      .sort({ createdAt: 1 })
      .populate('sender', 'name');

    // Mark unread messages as read
    const senderRole = ride.driver && ride.driver.toString() === userId ? 'customer' : 'driver';
    await ChatMessage.updateMany(
      { ride: req.params.rideId, senderRole: senderRole, read: false },
      { read: true }
    );

    res.json({ success: true, messages });
  } catch (error) {
    console.error('Get chat error:', error);
    res.status(500).json({ success: false, message: 'Failed to load messages' });
  }
});

// ─── Send a message ───
// POST /api/chat/:rideId
router.post('/:rideId', protect, async (req, res) => {
  try {
    const { message, type } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ success: false, message: 'Message is required' });
    }

    const ride = await Ride.findById(req.params.rideId);
    if (!ride) {
      return res.status(404).json({ success: false, message: 'Ride not found' });
    }

    const userId = req.user._id.toString();
    if (ride.customer.toString() !== userId && (!ride.driver || ride.driver.toString() !== userId)) {
      return res.status(403).json({ success: false, message: 'Not authorized for this chat' });
    }

    const senderRole = ride.driver && ride.driver.toString() === userId ? 'driver' : 'customer';

    const chatMsg = await ChatMessage.create({
      ride: ride._id,
      sender: req.user._id,
      senderRole: senderRole,
      message: message.trim(),
      type: type || 'text'
    });

    await chatMsg.populate('sender', 'name');

    // Emit via Socket.io for real-time delivery
    const io = req.app.get('io');
    if (io) {
      io.to(`ride_${ride._id}`).emit('new_message', {
        _id: chatMsg._id,
        ride: ride._id,
        sender: { _id: req.user._id, name: req.user.name },
        senderRole: senderRole,
        message: chatMsg.message,
        type: chatMsg.type,
        createdAt: chatMsg.createdAt
      });
    }

    // Send push notification to the other party
    const recipientId = senderRole === 'driver' ? ride.customer : ride.driver;
    if (recipientId) {
      sendPushToUser(recipientId, 'New Message - PlopPlop', chatMsg.message, {
        url: '/rides-chat.html?id=' + ride._id
      }).catch(() => {});
    }

    res.json({ success: true, chatMessage: chatMsg });
  } catch (error) {
    console.error('Send message error:', error);
    res.status(500).json({ success: false, message: 'Failed to send message' });
  }
});

// ─── Get unread message count ───
// GET /api/chat/:rideId/unread
router.get('/:rideId/unread', protect, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.rideId);
    if (!ride) return res.json({ success: true, count: 0 });

    const userId = req.user._id.toString();
    const otherRole = ride.driver && ride.driver.toString() === userId ? 'customer' : 'driver';

    const count = await ChatMessage.countDocuments({
      ride: req.params.rideId,
      senderRole: otherRole,
      read: false
    });

    res.json({ success: true, count });
  } catch (error) {
    res.json({ success: true, count: 0 });
  }
});

// ─── Quick replies (predefined messages) ───
// GET /api/chat/quick-replies
router.get('/quick/replies', protect, (req, res) => {
  const replies = {
    customer: [
      'Where are you?',
      'I am waiting outside',
      'Please call me when you arrive',
      'Can you come to the gate?',
      'Thank you!',
      'How long until you arrive?'
    ],
    driver: [
      'I am on my way',
      'I am here, waiting outside',
      'I am at the pickup point',
      'Traffic is heavy, coming soon',
      'Please come outside',
      'Delivery complete, thank you!'
    ]
  };
  res.json({ success: true, replies });
});

module.exports = router;
