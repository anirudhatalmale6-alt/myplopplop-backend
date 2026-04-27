const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  transaction_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'UtilityTransaction'
  },
  user_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  },
  channel: {
    type: String,
    enum: ['whatsapp', 'sms', 'email'],
    required: true
  },
  recipient: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  event_type: {
    type: String,
    enum: ['transaction_created', 'payment_confirmed', 'processing_started', 'token_delivered', 'receipt_delivered', 'transaction_failed', 'transaction_refunded'],
    required: true
  },
  status: {
    type: String,
    enum: ['queued', 'sent', 'failed'],
    default: 'queued'
  },
  sent_at: Date
}, {
  timestamps: true
});

notificationSchema.index({ transaction_id: 1 });
notificationSchema.index({ status: 1 });

module.exports = mongoose.model('Notification', notificationSchema);
