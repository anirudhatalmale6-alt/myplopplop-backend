const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const SolGroup = require('../models/SolGroup');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { protect, authorize } = require('../middleware/auth');

// ─── CREATE A SOL GROUP ───
router.post('/',
  protect,
  [
    body('name').trim().notEmpty().withMessage('Group name is required'),
    body('contributionAmount').isNumeric().custom(function(v) { return v >= 100; })
      .withMessage('Minimum contribution is 100 HTG'),
    body('maxMembers').isInt({ min: 3, max: 30 }).withMessage('3-30 members allowed'),
    body('frequency').isIn(['weekly', 'biweekly', 'monthly']).withMessage('Invalid frequency')
  ],
  async function(req, res) {
    try {
      var errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      var group = await SolGroup.create({
        name: req.body.name,
        description: req.body.description || '',
        creator: req.user._id,
        admins: [req.user._id],
        maxMembers: req.body.maxMembers,
        contributionAmount: req.body.contributionAmount,
        frequency: req.body.frequency,
        cycleFeePercent: req.body.cycleFeePercent || 2,
        trustLayerEnabled: req.body.trustLayerEnabled || false,
        trustFeePerMember: req.body.trustFeePerMember || 0,
        members: [{
          user: req.user._id,
          position: 1,
          status: 'active'
        }]
      });

      await group.populate('creator', 'name phone');

      res.status(201).json({
        success: true,
        data: group,
        inviteCode: group.inviteCode
      });
    } catch (err) {
      console.error('Create Sol group error:', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }
);

// ─── GET MY GROUPS ───
router.get('/my-groups', protect, async function(req, res) {
  try {
    var groups = await SolGroup.find({
      'members.user': req.user._id,
      'members.status': { $in: ['active', 'completed'] }
    })
      .populate('creator', 'name phone')
      .populate('members.user', 'name phone avatar')
      .sort('-updatedAt');

    res.json({ success: true, data: groups });
  } catch (err) {
    console.error('Get my groups error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET GROUP BY ID ───
router.get('/:id', protect, async function(req, res) {
  try {
    var group = await SolGroup.findById(req.params.id)
      .populate('creator', 'name phone avatar')
      .populate('members.user', 'name phone avatar')
      .populate('payoutOrder', 'name phone')
      .populate('contributions.member', 'name phone')
      .populate('payouts.recipient', 'name phone');

    if (!group) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }

    // Check if user is a member
    var isMember = group.members.some(function(m) {
      return m.user._id.toString() === req.user._id.toString();
    });
    var isAdmin = req.user.role === 'admin';

    if (!isMember && !isAdmin) {
      return res.status(403).json({ success: false, message: 'Not a member of this group' });
    }

    res.json({ success: true, data: group });
  } catch (err) {
    console.error('Get group error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── JOIN GROUP VIA INVITE CODE ───
router.post('/join/:inviteCode', protect, async function(req, res) {
  try {
    var group = await SolGroup.findOne({ inviteCode: req.params.inviteCode });

    if (!group) {
      return res.status(404).json({ success: false, message: 'Invalid invite code' });
    }

    if (group.status !== 'forming') {
      return res.status(400).json({ success: false, message: 'Group is no longer accepting members' });
    }

    // Check if already a member
    var alreadyMember = group.members.some(function(m) {
      return m.user.toString() === req.user._id.toString() && m.status === 'active';
    });
    if (alreadyMember) {
      return res.status(400).json({ success: false, message: 'Already a member' });
    }

    // Check if full
    var activeCount = group.members.filter(function(m) { return m.status === 'active'; }).length;
    if (activeCount >= group.maxMembers) {
      return res.status(400).json({ success: false, message: 'Group is full' });
    }

    group.members.push({
      user: req.user._id,
      position: activeCount + 1,
      status: 'active'
    });

    await group.save();
    await group.populate('members.user', 'name phone avatar');

    res.json({
      success: true,
      message: 'Joined group successfully',
      data: group
    });
  } catch (err) {
    console.error('Join group error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── START THE SOL CYCLE (admin/creator only) ───
router.put('/:id/start', protect, async function(req, res) {
  try {
    var group = await SolGroup.findById(req.params.id);

    if (!group) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }

    // Only creator or admin can start
    var isGroupAdmin = group.admins.some(function(a) {
      return a.toString() === req.user._id.toString();
    });
    if (!isGroupAdmin && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only group admin can start the cycle' });
    }

    if (group.status !== 'forming') {
      return res.status(400).json({ success: false, message: 'Group already started or completed' });
    }

    var activeMembers = group.members.filter(function(m) { return m.status === 'active'; });
    if (activeMembers.length < 3) {
      return res.status(400).json({ success: false, message: 'Need at least 3 members to start' });
    }

    // Set payout order (randomize or use join order)
    var payoutMode = req.body.payoutMode || 'join_order'; // 'random' or 'join_order'
    var memberIds = activeMembers.map(function(m) { return m.user; });

    if (payoutMode === 'random') {
      // Shuffle array
      for (var i = memberIds.length - 1; i > 0; i--) {
        var j = Math.floor(Math.random() * (i + 1));
        var temp = memberIds[i];
        memberIds[i] = memberIds[j];
        memberIds[j] = temp;
      }
    }

    group.payoutOrder = memberIds;
    group.totalCycles = activeMembers.length;
    group.currentCycle = 1;
    group.status = 'active';
    group.cycleStartDate = new Date();

    // Calculate next payment date based on frequency
    var nextDate = new Date();
    if (group.frequency === 'weekly') {
      nextDate.setDate(nextDate.getDate() + 7);
    } else if (group.frequency === 'biweekly') {
      nextDate.setDate(nextDate.getDate() + 14);
    } else {
      nextDate.setMonth(nextDate.getMonth() + 1);
    }
    group.nextPaymentDate = nextDate;
    group.nextPayoutDate = nextDate;

    // Update member positions based on payout order
    memberIds.forEach(function(userId, index) {
      var member = group.members.find(function(m) {
        return m.user.toString() === userId.toString();
      });
      if (member) member.position = index + 1;
    });

    await group.save();
    await group.populate('payoutOrder', 'name phone');

    res.json({
      success: true,
      message: 'Sol cycle started!',
      data: {
        group: group.name,
        totalCycles: group.totalCycles,
        currentCycle: group.currentCycle,
        contributionAmount: group.contributionAmount,
        frequency: group.frequency,
        nextPaymentDate: group.nextPaymentDate,
        payoutOrder: group.payoutOrder,
        firstRecipient: group.payoutOrder[0]
      }
    });
  } catch (err) {
    console.error('Start cycle error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── MAKE A CONTRIBUTION ───
router.post('/:id/contribute',
  protect,
  [
    body('method').isIn(['moncash', 'natcash', 'wallet', 'cash']).withMessage('Invalid payment method')
  ],
  async function(req, res) {
    try {
      var errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ success: false, errors: errors.array() });
      }

      var group = await SolGroup.findById(req.params.id);

      if (!group) {
        return res.status(404).json({ success: false, message: 'Group not found' });
      }

      if (group.status !== 'active') {
        return res.status(400).json({ success: false, message: 'Group is not active' });
      }

      // Check membership
      var member = group.members.find(function(m) {
        return m.user.toString() === req.user._id.toString() && m.status === 'active';
      });
      if (!member) {
        return res.status(403).json({ success: false, message: 'Not an active member' });
      }

      // Check if already paid this cycle
      if (group.hasMemberPaid(req.user._id, group.currentCycle)) {
        return res.status(400).json({ success: false, message: 'Already contributed this cycle' });
      }

      var amount = group.contributionAmount;
      var cycleFee = Math.round(amount * group.cycleFeePercent / 100);
      var totalCharge = amount + cycleFee;

      // Process payment based on method
      if (req.body.method === 'wallet') {
        var user = await User.findById(req.user._id);
        if (user.wallet.balance < totalCharge) {
          return res.status(400).json({
            success: false,
            message: 'Insufficient wallet balance. Need ' + totalCharge + ' HTG'
          });
        }
        user.wallet.balance -= totalCharge;
        await user.save();
      }
      // For moncash/natcash/cash - payment verified externally or by admin

      // Record contribution
      group.contributions.push({
        member: req.user._id,
        cycle: group.currentCycle,
        amount: amount,
        method: req.body.method,
        transactionRef: req.body.transactionRef || null,
        status: req.body.method === 'wallet' ? 'confirmed' : 'pending'
      });

      member.totalContributed += amount;
      group.totalCollected += amount;

      // Record transaction
      await Transaction.create({
        user: req.user._id,
        type: 'payment',
        amount: totalCharge,
        currency: 'HTG',
        method: req.body.method,
        status: req.body.method === 'wallet' ? 'completed' : 'pending',
        reference: 'SOL-' + group._id + '-C' + group.currentCycle,
        description: 'Sol contribution: ' + group.name + ' - Cycle ' + group.currentCycle
      });

      // Check if all members have paid this cycle
      var cycleContributions = group.getCycleContributions(group.currentCycle);
      var activeMembers = group.members.filter(function(m) { return m.status === 'active'; });
      var allPaid = cycleContributions.length >= activeMembers.length;

      await group.save();

      res.json({
        success: true,
        message: 'Contribution recorded',
        data: {
          amount: amount,
          cycleFee: cycleFee,
          totalCharged: totalCharge,
          cycle: group.currentCycle,
          method: req.body.method,
          allMembersPaid: allPaid,
          paidCount: cycleContributions.length + (req.body.method === 'wallet' ? 1 : 0),
          totalMembers: activeMembers.length
        }
      });
    } catch (err) {
      console.error('Contribute error:', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }
);

// ─── TRIGGER PAYOUT (admin/creator) ───
router.post('/:id/payout', protect, async function(req, res) {
  try {
    var group = await SolGroup.findById(req.params.id)
      .populate('payoutOrder', 'name phone');

    if (!group) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }

    var isGroupAdmin = group.admins.some(function(a) {
      return a.toString() === req.user._id.toString();
    });
    if (!isGroupAdmin && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only group admin can trigger payouts' });
    }

    if (group.status !== 'active') {
      return res.status(400).json({ success: false, message: 'Group is not active' });
    }

    // Check all contributions are in for this cycle
    var cycleContributions = group.getCycleContributions(group.currentCycle);
    var activeMembers = group.members.filter(function(m) { return m.status === 'active'; });

    if (cycleContributions.length < activeMembers.length) {
      return res.status(400).json({
        success: false,
        message: 'Not all members have paid. ' + cycleContributions.length + '/' + activeMembers.length + ' paid.',
        unpaid: activeMembers.filter(function(m) {
          return !group.hasMemberPaid(m.user, group.currentCycle);
        }).map(function(m) { return m.user; })
      });
    }

    // Get recipient for this cycle
    var recipientId = group.payoutOrder[group.currentCycle - 1];
    if (!recipientId) {
      return res.status(400).json({ success: false, message: 'No recipient for this cycle' });
    }

    var totalPot = group.contributionAmount * activeMembers.length;
    var withdrawalFee = Math.round(totalPot * group.withdrawalFeePercent / 100);
    var trustFee = group.trustLayerEnabled ? (group.trustFeePerMember * activeMembers.length) : 0;
    var netPayout = totalPot - withdrawalFee - trustFee;

    // Credit recipient wallet
    var recipient = await User.findById(recipientId);
    if (recipient) {
      recipient.wallet.balance += netPayout;
      await recipient.save();
    }

    // Update member record
    var recipientMember = group.members.find(function(m) {
      return m.user.toString() === recipientId.toString();
    });
    if (recipientMember) {
      recipientMember.totalReceived += netPayout;
    }

    // Record payout
    var payoutMethod = req.body.method || 'wallet';
    group.payouts.push({
      recipient: recipientId,
      cycle: group.currentCycle,
      amount: totalPot,
      platformFee: withdrawalFee + trustFee,
      netAmount: netPayout,
      method: payoutMethod,
      status: 'completed'
    });

    group.totalDistributed += netPayout;

    // Record transaction
    await Transaction.create({
      user: recipientId,
      type: 'earning',
      amount: netPayout,
      currency: 'HTG',
      method: payoutMethod,
      status: 'completed',
      reference: 'SOL-' + group._id + '-P' + group.currentCycle,
      description: 'Sol payout: ' + group.name + ' - Cycle ' + group.currentCycle
    });

    // Record platform fee transaction
    if (withdrawalFee > 0) {
      await Transaction.create({
        user: recipientId,
        type: 'commission',
        amount: withdrawalFee,
        currency: 'HTG',
        method: 'wallet',
        status: 'completed',
        reference: 'SOL-FEE-' + group._id + '-C' + group.currentCycle,
        description: 'Sol platform fee: ' + group.name
      });
    }

    // Advance to next cycle or complete
    if (group.currentCycle >= group.totalCycles) {
      group.status = 'completed';
      // Mark all members as completed
      group.members.forEach(function(m) {
        if (m.status === 'active') m.status = 'completed';
      });
    } else {
      group.currentCycle += 1;
      // Calculate next dates
      var nextDate = new Date();
      if (group.frequency === 'weekly') {
        nextDate.setDate(nextDate.getDate() + 7);
      } else if (group.frequency === 'biweekly') {
        nextDate.setDate(nextDate.getDate() + 14);
      } else {
        nextDate.setMonth(nextDate.getMonth() + 1);
      }
      group.nextPaymentDate = nextDate;
      group.nextPayoutDate = nextDate;
    }

    await group.save();

    res.json({
      success: true,
      message: 'Payout completed!',
      data: {
        recipient: recipient ? { name: recipient.name, phone: recipient.phone } : recipientId,
        cycle: group.currentCycle - (group.status === 'completed' ? 0 : 1),
        totalPot: totalPot,
        withdrawalFee: withdrawalFee,
        trustFee: trustFee,
        netPayout: netPayout,
        groupStatus: group.status,
        nextCycle: group.status === 'completed' ? null : group.currentCycle,
        nextPaymentDate: group.nextPaymentDate
      }
    });
  } catch (err) {
    console.error('Payout error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET CYCLE STATUS ───
router.get('/:id/cycle', protect, async function(req, res) {
  try {
    var group = await SolGroup.findById(req.params.id)
      .populate('members.user', 'name phone avatar')
      .populate('payoutOrder', 'name phone');

    if (!group) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }

    var activeMembers = group.members.filter(function(m) { return m.status === 'active'; });
    var cycleContributions = group.getCycleContributions(group.currentCycle);
    var currentRecipient = group.currentCycle > 0 ? group.payoutOrder[group.currentCycle - 1] : null;

    var memberStatuses = activeMembers.map(function(m) {
      var paid = group.hasMemberPaid(m.user._id, group.currentCycle);
      return {
        user: m.user,
        position: m.position,
        hasPaid: paid,
        totalContributed: m.totalContributed,
        totalReceived: m.totalReceived,
        isCurrentRecipient: currentRecipient && m.user._id.toString() === currentRecipient.toString()
      };
    });

    res.json({
      success: true,
      data: {
        groupName: group.name,
        status: group.status,
        currentCycle: group.currentCycle,
        totalCycles: group.totalCycles,
        contributionAmount: group.contributionAmount,
        frequency: group.frequency,
        nextPaymentDate: group.nextPaymentDate,
        nextPayoutDate: group.nextPayoutDate,
        currentRecipient: currentRecipient,
        paidCount: cycleContributions.length,
        totalMembers: activeMembers.length,
        allPaid: cycleContributions.length >= activeMembers.length,
        members: memberStatuses,
        totalCollected: group.totalCollected,
        totalDistributed: group.totalDistributed
      }
    });
  } catch (err) {
    console.error('Get cycle status error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── REMOVE MEMBER (admin only) ───
router.delete('/:id/members/:userId', protect, async function(req, res) {
  try {
    var group = await SolGroup.findById(req.params.id);
    if (!group) {
      return res.status(404).json({ success: false, message: 'Group not found' });
    }

    var isGroupAdmin = group.admins.some(function(a) {
      return a.toString() === req.user._id.toString();
    });
    if (!isGroupAdmin && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only group admin can remove members' });
    }

    var member = group.members.find(function(m) {
      return m.user.toString() === req.params.userId;
    });
    if (!member) {
      return res.status(404).json({ success: false, message: 'Member not found' });
    }

    member.status = 'removed';
    await group.save();

    res.json({ success: true, message: 'Member removed' });
  } catch (err) {
    console.error('Remove member error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── LOOKUP GROUP BY INVITE CODE (public) ───
router.get('/invite/:code', async function(req, res) {
  try {
    var group = await SolGroup.findOne({ inviteCode: req.params.code })
      .populate('creator', 'name')
      .select('name description maxMembers contributionAmount frequency currency status members creator');

    if (!group) {
      return res.status(404).json({ success: false, message: 'Invalid invite code' });
    }

    var activeCount = group.members.filter(function(m) { return m.status === 'active'; }).length;

    res.json({
      success: true,
      data: {
        name: group.name,
        description: group.description,
        creator: group.creator.name,
        contributionAmount: group.contributionAmount,
        currency: group.currency,
        frequency: group.frequency,
        maxMembers: group.maxMembers,
        currentMembers: activeCount,
        spotsLeft: group.maxMembers - activeCount,
        status: group.status,
        canJoin: group.status === 'forming' && activeCount < group.maxMembers
      }
    });
  } catch (err) {
    console.error('Invite lookup error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── ADMIN: ALL SOL GROUPS ───
router.get('/admin/all', protect, authorize('admin'), async function(req, res) {
  try {
    var page = parseInt(req.query.page) || 1;
    var limit = parseInt(req.query.limit) || 20;
    var statusFilter = req.query.status;

    var query = {};
    if (statusFilter) query.status = statusFilter;

    var total = await SolGroup.countDocuments(query);
    var groups = await SolGroup.find(query)
      .populate('creator', 'name phone')
      .select('name status maxMembers contributionAmount frequency currentCycle totalCollected totalDistributed createdAt members')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(limit);

    var data = groups.map(function(g) {
      return {
        _id: g._id,
        name: g.name,
        status: g.status,
        creator: g.creator,
        maxMembers: g.maxMembers,
        activeMembers: g.members.filter(function(m) { return m.status === 'active'; }).length,
        contributionAmount: g.contributionAmount,
        frequency: g.frequency,
        currentCycle: g.currentCycle,
        totalCollected: g.totalCollected,
        totalDistributed: g.totalDistributed,
        createdAt: g.createdAt
      };
    });

    res.json({
      success: true,
      data: data,
      pagination: { page: page, limit: limit, total: total, pages: Math.ceil(total / limit) }
    });
  } catch (err) {
    console.error('Admin Sol groups error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

module.exports = router;
