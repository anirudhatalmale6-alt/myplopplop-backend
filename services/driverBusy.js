/* ONE DRIVER, ONE JOB (5 Nov 2026). Jeffery: "fix the issue where a driver already handling a ride
   or delivery can receive another assignment. A driver should only receive new requests when available."
   And at 15:05: "If either server cannot verify the driver's availability, the system must refuse a new
   assignment until it can confirm the driver is free."

   A driver is BUSY when he has
     - an unfinished MyPlopPlop job (shop delivery or parcel: accepted / picking_up / in_progress), or
     - an unfinished MsouWout passenger ride (asked from MsouWout, for profiles linked to it).
   FAIL-CLOSED: a linked driver MsouWout does not answer for is counted busy ("unverified") - he is offered
   nothing and cannot accept until MsouWout answers. The accept itself also takes the lock on MsouWout
   (services/driverLock.js), which is what makes two jobs impossible even in the same second. */
const Ride = require('../models/Ride');
const ACTIVE = ['accepted', 'picking_up', 'in_progress'];

async function mppBusyUsers(userIds) {
  if (!userIds || !userIds.length) return new Set();
  const rows = await Ride.find({ driver: { $in: userIds }, status: { $in: ACTIVE } }).select('driver').lean();
  return new Set(rows.map(function (r) { return String(r.driver); }));
}

const uid = function (p) { return String(p.user && (p.user._id || p.user)); };

/* profiles: DriverProfile docs (need .user and .msouwout.driverId). Returns the Set of busy USER ids;
   the Set's .unverified holds the ones counted busy only because MsouWout could not be asked. */
async function busyUsers(profiles) {
  const list = (profiles || []).filter(Boolean);
  const out = await mppBusyUsers(list.map(function (p) { return p.user && (p.user._id || p.user); }));
  out.unverified = new Set();
  out.held = new Set();   /* OAVCT expired on MsouWout (5 Nov 2026): no new job */
  const linked = list.filter(function (p) { return p.msouwout && p.msouwout.driverId; });
  if (linked.length) {
    const r = await require('../utils/msouwoutLink').busy(linked.map(function (p) { return String(p.msouwout.driverId); }));
    if (r.status === 200 && r.data && Array.isArray(r.data.busy)) {
      const ids = new Set(r.data.busy.map(String)), held = new Set((r.data.held || []).map(String));
      linked.forEach(function (p) {
        if (ids.has(String(p.msouwout.driverId))) out.add(uid(p));
        if (held.has(String(p.msouwout.driverId))) { out.add(uid(p)); out.held.add(uid(p)); }
      });
    } else {
      console.warn('[BUSY] MsouWout did not answer (' + r.status + ') - ' + linked.length + ' linked driver(s) held back until it does');
      linked.forEach(function (p) { if (!out.has(uid(p))) { out.add(uid(p)); out.unverified.add(uid(p)); } });
    }
  }
  return out;
}

/* -> { busy:boolean, unverified:boolean, held:boolean } */
async function check(profile) {
  if (!profile) return { busy: false, unverified: false, held: false };
  const s = await busyUsers([profile]);
  return { busy: s.has(uid(profile)), unverified: s.unverified.has(uid(profile)), held: s.held.has(uid(profile)) };
}

async function isBusy(profile) { return (await check(profile)).busy; }

module.exports = { ACTIVE, mppBusyUsers, busyUsers, check, isBusy };
