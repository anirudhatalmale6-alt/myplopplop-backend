const mongoose = require('mongoose');

/* Who did what, to whom, and when.
 *
 * There was no general audit trail anywhere on the platform. A driver could be
 * approved, a shop suspended, or somebody made an admin, and afterwards there
 * was no way to say who had done it or on what day - only the single
 * verifiedBy stamp on a driver profile, which the next decision overwrote.
 *
 * This deliberately records ACTIONS PEOPLE TAKE that change money, access or
 * standing. It is not a click log and does not try to be: every browse and
 * every page view would bury the twelve entries a month that actually matter.
 */
const activityLogSchema = new mongoose.Schema({
  // Who did it. Null only for something the server did on a timer.
  actor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  actorName: String,          // kept as text so the log still reads if a user is deleted
  actorRole: String,

  // What they did: 'driver.approve', 'store.suspend', 'admin.grant', ...
  action: { type: String, required: true, index: true },

  // What it was done to.
  targetType: { type: String },          // 'DriverProfile' | 'Store' | 'User' | 'Order' | 'Ride'
  targetId: { type: mongoose.Schema.Types.ObjectId },
  targetLabel: String,                   // a name/number a person can recognise

  // Anything worth keeping: the reason for a rejection, an amount, a status
  // that changed from one thing to another.
  detail: { type: mongoose.Schema.Types.Mixed },

  ip: String
}, { timestamps: true });

activityLogSchema.index({ createdAt: -1 });
activityLogSchema.index({ targetType: 1, targetId: 1 });

module.exports = mongoose.model('ActivityLog', activityLogSchema);
