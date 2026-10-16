const mongoose = require('mongoose');

/* ═══ A MANUAL REFUND (16 Oct 2026) ═════════════════════════════════════════
   SolutionIP cannot refund MonCash/NatCash, so a refund is money an
   administrator sends back by hand. Jeffery: "Every refund should have an
   amount, reason, payment reference, status, and administrator approval
   record." This is that record, and its history is append-only.

   pending_approval  opened automatically when a PAID order is cancelled, or by
                     an admin for a delivered order (wrong / damaged / missing)
   approved          an admin agreed; for a wallet payment the money is back
                     in the customer's wallet at this step
   paid              the admin sent it by MonCash/NatCash and typed the transfer
                     reference
   rejected          an admin refused, with a reason                        */
const refundSchema = new mongoose.Schema({
  order: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
  orderNumber: String,
  customer: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true, min: 0 },
  reason: { type: String, required: true },
  method: { type: String, enum: ['moncash', 'natcash', 'wallet', 'card'], required: true },
  paymentRef: String,           // what the customer originally paid under
  payoutReference: String,      // the admin's MonCash/NatCash transfer reference
  // Money taken back from the shop / driver because of this refund.
  merchantAdjustment: { type: Number, default: 0 },
  driverAdjustment: { type: Number, default: 0 },
  status: { type: String, enum: ['pending_approval', 'approved', 'paid', 'rejected'], default: 'pending_approval', index: true },
  history: [{
    at: { type: Date, default: Date.now },
    by: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    byName: String,
    action: String,
    note: String
  }]
}, { timestamps: true });

module.exports = mongoose.model('Refund', refundSchema);
