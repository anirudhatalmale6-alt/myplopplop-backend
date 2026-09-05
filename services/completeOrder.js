// Closing a shop order — the one place it happens.
//
// A shop order can finish at either end: the merchant closes a self-pickup
// order himself, or a delivery driver finishes the ride the order was
// dispatched as. Only the first of those ever did anything, so a delivered
// order stayed at "ready" for ever, the customer's tracking page never
// completed and the MERCHANT WAS NEVER CREDITED for a sale he had delivered.
//
// Both ends now call this.

const User = require('../models/User');
const Store = require('../models/Store');
const Transaction = require('../models/Transaction');

async function markOrderDelivered(order) {
  // Safe to call twice: the merchant may close an order the driver just closed.
  // The guard is deliveredAt, not status — the merchant's route sets the status
  // to "delivered" before calling in, so testing the status would return here
  // having credited nobody.
  if (order.deliveredAt) return order;

  order.status = 'delivered';
  order.deliveredAt = new Date();

  if (order.paymentStatus === 'paid') {
    // The shop's share goes to pending_balance: held, verified, then released.
    const store = await Store.findById(order.store);
    if (store) {
      const merchant = await User.findById(store.owner);
      if (merchant) {
        merchant.wallet.pending_balance += order.merchantEarning || 0;
        await merchant.save();
      }
    }
    order.payoutStatus = 'pending';

    // The rider is paid once. When the order was dispatched as a ride, the ride
    // already paid him (routes/rides.js on "delivered"), so paying here as well
    // would pay the same trip twice. Only pay here for an order closed without
    // a dispatched ride.
    if (!order.rideId && order.rider && order.deliveryDriverCut > 0) {
      const driver = await User.findById(order.rider);
      if (driver) {
        driver.wallet.balance += order.deliveryDriverCut;
        await driver.save();
        await Transaction.create({
          user: driver._id,
          type: 'earning',
          amount: order.deliveryDriverCut,
          currency: 'HTG',
          method: 'wallet',
          status: 'completed',
          reference: order.orderNumber,
          description: 'Delivery earning (80%)'
        });
      }
    }
  }

  await order.save();
  return order;
}

module.exports = { markOrderDelivered };
