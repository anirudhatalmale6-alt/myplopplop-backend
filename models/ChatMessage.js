const mongoose = require('mongoose');

const chatMessageSchema = new mongoose.Schema({
  ride: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Ride',
    required: true
  },
  sender: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  senderRole: {
    type: String,
    enum: ['customer', 'driver'],
    required: true
  },
  message: {
    type: String,
    required: true,
    maxlength: 500
  },
  type: {
    type: String,
    enum: ['text', 'location', 'system'],
    default: 'text'
  },
  read: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

chatMessageSchema.index({ ride: 1, createdAt: 1 });

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
