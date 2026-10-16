/* ═══ "THE CUSTOMER PAID AND CLOSED THE PAGE" (16 Oct 2026) ══════════════════
   Jeffery: "If a customer closes the payment page or loses internet
   connectivity, the system must recover the correct payment status without
   creating duplicate charges."

   Until now a payment was only ever confirmed by the customer's own browser
   coming back to checkout within 30 minutes. Now the server asks SolutionIP
   itself, for every unpaid MonCash/NatCash basket, on a widening schedule
   (2, 5, 10, 20, 40, then every 60 minutes) for 24 hours. A basket is checked
   ONCE per round under its payment reference, however many shops are in it.

   It only ever READS the gateway (paiement-verify) - it never charges anyone,
   so it cannot create a duplicate charge. Marking paid goes through
   orderLifecycle.confirmPayment, the same atomic step the customer's return
   uses, so the two can race without paying anything twice.

   After 24 hours unpaid, a last check, then the order is cancelled by the
   system: the stock it was holding goes back on the shelf.               */
const Order = require('../models/Order');
const lifecycle = require('./orderLifecycle');

const SCHEDULE_MIN = [2, 5, 10, 20, 40];            // then every 60
const GIVE_UP_HOURS = 24;
/* 🛑 Only orders placed AFTER this went live. Without it the first run would
   have swept every unpaid order in the database's history: cancelled them all
   with a push to each customer and shop, and - worse - its "one last look"
   could have marked months-old orders paid and paid agents commission on
   them. Older orders are left exactly as they are, for a person to decide.
   (Same lesson as the MsouWout ride-commission backfill.) */
const LIFECYCLE_FROM = new Date(process.env.MPP_LIFECYCLE_FROM || '2026-10-16T00:42:13Z');

function dueAfterMin(checks) { return checks < SCHEDULE_MIN.length ? SCHEDULE_MIN[checks] : 60; }

async function tick(opts) {
  const o = opts || {};
  const verify = o.verify || require('../routes/payments').verifySolutionIPPayment;
  const now = o.now || new Date();
  if (!(LIFECYCLE_FROM instanceof Date) || isNaN(LIFECYCLE_FROM)) return { checked: 0, confirmed: 0, expired: 0, disabled: 'no start date' };
  const since = new Date(now.getTime() - GIVE_UP_HOURS * 3600 * 1000);
  const pending = await Order.find({
    paymentStatus: 'pending', status: 'pending', paymentMethod: { $in: ['moncash', 'natcash'] },
    createdAt: { $gte: since > LIFECYCLE_FROM ? since : LIFECYCLE_FROM }
  }).sort({ createdAt: 1 }).limit(300);
  const seen = new Set();
  let checked = 0, confirmed = 0;
  for (const order of pending) {
    const ref = order.paymentGroup || order.orderNumber;
    if (seen.has(ref)) continue;
    seen.add(ref);
    const last = order.paymentCheckedAt || order.createdAt;
    if (now - last < dueAfterMin(order.paymentChecks || 0) * 60 * 1000) continue;
    let gw = null;
    try { gw = await verify(ref); } catch (e) { gw = null; }
    checked++;
    await Order.updateMany({ customer: order.customer, $or: [{ paymentGroup: ref }, { orderNumber: ref }] },
      { $set: { paymentCheckedAt: now }, $inc: { paymentChecks: 1 } });
    if (gw && gw.status === true && gw.trans_status === 'ok') {
      const out = await lifecycle.confirmPayment(order, gw, { io: o.io, source: 'server_poller' });
      if (out.ok) confirmed += out.confirmed.length;
    }
  }
  // Unpaid for a whole day: one last look, then give the stock back.
  const stale = await Order.find({ paymentStatus: 'pending', status: 'pending', createdAt: { $lt: since, $gte: LIFECYCLE_FROM } }).limit(100);
  let expired = 0;
  for (const order of stale) {
    if (order.paymentMethod === 'moncash' || order.paymentMethod === 'natcash') {
      let gw = null;
      try { gw = await verify(order.paymentGroup || order.orderNumber); } catch (e) { gw = null; }
      if (gw && gw.status === true && gw.trans_status === 'ok') {
        const out = await lifecycle.confirmPayment(order, gw, { io: o.io, source: 'server_poller_final' });
        if (out.ok) { confirmed += out.confirmed.length; continue; }
      }
    }
    const c = await lifecycle.cancelOrder(order, { role: 'system', reason: 'Not paid within ' + GIVE_UP_HOURS + ' hours' });
    if (c.ok) expired++;
  }
  return { checked, confirmed, expired };
}

module.exports = { tick, SCHEDULE_MIN, GIVE_UP_HOURS, LIFECYCLE_FROM };
