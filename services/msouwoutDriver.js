/* ONE REGISTRATION, ONE VERIFICATION (1 Nov 2026).
   Jeffery: "OK DRIVER STEP 1 — YES. I approve one registration and one
   verification process for MsouWout rides and MyPlopPlop deliveries. Existing
   drivers must not lose their accounts or be required to register again."

   The MsouWout record stays THE driver identity (utils/msouwoutLink.js). What
   changes here:
   1. A driver approved on MsouWout signs in on MyPlopPlop with the SAME phone
      and the SAME MsouWout PIN. If MyPlopPlop has no account for that phone,
      one is created for him, with a delivery profile that is APPROVED because
      the one verification already happened (Jennifer, on MsouWout).
   2. Linking an existing account (POST /api/drivers/link-msouwout) follows the
      same rule - but only a PENDING profile is promoted, and only when the
      names match. A profile MyPlopPlop rejected or suspended stays that way;
      a name mismatch stays pending for a human.
   3. A profile approved THIS way follows MsouWout afterwards: suspended or
      rejected there = suspended here (checked when he goes online or accepts).
      Profiles a MyPlopPlop administrator approved himself are left alone.

   ⛔ A MsouWout PIN never opens an administrator's or a shop's account: those
      keep their own PIN, whatever MsouWout says. */
const crypto = require('crypto');
const link = require('../utils/msouwoutLink');
const User = require('../models/User');
const DriverProfile = require('../models/DriverProfile');

const PIN_ROLES = ['customer', 'driver'];

function factsFrom(data, userName) {
  const d = data.driver || {};
  return {
    driverId: String(d.id), linkedAt: new Date(), fullName: d.full_name, phone: d.phone, status: d.status,
    licenseNumber: d.license_number || '',
    vehicle: [d.vehicle_make, d.vehicle_model, d.vehicle_year].filter(Boolean).join(' '),
    documents: data.documents || [], nameMatches: link.sameName(userName || d.full_name, d.full_name)
  };
}
function approvedThere(d) { return d && d.status === 'approved' && d.is_active !== false; }
/* 1 Nov 2026, Jeffery: "Jennifer's approval activates only the services the
   driver is qualified for" - KOUS = MsouWout rides only, so no deliveries here. */
function deliveryOk(d) { return ['delivery', 'both'].indexOf((d && d.preferred_service) || 'both') !== -1; }
const RIDES_ONLY = 'Ou apwouve pou KOUS sèlman sou MsouWout. Pou fè livrezon, mande Jennifer ajoute LIVREZON sou pwofil ou.';

/* The one verification, applied to a profile. Returns true when it promoted it. */
function applyOneVerification(profile, d, facts) {
  if (!approvedThere(d) || !deliveryOk(d) || profile.status !== 'pending' || !facts.nameMatches) return false;
  profile.status = 'approved';
  profile.verifiedAt = new Date();
  profile.rejectionReason = undefined;
  profile.msouwout.approvedVia = 'msouwout';
  profile.msouwout.approvedBy = String(d.reviewed_by || '').slice(0, 80);
  if ((profile.services || []).indexOf('delivery') === -1) profile.services = (profile.services || []).concat('delivery');
  return true;
}

/* POST /api/auth/login fell through (no account, or not this PIN): is it a
   MsouWout driver signing in with his MsouWout PIN? Returns the user to sign
   in, or null. Never throws for an ordinary wrong PIN. */
async function loginWithMsouwout(existingUser, phone, pin) {
  if (!/^\d{4,8}$/.test(String(pin || ''))) return null;
  if (existingUser && PIN_ROLES.indexOf(existingUser.role) === -1) return null;
  const r = await link.verify(phone, pin);
  if (r.status !== 200 || !r.data || !r.data.driver) return null;
  const d = r.data.driver;
  if (!approvedThere(d)) return null;                       /* pending / rejected / suspended: no delivery account */
  if (!deliveryOk(d)) return { refused: RIDES_ONLY };       /* right PIN, but approved for rides only */
  const facts = factsFrom(r.data, existingUser && existingUser.name);

  const taken = await DriverProfile.findOne({ 'msouwout.driverId': facts.driverId }).select('user');
  if (taken && (!existingUser || String(taken.user) !== String(existingUser._id))) return null;   /* linked to someone else */

  let user = existingUser;
  if (!user) {
    user = await User.create({
      name: d.full_name || 'Chofè MsouWout', phone: d.phone || phone, role: 'driver',
      /* never typed by anybody: he signs in with his MsouWout PIN */
      password: crypto.randomBytes(24).toString('hex')
    });
  }
  let profile = await DriverProfile.findOne({ user: user._id });
  if (profile && profile.msouwout && profile.msouwout.driverId && profile.msouwout.driverId !== facts.driverId) return null;
  if (!profile) {
    profile = new DriverProfile({
      user: user._id,
      vehicleType: link.VEHICLE[String(d.vehicle_type || '').toLowerCase()] || 'moto',
      vehiclePlate: d.license_plate || ('MW-' + d.id),
      vehicleModel: [d.vehicle_make, d.vehicle_model].filter(Boolean).join(' '),
      vehicleColor: d.vehicle_color || '',
      licenseNumber: d.license_number || ('MW-' + d.id),
      services: ['delivery'], status: 'pending', msouwout: facts
    });
  } else {
    profile.msouwout = Object.assign({}, profile.msouwout && profile.msouwout.toObject ? profile.msouwout.toObject() : profile.msouwout, facts);
  }
  applyOneVerification(profile, d, facts);
  await profile.save();
  if (user.role === 'customer') { user.role = 'driver'; await user.save(); }
  return user;
}

/* Gone online / accepting: a profile activated by MsouWout must still be
   approved there. MsouWout asleep = keep what we know (it was approved),
   rather than take every driver off the road because a server is slow. */
const seen = new Map();   /* driverId -> { at, ok } */
async function stillApproved(profile) {
  const m = profile && profile.msouwout;
  if (!m || m.approvedVia !== 'msouwout' || !m.driverId) return true;
  const c = seen.get(m.driverId);
  if (c && Date.now() - c.at < 10 * 60 * 1000) return c.ok;
  const r = await link.status(m.driverId);
  if (r.status !== 200 && r.status !== 404) return c ? c.ok : true;
  const ok = r.status === 200 && approvedThere(r.data) && deliveryOk(r.data);
  seen.set(m.driverId, { at: Date.now(), ok });
  if (!ok && profile.status === 'approved') {
    profile.status = 'suspended';
    profile.isOnline = false;
    profile.rejectionReason = 'MsouWout: ' + (r.status === 200 && approvedThere(r.data) ? 'KOUS sèlman' : ((r.data && r.data.status) || 'not found'));
    await profile.save();
    console.warn('[ONE-DRIVER] delivery profile ' + profile._id + ' suspended: MsouWout says ' + profile.rejectionReason);
  }
  return ok;
}

module.exports = { loginWithMsouwout, applyOneVerification, stillApproved, factsFrom, approvedThere, deliveryOk, RIDES_ONLY };
