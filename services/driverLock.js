/* The one-job lock on MsouWout, MyPlopPlop side (5 Nov 2026). Jeffery: "I want the one-job-at-a-time rule
   guaranteed even when one server is temporarily unavailable."

   A job given to a driver linked to MsouWout (every driver since 3 Nov) is his only once MsouWout has
   granted the lock "mpp:<ride id>" (MsouWout routes/rides.js /internal/lock). MsouWout refuses it while he
   is on a passenger ride, and refuses him passenger rides while it is held. No answer = no job.
   Released when the job ends; reconcile() (10 s dispatch tick) re-sends any release that did not land and
   takes the lock for any job that is running without one (e.g. jobs accepted before this existed). */
const Ride = require('../models/Ride');
const DriverProfile = require('../models/DriverProfile');
const link = require('../utils/msouwoutLink');
const { ACTIVE } = require('./driverBusy');

const jobId = function (ride) { return 'mpp:' + String(ride._id || ride); };

/* -> { ok:true } | { ok:false, reason:'on_ride'|'other_job'|'unverified'|'not_found' } */
async function acquire(ride, profile) {
  const mid = profile && profile.msouwout && profile.msouwout.driverId;
  if (!mid) return { ok: true, unlinked: true };
  const r = await link.lock(String(mid), jobId(ride));
  if (r.status === 200 && r.data && r.data.ok) {
    await Ride.updateOne({ _id: ride._id || ride }, { $set: { driverLock: { msouwoutId: String(mid), held: true, at: new Date() } } });
    return { ok: true };
  }
  if (r.status === 409 && r.data && r.data.reason) return { ok: false, reason: r.data.reason };
  if (r.status === 404) return { ok: false, reason: 'not_found' };
  return { ok: false, reason: 'unverified' };
}

async function release(ride) {
  const doc = ride.driverLock ? ride : await Ride.findById(ride._id || ride).select('driverLock').lean();
  if (!doc || !doc.driverLock || !doc.driverLock.held) return true;
  const r = await link.unlock(doc.driverLock.msouwoutId, jobId(doc));
  if (r.status === 200) {
    await Ride.updateOne({ _id: doc._id, 'driverLock.held': true }, { $set: { 'driverLock.held': false } });
    return true;
  }
  return false;
}

const warned = new Set();
async function reconcile() {
  let released = 0, taken = 0;
  const ended = await Ride.find({ 'driverLock.held': true, status: { $nin: ACTIVE } }).select('driverLock status').limit(50).lean();
  for (const r of ended) if (await release(r)) released++;
  const open = await Ride.find({ status: { $in: ACTIVE }, driver: { $ne: null }, 'driverLock.held': { $ne: true } })
    .select('driver driverLock').limit(50).lean();
  for (const r of open) {
    const prof = await DriverProfile.findOne({ user: r.driver }).select('msouwout').lean();
    if (!prof || !prof.msouwout || !prof.msouwout.driverId) continue;
    const a = await acquire(r, prof);
    if (a.ok) taken++;
    else if (a.reason !== 'unverified' && !warned.has(String(r._id)) && warned.add(String(r._id))) console.warn('[LOCK] job ' + r._id + ' runs without its MsouWout lock: ' + a.reason);
  }
  return { released, taken };
}

module.exports = { acquire, release, reconcile, jobId };
