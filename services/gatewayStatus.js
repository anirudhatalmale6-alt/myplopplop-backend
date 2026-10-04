/* What "the money arrived" means, in one place.
 *
 * Jeffery, 4 Oct 2026: "fix the inconsistent payment confirmation status. Use
 * the same confirmed gateway status logic that is working with the real
 * MonCash/NatCash transactions."
 *
 * The gateway answers two different questions in one body:
 *   status      - whether the LOOKUP worked
 *   trans_status- whether the MONEY arrived
 * Both have to be right. A lookup that succeeded and found nothing paid is
 * status:true with a trans_status that is not 'ok', and reading only `status`
 * would call that a payment.
 *
 * 🔑 'ok' IS OBSERVED, NOT ASSUMED. haitibiznis-backend/utils/verifyPayment.js
 * was written after watching four real transactions - "answered status:true for
 * all four, and trans_status 'ok' for exactly one" - and it is the check that
 * confirmed MW-3UPWWIP, a real NatCash payment, on 3 Oct 2026.
 *
 * ⛔ routes/utility.js used to test for 'completed' / 'Completed' in one place
 * and 'ok' in another, against this same endpoint, in the same file. A utility
 * payment confirmed down the first path could therefore never be marked paid.
 * One definition exists now so the two can never disagree again.
 */
function gatewayConfirmed(data) {
  return !!(data && data.status === true && data.trans_status === 'ok');
}

module.exports = { gatewayConfirmed };
