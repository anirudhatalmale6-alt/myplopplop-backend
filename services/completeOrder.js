/* ⛔ RETIRED 16 Oct 2026.
 *
 * This used to close a shop order and credit the merchant (and sometimes the
 * driver) on its own, from whichever route called it - with no delivery code,
 * no check that the order was not cancelled, and a guard that was not atomic.
 * A cancelled order's delivery could still complete here and pay everyone.
 *
 * The ONLY way an order becomes "delivered" is now
 * services/orderLifecycle.js completeDelivery (the customer's code, or an
 * admin exception with a written reason), which credits the shop and the
 * driver's 80% exactly once. Anything still calling this is refused loudly
 * rather than allowed to move money a second way.
 */
async function markOrderDelivered(order) {
  console.error('[RETIRED] completeOrder.markOrderDelivered called for ' + (order && order.orderNumber) +
    ' - use services/orderLifecycle.completeDelivery');
  throw new Error('markOrderDelivered is retired: use orderLifecycle.completeDelivery');
}

module.exports = { markOrderDelivered };
