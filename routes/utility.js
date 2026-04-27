const express = require('express');
const router = express.Router();
const { protect, authorize } = require('../middleware/auth');
const UtilityTransaction = require('../models/UtilityTransaction');
const PaymentLog = require('../models/PaymentLog');
const Notification = require('../models/Notification');

const SOLUTIONIP_URL = process.env.SOLUTIONIP_URL || 'https://plopplop.solutionip.app';
const SOLUTIONIP_CLIENT_ID = process.env.SOLUTIONIP_CLIENT_ID || 'pp_1ohu5zz2tcx';
const SERVICE_FEE_RATE = 0.05;

function generateRefId(type) {
  var prefix = type === 'edh' ? 'EDH' : 'DIN';
  return prefix + '-' + Date.now().toString(36).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
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

async function logNotification(transactionId, channel, recipient, message, eventType) {
  try {
    await Notification.create({
      transaction_id: transactionId,
      channel,
      recipient,
      message,
      event_type: eventType,
      status: 'sent',
      sent_at: new Date()
    });
  } catch (e) {
    console.error('Notification log error:', e.message);
  }
}

// ══════════════════════════════════════════
// CUSTOMER ENDPOINTS
// ══════════════════════════════════════════

// POST /api/utility/create-transaction
router.post('/create-transaction', async (req, res) => {
  try {
    const {
      utility_type, customer_name, phone, email, zone,
      account_number, meter_number, amount, payment_method,
      koutye_code
    } = req.body;

    if (!utility_type || !customer_name || !phone || !amount || !payment_method) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    if (amount < 100) {
      return res.status(400).json({ success: false, message: 'Minimum amount is 100 HTG' });
    }

    if (utility_type === 'edh' && !meter_number) {
      return res.status(400).json({ success: false, message: 'Meter number required for EDH' });
    }

    if (utility_type === 'dinepa' && !account_number) {
      return res.status(400).json({ success: false, message: 'Account number required for DINEPA' });
    }

    const service_fee = Math.round(amount * SERVICE_FEE_RATE);
    const total_amount = amount + service_fee;
    const reference_id = generateRefId(utility_type);

    const transaction = await UtilityTransaction.create({
      reference_id,
      utility_type,
      customer_name,
      phone,
      email: email || undefined,
      zone: zone || undefined,
      account_number: account_number || undefined,
      meter_number: meter_number || undefined,
      amount,
      service_fee,
      total_amount,
      payment_method,
      payment_status: 'pending',
      processing_status: 'new',
      token_status: utility_type === 'edh' ? 'pending' : undefined,
      koutye_code: koutye_code || undefined,
      status_logs: [{
        old_status: '',
        new_status: 'pending',
        note: 'Transaction created',
        changed_by: 'system'
      }]
    });

    await logNotification(transaction._id, 'whatsapp', phone, 'Transaction ' + reference_id + ' created', 'transaction_created');

    var methodMap = { moncash: 'moncash', natcash: 'natcash', card: 'all' };
    try {
      const sipResult = await createSolutionIPPayment(
        reference_id,
        total_amount,
        methodMap[payment_method] || 'all'
      );

      await PaymentLog.create({
        transaction_id: transaction._id,
        payment_method,
        amount: total_amount,
        status: sipResult.status === true ? 'pending' : 'failed',
        raw_response: sipResult,
        webhook_source: 'create'
      });

      if (sipResult.status === true && sipResult.url) {
        transaction.payment_url = sipResult.url;
        transaction.sip_transaction_id = sipResult.transaction_id;
        await transaction.save();

        return res.json({
          success: true,
          reference_id,
          transaction_id: transaction._id,
          payment_url: sipResult.url,
          total_amount
        });
      }
    } catch (sipErr) {
      console.error('SolutionIP error:', sipErr.message);
    }

    return res.json({
      success: true,
      reference_id,
      transaction_id: transaction._id,
      total_amount,
      message: 'Transaction created. Payment pending manual processing.'
    });

  } catch (error) {
    console.error('Create utility transaction error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/utility/transaction/:referenceId
router.get('/transaction/:referenceId', async (req, res) => {
  try {
    const transaction = await UtilityTransaction.findOne({ reference_id: req.params.referenceId });
    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }
    res.json({ success: true, transaction });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/utility/pay (manual verify)
router.post('/pay', async (req, res) => {
  try {
    const { reference_id } = req.body;
    if (!reference_id) {
      return res.status(400).json({ success: false, message: 'Reference ID required' });
    }

    const transaction = await UtilityTransaction.findOne({ reference_id });
    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    try {
      const result = await verifySolutionIPPayment(reference_id);

      await PaymentLog.create({
        transaction_id: transaction._id,
        payment_method: transaction.payment_method,
        provider_reference: result.transaction_id || '',
        amount: transaction.total_amount,
        status: (result.trans_status === 'completed' || result.trans_status === 'Completed') ? 'completed' : 'pending',
        raw_response: result,
        webhook_source: 'verify'
      });

      if (result.trans_status === 'completed' || result.trans_status === 'Completed') {
        transaction.payment_status = 'paid';
        transaction.processing_status = 'processing';
        transaction.provider_reference = result.transaction_id || '';
        transaction.status_logs.push({
          old_status: 'pending',
          new_status: 'paid',
          note: 'Payment verified via SolutionIP',
          changed_by: 'system'
        });
        await transaction.save();

        await logNotification(transaction._id, 'whatsapp', transaction.phone, 'Payment confirmed for ' + reference_id, 'payment_confirmed');

        return res.json({ success: true, status: 'paid', transaction });
      }
    } catch (verifyErr) {
      console.error('Verify error:', verifyErr.message);
    }

    return res.json({
      success: true,
      status: transaction.payment_status,
      transaction
    });

  } catch (error) {
    console.error('Pay verify error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/utility/history?phone=XXXX
router.get('/history', async (req, res) => {
  try {
    const { phone, page = 1, limit = 20 } = req.query;
    if (!phone) {
      return res.status(400).json({ success: false, message: 'Phone number required' });
    }

    const cleanPhone = phone.replace(/[^0-9+]/g, '');
    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [transactions, total] = await Promise.all([
      UtilityTransaction.find({ phone: { $regex: cleanPhone } })
        .sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit))
        .select('reference_id utility_type amount total_amount payment_status token createdAt'),
      UtilityTransaction.countDocuments({ phone: { $regex: cleanPhone } })
    ]);

    res.json({ success: true, transactions, total, page: parseInt(page) });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ══════════════════════════════════════════
// PAYMENT WEBHOOKS
// ══════════════════════════════════════════

// POST /api/utility/webhook/moncash
router.post('/webhook/moncash', async (req, res) => {
  try {
    const payload = req.body;
    const refId = payload.reference_id || payload.refference_id || payload.orderId || '';

    const transaction = await UtilityTransaction.findOne({ reference_id: refId });

    await PaymentLog.create({
      transaction_id: transaction ? transaction._id : undefined,
      payment_method: 'moncash',
      provider_reference: payload.transaction_id || payload.transactionId || '',
      amount: payload.amount || payload.montant || 0,
      status: (payload.status === 'completed' || payload.status === 'success') ? 'completed' : 'failed',
      raw_response: payload,
      webhook_source: 'webhook_moncash'
    });

    if (transaction && (payload.status === 'completed' || payload.status === 'success')) {
      transaction.payment_status = 'paid';
      transaction.processing_status = 'processing';
      transaction.provider_reference = payload.transaction_id || payload.transactionId || '';
      transaction.status_logs.push({
        old_status: 'pending',
        new_status: 'paid',
        note: 'MonCash webhook: payment confirmed',
        changed_by: 'webhook'
      });
      await transaction.save();
      await logNotification(transaction._id, 'whatsapp', transaction.phone, 'MonCash payment confirmed for ' + refId, 'payment_confirmed');
    }

    res.json({ success: true });
  } catch (error) {
    console.error('MonCash webhook error:', error);
    res.status(200).json({ success: true });
  }
});

// POST /api/utility/webhook/natcash
router.post('/webhook/natcash', async (req, res) => {
  try {
    const payload = req.body;
    const refId = payload.reference_id || payload.refference_id || payload.orderId || '';

    const transaction = await UtilityTransaction.findOne({ reference_id: refId });

    await PaymentLog.create({
      transaction_id: transaction ? transaction._id : undefined,
      payment_method: 'natcash',
      provider_reference: payload.transaction_id || payload.transactionId || '',
      amount: payload.amount || payload.montant || 0,
      status: (payload.status === 'completed' || payload.status === 'success') ? 'completed' : 'failed',
      raw_response: payload,
      webhook_source: 'webhook_natcash'
    });

    if (transaction && (payload.status === 'completed' || payload.status === 'success')) {
      transaction.payment_status = 'paid';
      transaction.processing_status = 'processing';
      transaction.provider_reference = payload.transaction_id || payload.transactionId || '';
      transaction.status_logs.push({
        old_status: 'pending',
        new_status: 'paid',
        note: 'NatCash webhook: payment confirmed',
        changed_by: 'webhook'
      });
      await transaction.save();
      await logNotification(transaction._id, 'whatsapp', transaction.phone, 'NatCash payment confirmed for ' + refId, 'payment_confirmed');
    }

    res.json({ success: true });
  } catch (error) {
    console.error('NatCash webhook error:', error);
    res.status(200).json({ success: true });
  }
});

// POST /api/utility/webhook/card
router.post('/webhook/card', async (req, res) => {
  try {
    const payload = req.body;
    const refId = payload.reference_id || payload.refference_id || payload.orderId || '';

    const transaction = await UtilityTransaction.findOne({ reference_id: refId });

    await PaymentLog.create({
      transaction_id: transaction ? transaction._id : undefined,
      payment_method: 'card',
      provider_reference: payload.transaction_id || payload.transactionId || '',
      amount: payload.amount || payload.montant || 0,
      status: (payload.status === 'completed' || payload.status === 'success') ? 'completed' : 'failed',
      raw_response: payload,
      webhook_source: 'webhook_card'
    });

    if (transaction && (payload.status === 'completed' || payload.status === 'success')) {
      transaction.payment_status = 'paid';
      transaction.processing_status = 'processing';
      transaction.provider_reference = payload.transaction_id || payload.transactionId || '';
      transaction.status_logs.push({
        old_status: 'pending',
        new_status: 'paid',
        note: 'Card webhook: payment confirmed',
        changed_by: 'webhook'
      });
      await transaction.save();
      await logNotification(transaction._id, 'whatsapp', transaction.phone, 'Card payment confirmed for ' + refId, 'payment_confirmed');
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Card webhook error:', error);
    res.status(200).json({ success: true });
  }
});

// ══════════════════════════════════════════
// ADMIN ENDPOINTS
// ══════════════════════════════════════════

// GET /api/utility/admin/transactions
router.get('/admin/transactions', protect, authorize('admin'), async (req, res) => {
  try {
    const { status, type, page = 1, limit = 50, search } = req.query;
    const filter = {};
    if (status) filter.payment_status = status;
    if (type) filter.utility_type = type;
    if (search) {
      filter.$or = [
        { reference_id: { $regex: search, $options: 'i' } },
        { customer_name: { $regex: search, $options: 'i' } },
        { phone: { $regex: search, $options: 'i' } },
        { meter_number: { $regex: search, $options: 'i' } },
        { account_number: { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [transactions, total] = await Promise.all([
      UtilityTransaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
      UtilityTransaction.countDocuments(filter)
    ]);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const stats = await UtilityTransaction.aggregate([
      { $facet: {
        today_total: [{ $match: { createdAt: { $gte: today } } }, { $count: 'count' }],
        today_edh: [{ $match: { createdAt: { $gte: today }, utility_type: 'edh' } }, { $count: 'count' }],
        today_dinepa: [{ $match: { createdAt: { $gte: today }, utility_type: 'dinepa' } }, { $count: 'count' }],
        pending: [{ $match: { payment_status: 'pending' } }, { $count: 'count' }],
        paid: [{ $match: { payment_status: 'paid' } }, { $count: 'count' }],
        completed: [{ $match: { payment_status: 'completed' } }, { $count: 'count' }],
        failed: [{ $match: { payment_status: 'failed' } }, { $count: 'count' }],
        total_revenue: [{ $match: { payment_status: { $in: ['paid', 'completed'] } } }, { $group: { _id: null, sum: { $sum: '$total_amount' } } }],
        total_fees: [{ $match: { payment_status: { $in: ['paid', 'completed'] } } }, { $group: { _id: null, sum: { $sum: '$service_fee' } } }]
      }}
    ]);

    const s = stats[0] || {};
    res.json({
      success: true,
      transactions,
      total,
      page: parseInt(page),
      pages: Math.ceil(total / parseInt(limit)),
      stats: {
        today_total: s.today_total?.[0]?.count || 0,
        today_edh: s.today_edh?.[0]?.count || 0,
        today_dinepa: s.today_dinepa?.[0]?.count || 0,
        pending: s.pending?.[0]?.count || 0,
        paid: s.paid?.[0]?.count || 0,
        completed: s.completed?.[0]?.count || 0,
        failed: s.failed?.[0]?.count || 0,
        total_revenue: s.total_revenue?.[0]?.sum || 0,
        total_fees: s.total_fees?.[0]?.sum || 0
      }
    });
  } catch (error) {
    console.error('Admin list error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/utility/admin/transactions/:id
router.get('/admin/transactions/:id', protect, authorize('admin'), async (req, res) => {
  try {
    const transaction = await UtilityTransaction.findById(req.params.id);
    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    const [paymentLogs, notifications] = await Promise.all([
      PaymentLog.find({ transaction_id: transaction._id }).sort({ createdAt: -1 }),
      Notification.find({ transaction_id: transaction._id }).sort({ createdAt: -1 })
    ]);

    res.json({ success: true, transaction, payment_logs: paymentLogs, notifications });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH /api/utility/admin/transactions/:id/status
router.patch('/admin/transactions/:id/status', protect, authorize('admin'), async (req, res) => {
  try {
    const { status, processing_status, note } = req.body;
    const validPaymentStatuses = ['pending', 'paid', 'completed', 'failed', 'refunded'];
    const validProcessingStatuses = ['new', 'processing', 'manual_review', 'completed', 'failed'];

    const transaction = await UtilityTransaction.findById(req.params.id);
    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    const oldStatus = transaction.payment_status;

    if (status && validPaymentStatuses.includes(status)) {
      transaction.payment_status = status;
    }

    if (processing_status && validProcessingStatuses.includes(processing_status)) {
      transaction.processing_status = processing_status;
    }

    transaction.status_logs.push({
      old_status: oldStatus,
      new_status: status || oldStatus,
      note: note || '',
      changed_by: req.user.name || req.user._id.toString()
    });

    await transaction.save();

    if (status === 'failed') {
      await logNotification(transaction._id, 'whatsapp', transaction.phone, 'Transaction ' + transaction.reference_id + ' failed', 'transaction_failed');
    }

    res.json({ success: true, transaction });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH /api/utility/admin/transactions/:id/token
router.patch('/admin/transactions/:id/token', protect, authorize('admin'), async (req, res) => {
  try {
    const { token, admin_notes } = req.body;
    const transaction = await UtilityTransaction.findById(req.params.id);
    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    if (token) {
      transaction.token = token;
      transaction.token_status = 'generated';
    }
    if (admin_notes) transaction.admin_notes = admin_notes;

    transaction.status_logs.push({
      old_status: transaction.payment_status,
      new_status: transaction.payment_status,
      note: token ? 'EDH token added: ' + token : 'Admin notes updated',
      changed_by: req.user.name || req.user._id.toString()
    });

    await transaction.save();
    res.json({ success: true, transaction });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// PATCH /api/utility/admin/transactions/:id/receipt
router.patch('/admin/transactions/:id/receipt', protect, authorize('admin'), async (req, res) => {
  try {
    const { receipt_url, admin_notes } = req.body;
    const transaction = await UtilityTransaction.findById(req.params.id);
    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    if (receipt_url) transaction.receipt_url = receipt_url;
    if (admin_notes) transaction.admin_notes = admin_notes;

    transaction.status_logs.push({
      old_status: transaction.payment_status,
      new_status: transaction.payment_status,
      note: 'DINEPA receipt uploaded',
      changed_by: req.user.name || req.user._id.toString()
    });

    await transaction.save();
    res.json({ success: true, transaction });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// POST /api/utility/admin/transactions/:id/send-confirmation
router.post('/admin/transactions/:id/send-confirmation', protect, authorize('admin'), async (req, res) => {
  try {
    const transaction = await UtilityTransaction.findById(req.params.id);
    if (!transaction) {
      return res.status(404).json({ success: false, message: 'Transaction not found' });
    }

    var msg = '';
    var eventType = 'token_delivered';
    if (transaction.utility_type === 'edh') {
      msg = 'EDH Prepaye - HaitiBiznis\n';
      msg += 'Ref: ' + transaction.reference_id + '\n';
      msg += 'Compteur: ' + transaction.meter_number + '\n';
      msg += 'Montan: ' + transaction.amount + ' HTG\n';
      if (transaction.token) {
        msg += 'TOKEN: ' + transaction.token + '\n';
        transaction.token_status = 'sent';
      }
      msg += 'Mesi pou konfyans ou!';
    } else {
      msg = 'DINEPA Peman - HaitiBiznis\n';
      msg += 'Ref: ' + transaction.reference_id + '\n';
      msg += 'Kont: ' + transaction.account_number + '\n';
      msg += 'Montan: ' + transaction.amount + ' HTG\n';
      msg += 'Peman ou konplete. Mesi!';
      eventType = 'receipt_delivered';
    }

    var whatsappUrl = 'https://wa.me/' + transaction.phone.replace(/[^0-9]/g, '') + '?text=' + encodeURIComponent(msg);

    transaction.status_logs.push({
      old_status: transaction.payment_status,
      new_status: transaction.payment_status,
      note: 'Confirmation sent to customer via WhatsApp',
      changed_by: req.user.name || req.user._id.toString()
    });
    await transaction.save();

    await logNotification(transaction._id, 'whatsapp', transaction.phone, msg, eventType);

    res.json({ success: true, whatsapp_url: whatsappUrl, message: msg });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/utility/admin/export (CSV export)
router.get('/admin/export', protect, authorize('admin'), async (req, res) => {
  try {
    const { status, type, from, to } = req.query;
    const filter = {};
    if (status) filter.payment_status = status;
    if (type) filter.utility_type = type;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(from);
      if (to) filter.createdAt.$lte = new Date(to);
    }

    const transactions = await UtilityTransaction.find(filter).sort({ createdAt: -1 }).limit(5000);

    var csv = 'Reference,Type,Customer,Phone,Email,Zone,Account/Meter,Amount,Fee,Total,Method,Payment Status,Processing Status,Token,Created\n';
    for (var i = 0; i < transactions.length; i++) {
      var tx = transactions[i];
      csv += [
        tx.reference_id,
        tx.utility_type,
        '"' + (tx.customer_name || '').replace(/"/g, '""') + '"',
        tx.phone || '',
        tx.email || '',
        tx.zone || '',
        tx.meter_number || tx.account_number || '',
        tx.amount,
        tx.service_fee,
        tx.total_amount,
        tx.payment_method,
        tx.payment_status,
        tx.processing_status,
        tx.token || '',
        tx.createdAt ? tx.createdAt.toISOString() : ''
      ].join(',') + '\n';
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=utility-transactions-' + Date.now() + '.csv');
    res.send(csv);
  } catch (error) {
    console.error('Export error:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// GET /api/utility/admin/payment-logs/:transactionId
router.get('/admin/payment-logs/:transactionId', protect, authorize('admin'), async (req, res) => {
  try {
    const logs = await PaymentLog.find({ transaction_id: req.params.transactionId }).sort({ createdAt: -1 });
    res.json({ success: true, logs });
  } catch (error) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
