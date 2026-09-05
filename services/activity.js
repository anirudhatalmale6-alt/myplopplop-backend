const ActivityLog = require('../models/ActivityLog');

/* Write one line into the audit trail.
 *
 * Never throws and never blocks. An approval must not fail because the log
 * could not be written - but a log that silently stops recording is worse than
 * none at all, so a failure is shouted about in the server log rather than
 * swallowed.
 */
function record(req, action, opts) {
  var o = opts || {};
  var actor = (req && req.user) || {};
  return ActivityLog.create({
    actor: actor._id,
    actorName: actor.name,
    actorRole: actor.role,
    action: action,
    targetType: o.targetType,
    targetId: o.targetId,
    targetLabel: o.targetLabel,
    detail: o.detail,
    ip: req && (req.headers['x-forwarded-for'] || req.ip)
  }).catch(function (err) {
    console.error('ACTIVITY LOG FAILED for "' + action + '":', err.message);
  });
}

module.exports = { record };
