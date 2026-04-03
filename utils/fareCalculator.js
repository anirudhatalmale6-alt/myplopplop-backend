// MyPlopPlop fare calculator
// Commission: 25% on all rides and deliveries

const COMMISSION_RATE = 0.25;

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
  const totalFare = Math.max(rawFare, rate.minFare);
  const commission = Math.round(totalFare * COMMISSION_RATE);
  const driverEarning = totalFare - commission;

  return {
    totalFare: Math.round(totalFare),
    commission,
    driverEarning,
    breakdown: {
      baseFare: rate.baseFare,
      distanceCharge: Math.round(rate.perKm * distanceKm),
      distanceKm: Math.round(distanceKm * 10) / 10,
      commissionRate: `${COMMISSION_RATE * 100}%`
    }
  };
}

module.exports = { calculateFare, COMMISSION_RATE, RATES };
