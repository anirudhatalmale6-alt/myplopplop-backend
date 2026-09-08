/* Where the web-push signing pair comes from.
 *
 * It used to be written straight into render.yaml, and render.yaml is in a
 * PUBLIC repository. So the private half of the live key was readable by
 * anyone — confirmed by comparing the committed key against what
 * GET /api/notifications/vapid-key hands out: identical. Anyone could have
 * sent notifications to his users as MyPlopPlop.
 *
 * The database is now the source of truth, exactly like the console code, and
 * the environment is only a fallback so nothing breaks in the moment between
 * this shipping and the new pair being written.
 *
 * Loaded once and cached: web-push wants the pair configured, not fetched per
 * send, and a database hiccup must not silently stop notifications.
 */
const AdminSetting = require('../models/AdminSetting');

let cache = null;

async function loadVapid() {
  if (cache) return cache;
  let doc = null;
  try {
    doc = await AdminSetting.findOne({ key: 'vapid' })
      .select('+vapidPublic +vapidPrivate')
      .lean();
  } catch (e) {
    console.error('[vapid] could not read the keys from the database:', e.message);
  }
  const publicKey = (doc && doc.vapidPublic) || process.env.VAPID_PUBLIC_KEY || '';
  const privateKey = (doc && doc.vapidPrivate) || process.env.VAPID_PRIVATE_KEY || '';
  /* Say which one won. When push stops working, the first question is always
     "which key is it actually using", and guessing has cost hours before. */
  console.log('[vapid] using the pair from',
    (doc && doc.vapidPublic) ? 'the database' : (publicKey ? 'the environment' : 'NOWHERE — push is off'));
  cache = { publicKey, privateKey };
  return cache;
}

/* Only for the admin route that rotates them: drop the cache so the next send
   picks the new pair up without a restart. */
function forgetVapid() { cache = null; }

module.exports = { loadVapid, forgetVapid };
