// MyPlopPlop fare calculator
//
// The platform's share of each fare. 15 Oct 2026, Jeffery, confirming the
// delivery agreement: "Delivery driver receives 80% of the delivery fare.
// HaitiBiznis receives 20% of the delivery fare. This arrangement remains
// unchanged." This file said 25% for deliveries too, so a delivery dispatched
// as a ride paid the driver 75% while the order itself recorded 80/20
// (routes/orders.js deliveryDriverCut). No delivery had been completed, so no
// driver was underpaid. Passenger rides keep their 25%: not part of that
// decision.

const COMMISSION_RATE = 0.25;                       // passenger rides
const COMMISSION_RATES_BY_TYPE = { delivery: 0.20, ride: COMMISSION_RATE };
function commissionRateFor(type) {
  return COMMISSION_RATES_BY_TYPE[type] != null ? COMMISSION_RATES_BY_TYPE[type] : COMMISSION_RATE;
}

// Base rates in HTG (Haitian Gourde)
const RATES = {
  delivery: {
    baseFare: 100,       // Base fare
    perKm: 25,           // Per kilometer
    minFare: 150         // Minimum fare
  },
  ride: {
    baseFare: 75,
    perKm: 20,
    minFare: 100
  }
};

function calculateFare(type, distanceKm) {
  const rate = RATES[type] || RATES.delivery;
  const rawFare = rate.baseFare + (rate.perKm * distanceKm);
  /* Split the fare the customer is actually charged (rounded), so the two
     parts always add up to it and match the order's own 80/20 to the gourde.
     Splitting the unrounded fare paid 317 on a 397 delivery the order
     recorded as 318. */
  const totalFare = Math.round(Math.max(rawFare, rate.minFare));
  const rateType = RATES[type] ? type : 'delivery';
  const commission = Math.round(totalFare * commissionRateFor(rateType));
  const driverEarning = totalFare - commission;

  return {
    totalFare: Math.round(totalFare),
    commission,
    driverEarning,
    breakdown: {
      baseFare: rate.baseFare,
      distanceCharge: Math.round(rate.perKm * distanceKm),
      distanceKm: Math.round(distanceKm * 10) / 10,
      commissionRate: `${commissionRateFor(rateType) * 100}%`
    }
  };
}

module.exports = { calculateFare, COMMISSION_RATE, commissionRateFor, RATES };
