/* ═══ MYPLOPPLOP PRICING - THE ONE PLACE IT IS DECIDED ══════════════════════
   Jeffery, 15 Oct 2026 (revised the same day):
     "Business registration remains FREE. Product listings remain FREE.
      Buyer platform fee: 7.5%. Seller transaction fee: 5% of the eligible
      product sale amount. Koutye Ajan commission remains 3% of the eligible
      product sale amount... The seller transaction fee should be deducted
      from the merchant's settlement after a completed, confirmed-paid order.
      ...We must notify merchants and obtain acceptance of the revised pricing
      before applying it to their future sales. ...Do not activate them yet."

   Everything below is a SETTING on the service, so moving between stages is a
   change of setting, never a code deploy at the sensitive moment.

   MPP_SERVICE_FEE_PCT      buyer fee, % of the product subtotal (0-20). Unset: 5.
   MPP_PRICING_PHASE        off (unset) | notice | active
       off     EXACTLY as before 15 Oct: the seller is charged
               store.commissionRate (10% on most shops) as the code always did.
       notice  merchants are SHOWN the new pricing and can accept it. No seller
               fee is charged to anybody yet: Jeffery's "0% during onboarding".
       active  the seller fee applies to merchants who accepted THIS version,
               on orders placed after they accepted. Everybody else: 0%.
   MPP_SELLER_FEE_PCT       the seller fee in the new pricing (0-20).
   MPP_PRICING_VERSION      which wording a merchant accepted; change it and
                            everybody must accept again.
   MPP_PRICING_EFFECTIVE    date shown to merchants ("from 1 Nov").
   KOUTYE_MPP_ORDER_PCT     the Ajan's % of the PRODUCT SUBTOTAL, paid from
                            the platform's fees. Unset: the old rule (1% of the
                            order total). Ignored if it exceeds what the
                            platform takes in fees on the sale.            */
function num(v) { const n = Number(v); return isFinite(n) ? n : null; }
function pct0to20(v, dflt) { const n = num(v); return n != null && n >= 0 && n <= 20 ? n : dflt; }

function serviceFeePct() { return pct0to20(process.env.MPP_SERVICE_FEE_PCT, 5); }
function phase() {
  const p = String(process.env.MPP_PRICING_PHASE || '').toLowerCase();
  return p === 'notice' || p === 'active' ? p : 'off';
}
function sellerFeePct() { return pct0to20(process.env.MPP_SELLER_FEE_PCT, null); }
function pricingVersion() { return String(process.env.MPP_PRICING_VERSION || '2026-10').slice(0, 40); }
function effectiveDate() { return String(process.env.MPP_PRICING_EFFECTIVE || '').slice(0, 40); }

function serviceFeeFor(subtotal) { return Math.round((Number(subtotal) || 0) * serviceFeePct() / 100); }

function hasAccepted(store) {
  return !!(store && store.pricingAcceptedVersion && store.pricingAcceptedVersion === pricingVersion());
}

/* The seller fee for ONE order, worked out when the order is placed and
   written on it, so a later change of setting never rewrites an old sale. */
function sellerFeeFor(store, subtotal) {
  const sub = Number(subtotal) || 0;
  const ph = phase();
  if (ph === 'off') {
    const pct = (store && store.commissionRate != null) ? Number(store.commissionRate) : 10;
    return { pct, fee: Math.round(sub * pct / 100), rule: 'legacy' };
  }
  if (ph === 'active' && sellerFeePct() != null && hasAccepted(store)) {
    const pct = sellerFeePct();
    return { pct, fee: Math.round(sub * pct / 100), rule: 'accepted' };
  }
  return { pct: 0, fee: 0, rule: 'not_accepted' };
}

/* null = the old Ajan rule. The Ajan is paid out of what the platform takes,
   never on top of it, so it may not exceed the buyer fee plus the seller fee
   actually charged on that sale (the buyer fee alone when unknown). */
function agentOrderPct(sellerPctOnThisSale) {
  const v = num(process.env.KOUTYE_MPP_ORDER_PCT);
  if (v == null || v <= 0) return null;
  const cap = serviceFeePct() + (Number(sellerPctOnThisSale) || 0);
  return v <= cap ? v : null;
}

/* What a merchant's dashboard needs to explain the pricing. */
function pricingFor(store) {
  return {
    phase: phase(),
    version: pricingVersion(),
    effective: effectiveDate(),
    buyerFeePct: serviceFeePct(),
    sellerFeePct: phase() === 'off' ? null : sellerFeePct(),
    accepted: hasAccepted(store),
    acceptedAt: hasAccepted(store) ? store.pricingAcceptedAt || null : null
  };
}

module.exports = { serviceFeePct, serviceFeeFor, sellerFeeFor, agentOrderPct, phase, sellerFeePct,
                   pricingVersion, effectiveDate, hasAccepted, pricingFor };
