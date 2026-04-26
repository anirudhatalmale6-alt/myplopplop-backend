const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const Koutye = require('../models/Koutye');
const KoutyeReferral = require('../models/KoutyeReferral');
const KoutyeCommission = require('../models/KoutyeCommission');
const KoutyePayout = require('../models/KoutyePayout');
const KoutyeWallet = require('../models/KoutyeWallet');
const Transaction = require('../models/Transaction');

const SOLUTIONIP_URL = process.env.SOLUTIONIP_URL || 'https://plopplop.solutionip.app';
const SOLUTIONIP_CLIENT_ID = process.env.SOLUTIONIP_CLIENT_ID || 'pp_1ohu5zz2tcx';

function generateOrderId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8);
}

async function createSolutionIPPayment(referenceId, amount, paymentMethod) {
  const response = await fetch(`${SOLUTIONIP_URL}/api/paiement-marchand`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: SOLUTIONIP_CLIENT_ID,
      refference_id: referenceId,
      montant: amount,
      payment_method: paymentMethod || 'all'
    })
  });
  return response.json();
}

async function verifySolutionIPPayment(referenceId) {
  const response = await fetch(`${SOLUTIONIP_URL}/api/paiement-verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: SOLUTIONIP_CLIENT_ID,
      refference_id: referenceId
    })
  });
  return response.json();
}

// Commission rates per platform (based on platform fees, not full amount)
const PLATFORM_FEES = {
  '48hoursready': { feeRate: 1.0, koutyeRate: 0.10, label: '10% of package price' },
  'msouwout': { feeRate: 0.25, koutyeRate: 0.10, label: '10% of 25% platform fee' },
  'myplopplop': { feeRate: 0.10, koutyeRate: 0.10, label: '10% of 10% platform fee' },
  'utility': { feeRate: 0.05, koutyeRate: 0.10, label: '10% of 5% service fee' },
  'sol': { feeRate: 0.02, koutyeRate: 0.10, label: '10% of 2% cycle fee' },
  'prolakay': { feeRate: 0.15, koutyeRate: 0.10, label: '10% of 15% platform fee' }
};

// ─── 48HoursReady Package Purchase ───
// POST /api/koutye-payments/package/purchase
router.post('/package/purchase', async (req, res) => {
  try {
    const { packageType, amount, paymentMethod, customerName, customerPhone, customerEmail, koutyeCode } = req.body;

    if (!packageType || !amount || !paymentMethod) {
      return res.status(400).json({ success: false, message: 'packageType, amount, and paymentMethod required' });
    }

    const orderId = generateOrderId('48hr');

    const transaction = await Transaction.create({
      type: 'payment',
      amount,
      method: paymentMethod,
      status: 'pending',
      reference: orderId,
      description: `48HoursReady ${packageType} package - ${customerName || 'Anonymous'}`
    });

    // If Koutye referral code provided, track the commission
    let koutyeCommission = null;
    if (koutyeCode) {
      const koutye = await Koutye.findOne({ koutyeCode: koutyeCode.toUpperCase(), status: 'active' });
      if (koutye) {
        let referral = await KoutyeReferral.findOne({
          koutye: koutye._id,
          platform: '48hoursready',
          'referredEntity.phone': customerPhone,
          status: 'active'
        });

        if (!referral) {
          const expiryDate = new Date();
          expiryDate.setDate(expiryDate.getDate() + 365);
          referral = await KoutyeReferral.create({
            koutye: koutye._id,
            koutyeCode: koutye.koutyeCode,
            platform: '48hoursready',
            referredEntity: {
              type: 'business',
              name: customerName,
              phone: customerPhone,
              email: customerEmail
            },
            commissionRate: 0.10,
            commissionType: 'percentage',
            expiryDate,
            sourceDescription: '48HoursReady package referral'
          });
          koutye.stats.totalReferrals += 1;
          koutye.stats.activeReferrals += 1;
          if (koutye.platformBreakdown['48hoursready']) {
            koutye.platformBreakdown['48hoursready'].referrals += 1;
          }
          await koutye.save();
        }

        const commissionAmount = Math.round(amount * PLATFORM_FEES['48hoursready'].koutyeRate * 100) / 100;
        koutyeCommission = await KoutyeCommission.create({
          koutye: koutye._id,
          referral: referral._id,
          platform: '48hoursready',
          transactionId: orderId,
          serviceType: 'package',
          sourceAmount: amount,
          platformFee: amount,
          commissionRate: 0.10,
          amount: commissionAmount,
          status: 'pending',
          description: `10% commission on ${packageType} package ($${amount})`,
          expiresAt: referral.expiryDate
        });
      }
    }

    // Process payment via SolutionIP (Pey'M PlopPlop gateway)
    const validMethods = ['moncash', 'natcash', 'kashpaw', 'all'];
    const sipMethod = validMethods.includes(paymentMethod) ? paymentMethod : 'all';

    try {
      const sipResult = await createSolutionIPPayment(orderId, Math.round(amount * 130), sipMethod);

      if (sipResult.status === true) {
        return res.json({
          success: true,
          orderId,
          transactionId: transaction._id,
          paymentUrl: sipResult.url,
          sipTransactionId: sipResult.transaction_id,
          mode: 'live',
          koutyeTracked: !!koutyeCommission
        });
      } else {
        return res.status(400).json({
          success: false,
          message: sipResult.message || 'Payment creation failed',
          orderId,
          koutyeTracked: !!koutyeCommission
        });
      }
    } catch (sipErr) {
      console.error('SolutionIP payment error:', sipErr);
      return res.status(500).json({
        success: false,
        message: 'Payment gateway unavailable',
        orderId
      });
    }
  } catch (err) {
    console.error('Package purchase error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── Verify 48HR Package Payment (MonCash callback) ───
// GET /api/koutye-payments/package/verify?orderId=xxx
router.get('/package/verify', async (req, res) => {
  try {
    const { orderId } = req.query;
    if (!orderId) {
      return res.status(400).json({ success: false, message: 'orderId required' });
    }

    const transaction = await Transaction.findOne({ reference: orderId, status: 'pending' });
    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found or already processed' });
    }

    const sipResult = await verifySolutionIPPayment(orderId);

    if (sipResult.status === true && sipResult.trans_status === 'ok') {
      transaction.status = 'completed';
      await transaction.save();

      const commissions = await KoutyeCommission.find({ transactionId: orderId, status: 'pending' });
      for (const c of commissions) {
        c.status = 'validated';
        c.validatedAt = new Date();
        await c.save();

        const koutye = await Koutye.findById(c.koutye);
        if (koutye) {
          koutye.stats.totalEarnings += c.amount;
          koutye.stats.pendingEarnings += c.amount;
          if (koutye.platformBreakdown[c.platform]) {
            koutye.platformBreakdown[c.platform].earnings += c.amount;
          }
          koutye.updateTier();
          await koutye.save();
        }
      }

      return res.json({
        success: true,
        message: 'Payment verified, commissions validated',
        payment: {
          amount: sipResult.montant,
          method: sipResult.method,
          date: sipResult.date,
          time: sipResult.heure
        }
      });
    } else {
      return res.status(400).json({
        success: false,
        message: sipResult.message || 'Payment not completed yet'
      });
    }
  } catch (err) {
    console.error('Package verify error:', err);
    res.status(500).json({ success: false, message: 'Verification failed' });
  }
});

// ─── Process Koutye Payout via MonCash Transfer ───
// POST /api/koutye-payments/payout/send
router.post('/payout/send', protect, authorize('admin'), async (req, res) => {
  try {
    const { payoutId } = req.body;
    const payout = await KoutyePayout.findById(payoutId);
    if (!payout) {
      return res.status(404).json({ success: false, message: 'Payout not found' });
    }
    if (!['pending', 'approved'].includes(payout.status)) {
      return res.status(400).json({ success: false, message: `Cannot send payout with status: ${payout.status}` });
    }

    const koutye = await Koutye.findById(payout.koutye).populate('user', 'name phone');
    const receiverPhone = payout.destinationAccount || payout.details?.phone || koutye?.user?.phone;

    if (!receiverPhone) {
      return res.status(400).json({ success: false, message: 'No receiver phone number' });
    }

    const cleanPhone = receiverPhone.replace(/[^0-9]/g, '');

    // All payouts are admin-approved manual transfers
    // Admin sends via MonCash app, NatCash *202#, or bank, then marks as paid
    const methodInstructions = {
      moncash: {
        step1: 'Open MonCash app on your phone',
        step2: 'Select "Voye Lajan" (Send Money)',
        step3: `Enter receiver: ${cleanPhone}`,
        step4: `Amount: ${payout.amount} HTG`,
        step5: 'Confirm and save the transaction reference',
        step6: 'Use the mark-paid endpoint with the MonCash reference'
      },
      natcash: {
        step1: 'Dial *202# on Natcom phone',
        step2: 'Select "Send Money"',
        step3: `Enter: ${cleanPhone}`,
        step4: `Amount: ${payout.amount} HTG`,
        step5: 'Confirm with NatCash PIN',
        step6: 'Use the mark-paid endpoint with reference number'
      },
      bank: {
        step1: `Transfer ${payout.amount} HTG to ${payout.details?.bankName || 'bank account'}`,
        step2: `Account: ${payout.details?.accountNumber || 'N/A'}`,
        step3: 'Use the mark-paid endpoint with bank reference'
      }
    };

    payout.status = 'approved';
    payout.approvedAt = new Date();
    payout.approvedBy = req.user._id;
    payout.adminNote = `${payout.method} payout approved: ${payout.amount} HTG to ${cleanPhone}`;
    await payout.save();

    res.json({
      success: true,
      data: {
        payoutId: payout._id,
        status: 'approved',
        method: payout.method,
        amount: payout.amount,
        receiver: cleanPhone,
        koutyeCode: koutye?.koutyeCode,
        instructions: methodInstructions[payout.method] || methodInstructions.moncash,
        markPaidUrl: `/api/koutye/admin/payouts/${payout._id}/mark-paid`
      }
    });
  } catch (err) {
    console.error('Payout send error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── Record commission from any platform transaction ───
// POST /api/koutye-payments/commission/trigger
router.post('/commission/trigger', async (req, res) => {
  try {
    const { koutyeCode, platform, transactionAmount, transactionId, serviceType, description } = req.body;

    if (!koutyeCode || !platform || !transactionAmount) {
      return res.status(400).json({ success: false, message: 'koutyeCode, platform, transactionAmount required' });
    }

    const fees = PLATFORM_FEES[platform];
    if (!fees) {
      return res.status(400).json({ success: false, message: 'Invalid platform' });
    }

    const koutye = await Koutye.findOne({ koutyeCode: koutyeCode.toUpperCase(), status: 'active' });
    if (!koutye) {
      return res.json({ success: true, commissioned: false, reason: 'Invalid or inactive Koutye code' });
    }

    const referral = await KoutyeReferral.findOne({
      koutye: koutye._id,
      platform,
      status: 'active',
      expiryDate: { $gt: new Date() }
    }).sort({ createdAt: -1 });

    if (!referral) {
      return res.json({ success: true, commissioned: false, reason: 'No active referral for this platform' });
    }

    const platformFee = Math.round(transactionAmount * fees.feeRate * 100) / 100;
    const commissionAmount = Math.round(platformFee * fees.koutyeRate * 100) / 100;

    if (commissionAmount <= 0) {
      return res.json({ success: true, commissioned: false, reason: 'Commission too small' });
    }

    const commission = await KoutyeCommission.create({
      koutye: koutye._id,
      referral: referral._id,
      platform,
      transactionId: transactionId || generateOrderId('com'),
      serviceType: serviceType || 'package',
      sourceAmount: transactionAmount,
      platformFee,
      commissionRate: fees.koutyeRate,
      amount: commissionAmount,
      status: 'pending',
      description: description || `${fees.koutyeRate * 100}% of ${fees.feeRate * 100}% platform fee on ${platform}`,
      expiresAt: referral.expiryDate
    });

    koutye.stats.totalEarnings += commissionAmount;
    koutye.stats.pendingEarnings += commissionAmount;
    if (koutye.platformBreakdown[platform]) {
      koutye.platformBreakdown[platform].earnings += commissionAmount;
    }
    koutye.updateTier();
    await koutye.save();

    referral.totalCommissionEarned += commissionAmount;
    referral.commissionCount += 1;
    referral.lastCommissionDate = new Date();
    await referral.save();

    res.json({
      success: true,
      commissioned: true,
      data: {
        commissionId: commission._id,
        transactionAmount,
        platformFee,
        commissionAmount,
        platform,
        koutyeCode: koutye.koutyeCode
      }
    });
  } catch (err) {
    console.error('Commission trigger error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── Batch validate pending commissions ───
// POST /api/koutye-payments/commission/validate-batch
router.post('/commission/validate-batch', protect, authorize('admin'), async (req, res) => {
  try {
    const pending = await KoutyeCommission.find({ status: 'pending' });
    let validated = 0;

    for (const c of pending) {
      c.status = 'validated';
      c.validatedAt = new Date();
      await c.save();
      validated++;
    }

    res.json({ success: true, data: { validatedCount: validated } });
  } catch (err) {
    console.error('Batch validate error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── Batch approve validated commissions ───
// POST /api/koutye-payments/commission/approve-batch
router.post('/commission/approve-batch', protect, authorize('admin'), async (req, res) => {
  try {
    const validated = await KoutyeCommission.find({ status: 'validated' });
    let approved = 0;

    for (const c of validated) {
      c.status = 'approved';
      c.approvedAt = new Date();
      await c.save();
      approved++;
    }

    res.json({ success: true, data: { approvedCount: approved } });
  } catch (err) {
    console.error('Batch approve error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
