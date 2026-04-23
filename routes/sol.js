const express = require('express');
const router = express.Router();
const { body, param, validationResult } = require('express-validator');
const SolGroup = require('../models/SolGroup');
const SolCycle = require('../models/SolCycle');
const SolAuditLog = require('../models/SolAuditLog');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { protect, authorize } = require('../middleware/auth');

function logAudit(data) {
  return SolAuditLog.create(data).catch(function(err) {
    console.error('Audit log error:', err.message);
  });
}

function getNextDate(frequency, fromDate) {
  var d = new Date(fromDate || Date.now());
  if (frequency === 'daily') d.setDate(d.getDate() + 1);
  else if (frequency === 'weekly') d.setDate(d.getDate() + 7);
  else if (frequency === 'biweekly') d.setDate(d.getDate() + 14);
  else d.setMonth(d.getMonth() + 1);
  return d;
}

// ─── CREATE A SOL GROUP ───
router.post('/',
  protect,
  [
    body('name').trim().notEmpty().withMessage('Group name is required'),
    body('contributionAmount').isNumeric().custom(function(v) { return v >= 100; })
      .withMessage('Minimum contribution is 100 HTG'),
    body('maxMembers').isInt({ min: 3, max: 30 }).withMessage('3-30 members allowed'),
    body('frequency').isIn(['daily', 'weekly', 'biweekly', 'monthly']).withMessage('Invalid frequency')
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
        groupType: req.body.groupType || 'private',
        visibility: req.body.groupType === 'public' ? 'public' : 'private',
        creator: req.user._id,
        admins: [req.user._id],
        maxMembers: req.body.maxMembers,
        contributionAmount: req.body.contributionAmount,
        frequency: req.body.frequency,
        cycleFeePercent: req.body.cycleFeePercent || 2,
        gracePeriodDays: req.body.gracePeriodDays || 2,
        lateFeeEnabled: req.body.lateFeeEnabled || false,
        lateFeeAmount: req.body.lateFeeAmount || 0,
        trustLayerEnabled: req.body.trustLayerEnabled || false,
        trustFeePerMember: req.body.trustFeePerMember || 0,
        members: [{
          user: req.user._id,
          position: 1,
          joinType: 'admin_add',
          status: 'active',
          approvedAt: new Date()
        }]
      });

      await group.populate('creator', 'name phone');

      logAudit({
        entityType: 'group',
        entityId: group._id,
        group: group._id,
        user: req.user._id,
        actionType: 'group_created',
        afterState: { name: group.name, groupType: group.groupType, contributionAmount: group.contributionAmount }
      });

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

// ─── UPDATE GROUP SETTINGS (admin only) ───
router.patch('/:id',
  protect,
  async function(req, res) {
    try {
      var group = await SolGroup.findById(req.params.id);
      if (!group) return res.status(404).json({ success: false, message: 'Group not found' });

      var isGroupAdmin = group.admins.some(function(a) {
        return a.toString() === req.user._id.toString();
      });
      if (!isGroupAdmin && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Only group admin can update settings' });
      }

      if (group.status === 'active' || group.status === 'completed') {
        return res.status(400).json({ success: false, message: 'Cannot edit an active or completed group' });
      }

      var allowed = ['name', 'description', 'groupType', 'visibility', 'maxMembers',
        'contributionAmount', 'frequency', 'gracePeriodDays', 'lateFeeEnabled', 'lateFeeAmount'];
      var beforeState = {};
      var afterState = {};

      allowed.forEach(function(field) {
        if (req.body[field] !== undefined) {
          beforeState[field] = group[field];
          group[field] = req.body[field];
          afterState[field] = req.body[field];
        }
      });

      await group.save();

      logAudit({
        entityType: 'group',
        entityId: group._id,
        group: group._id,
        user: req.user._id,
        actionType: 'group_updated',
        beforeState: beforeState,
        afterState: afterState
      });

      res.json({ success: true, data: group });
    } catch (err) {
      console.error('Update group error:', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }
);

// ─── PUBLISH GROUP (make it open for joining) ───
router.post('/:id/publish', protect, async function(req, res) {
  try {
    var group = await SolGroup.findById(req.params.id);
    if (!group) return res.status(404).json({ success: false, message: 'Group not found' });

    var isGroupAdmin = group.admins.some(function(a) {
      return a.toString() === req.user._id.toString();
    });
    if (!isGroupAdmin) return res.status(403).json({ success: false, message: 'Only group admin' });

    if (group.status !== 'forming' && group.status !== 'draft') {
      return res.status(400).json({ success: false, message: 'Group cannot be published in current state' });
    }

    group.status = 'open';
    await group.save();

    logAudit({
      entityType: 'group',
      entityId: group._id,
      group: group._id,
      user: req.user._id,
      actionType: 'group_published',
      afterState: { status: 'open' }
    });

    res.json({ success: true, message: 'Group is now open for members', data: group });
  } catch (err) {
    console.error('Publish group error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── PAUSE GROUP ───
router.post('/:id/pause', protect, async function(req, res) {
  try {
    var group = await SolGroup.findById(req.params.id);
    if (!group) return res.status(404).json({ success: false, message: 'Group not found' });

    var isGroupAdmin = group.admins.some(function(a) {
      return a.toString() === req.user._id.toString();
    });
    if (!isGroupAdmin && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only group admin' });
    }

    var beforeStatus = group.status;
    group.status = 'paused';
    await group.save();

    logAudit({
      entityType: 'group',
      entityId: group._id,
      group: group._id,
      user: req.user._id,
      actionType: 'group_paused',
      beforeState: { status: beforeStatus },
      afterState: { status: 'paused' }
    });

    res.json({ success: true, message: 'Group paused' });
  } catch (err) {
    console.error('Pause group error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── CLOSE GROUP ───
router.post('/:id/close', protect, async function(req, res) {
  try {
    var group = await SolGroup.findById(req.params.id);
    if (!group) return res.status(404).json({ success: false, message: 'Group not found' });

    var isGroupAdmin = group.admins.some(function(a) {
      return a.toString() === req.user._id.toString();
    });
    if (!isGroupAdmin && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only group admin' });
    }

    group.status = 'cancelled';
    group.members.forEach(function(m) {
      if (m.status === 'active' || m.status === 'approved') m.status = 'removed';
    });
    await group.save();

    logAudit({
      entityType: 'group',
      entityId: group._id,
      group: group._id,
      user: req.user._id,
      actionType: 'group_closed'
    });

    res.json({ success: true, message: 'Group closed' });
  } catch (err) {
    console.error('Close group error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── DISCOVER PUBLIC GROUPS ───
router.get('/', async function(req, res) {
  try {
    var page = parseInt(req.query.page) || 1;
    var limit = parseInt(req.query.limit) || 20;
    var query = { visibility: 'public', status: { $in: ['open', 'forming'] } };

    if (req.query.groupType) query.groupType = req.query.groupType;

    var total = await SolGroup.countDocuments(query);
    var groups = await SolGroup.find(query)
      .populate('creator', 'name')
      .select('name description groupType contributionAmount frequency currency maxMembers members status inviteCode createdAt')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(limit);

    var data = groups.map(function(g) {
      var activeCount = g.members.filter(function(m) {
        return m.status === 'active' || m.status === 'approved';
      }).length;
      return {
        _id: g._id,
        name: g.name,
        description: g.description,
        groupType: g.groupType,
        creator: g.creator,
        contributionAmount: g.contributionAmount,
        frequency: g.frequency,
        currency: g.currency,
        maxMembers: g.maxMembers,
        currentMembers: activeCount,
        spotsLeft: g.maxMembers - activeCount,
        status: g.status,
        inviteCode: g.inviteCode,
        createdAt: g.createdAt
      };
    });

    res.json({ success: true, data: data, pagination: { page: page, limit: limit, total: total, pages: Math.ceil(total / limit) } });
  } catch (err) {
    console.error('Discover groups error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET MY GROUPS ───
router.get('/my-groups', protect, async function(req, res) {
  try {
    var groups = await SolGroup.find({
      'members.user': req.user._id,
      'members.status': { $in: ['active', 'approved', 'pending', 'completed'] }
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

// ─── GET GROUP MEMBERS ───
router.get('/:id/members', protect, async function(req, res) {
  try {
    var group = await SolGroup.findById(req.params.id)
      .populate('members.user', 'name phone avatar');

    if (!group) return res.status(404).json({ success: false, message: 'Group not found' });

    var members = group.members.map(function(m) {
      return {
        _id: m._id,
        user: m.user,
        position: m.position,
        joinType: m.joinType,
        status: m.status,
        joinedAt: m.joinedAt,
        totalContributed: m.totalContributed,
        totalReceived: m.totalReceived,
        missedPayments: m.missedPayments
      };
    });

    res.json({ success: true, data: members });
  } catch (err) {
    console.error('Get members error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── JOIN GROUP (public apply) ───
router.post('/:id/join', protect, async function(req, res) {
  try {
    var group = await SolGroup.findById(req.params.id);
    if (!group) return res.status(404).json({ success: false, message: 'Group not found' });

    if (group.status !== 'forming' && group.status !== 'open') {
      return res.status(400).json({ success: false, message: 'Group is not accepting members' });
    }

    var alreadyMember = group.members.some(function(m) {
      return m.user.toString() === req.user._id.toString() &&
        (m.status === 'active' || m.status === 'approved' || m.status === 'pending');
    });
    if (alreadyMember) {
      return res.status(400).json({ success: false, message: 'Already a member or pending approval' });
    }

    var activeCount = group.members.filter(function(m) {
      return m.status === 'active' || m.status === 'approved';
    }).length;
    if (activeCount >= group.maxMembers) {
      return res.status(400).json({ success: false, message: 'Group is full' });
    }

    var autoApprove = group.groupType === 'public';

    group.members.push({
      user: req.user._id,
      position: activeCount + 1,
      joinType: 'public_apply',
      status: autoApprove ? 'active' : 'pending',
      approvedAt: autoApprove ? new Date() : undefined
    });

    if (autoApprove && activeCount + 1 >= group.maxMembers) {
      group.status = 'full';
    }

    await group.save();

    logAudit({
      entityType: 'membership',
      entityId: group._id,
      group: group._id,
      user: req.user._id,
      actionType: autoApprove ? 'member_joined' : 'member_applied',
      afterState: { status: autoApprove ? 'active' : 'pending' }
    });

    res.json({
      success: true,
      message: autoApprove ? 'Joined group successfully' : 'Application submitted, waiting for admin approval'
    });
  } catch (err) {
    console.error('Join group error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── JOIN VIA INVITE CODE ───
router.post('/join/:inviteCode', protect, async function(req, res) {
  try {
    var group = await SolGroup.findOne({ inviteCode: req.params.inviteCode });
    if (!group) return res.status(404).json({ success: false, message: 'Invalid invite code' });

    if (group.status !== 'forming' && group.status !== 'open') {
      return res.status(400).json({ success: false, message: 'Group is no longer accepting members' });
    }

    var alreadyMember = group.members.some(function(m) {
      return m.user.toString() === req.user._id.toString() &&
        (m.status === 'active' || m.status === 'approved' || m.status === 'pending');
    });
    if (alreadyMember) {
      return res.status(400).json({ success: false, message: 'Already a member' });
    }

    var activeCount = group.members.filter(function(m) {
      return m.status === 'active' || m.status === 'approved';
    }).length;
    if (activeCount >= group.maxMembers) {
      return res.status(400).json({ success: false, message: 'Group is full' });
    }

    group.members.push({
      user: req.user._id,
      position: activeCount + 1,
      joinType: 'invite',
      status: 'active',
      approvedAt: new Date()
    });

    if (activeCount + 1 >= group.maxMembers) {
      group.status = 'full';
    }

    await group.save();
    await group.populate('members.user', 'name phone avatar');

    logAudit({
      entityType: 'membership',
      entityId: group._id,
      group: group._id,
      user: req.user._id,
      actionType: 'member_joined_invite',
      afterState: { inviteCode: req.params.inviteCode }
    });

    res.json({ success: true, message: 'Joined group successfully', data: group });
  } catch (err) {
    console.error('Join group error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── INVITE MEMBER (group admin sends invite) ───
router.post('/:id/invite', protect, async function(req, res) {
  try {
    var group = await SolGroup.findById(req.params.id);
    if (!group) return res.status(404).json({ success: false, message: 'Group not found' });

    var isGroupAdmin = group.admins.some(function(a) {
      return a.toString() === req.user._id.toString();
    });
    if (!isGroupAdmin) return res.status(403).json({ success: false, message: 'Only group admin can invite' });

    res.json({
      success: true,
      inviteCode: group.inviteCode,
      inviteLink: '/sol/join/' + group.inviteCode,
      message: 'Share this invite code with the person you want to add'
    });
  } catch (err) {
    console.error('Invite error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── APPROVE/REJECT MEMBER (group admin) ───
router.patch('/:id/members/:memberId',
  protect,
  async function(req, res) {
    try {
      var group = await SolGroup.findById(req.params.id);
      if (!group) return res.status(404).json({ success: false, message: 'Group not found' });

      var isGroupAdmin = group.admins.some(function(a) {
        return a.toString() === req.user._id.toString();
      });
      if (!isGroupAdmin && req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Only group admin' });
      }

      var member = group.members.id(req.params.memberId);
      if (!member) return res.status(404).json({ success: false, message: 'Member not found' });

      var action = req.body.action;
      var beforeStatus = member.status;

      if (action === 'approve') {
        if (member.status !== 'pending') {
          return res.status(400).json({ success: false, message: 'Member is not pending approval' });
        }
        member.status = 'active';
        member.approvedBy = req.user._id;
        member.approvedAt = new Date();
      } else if (action === 'reject' || action === 'remove') {
        member.status = 'removed';
      } else if (action === 'suspend') {
        member.status = 'suspended';
      } else {
        return res.status(400).json({ success: false, message: 'Invalid action. Use: approve, reject, remove, suspend' });
      }

      await group.save();

      logAudit({
        entityType: 'membership',
        entityId: group._id,
        group: group._id,
        user: req.user._id,
        actionType: 'member_' + action,
        beforeState: { status: beforeStatus },
        afterState: { status: member.status },
        metadata: { targetUser: member.user }
      });

      res.json({ success: true, message: 'Member ' + action + 'd', data: member });
    } catch (err) {
      console.error('Update member error:', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }
);

// ─── START THE SOL CYCLE (admin/creator only) ───
router.put('/:id/start', protect, async function(req, res) {
  try {
    var group = await SolGroup.findById(req.params.id);
    if (!group) return res.status(404).json({ success: false, message: 'Group not found' });

    var isGroupAdmin = group.admins.some(function(a) {
      return a.toString() === req.user._id.toString();
    });
    if (!isGroupAdmin && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only group admin can start the cycle' });
    }

    if (group.status !== 'forming' && group.status !== 'open' && group.status !== 'full') {
      return res.status(400).json({ success: false, message: 'Group already started or completed' });
    }

    var activeMembers = group.members.filter(function(m) {
      return m.status === 'active';
    });
    if (activeMembers.length < 3) {
      return res.status(400).json({ success: false, message: 'Need at least 3 active members to start' });
    }

    var payoutMode = req.body.payoutMode || 'join_order';
    var memberIds = activeMembers.map(function(m) { return m.user; });

    if (payoutMode === 'random') {
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
    group.startDate = new Date();
    group.cycleStartDate = new Date();

    var nextDate = getNextDate(group.frequency);
    group.nextPaymentDate = nextDate;
    group.nextPayoutDate = nextDate;

    var endDate = new Date();
    for (var c = 0; c < activeMembers.length; c++) {
      endDate = getNextDate(group.frequency, endDate);
    }
    group.endDate = endDate;

    memberIds.forEach(function(userId, index) {
      var member = group.members.find(function(m) {
        return m.user.toString() === userId.toString();
      });
      if (member) member.position = index + 1;
    });

    await group.save();

    // Create cycle records
    for (var cn = 1; cn <= group.totalCycles; cn++) {
      var cycleStart = new Date(group.startDate);
      for (var k = 0; k < cn - 1; k++) {
        cycleStart = getNextDate(group.frequency, cycleStart);
      }
      var cycleDue = getNextDate(group.frequency, cycleStart);

      await SolCycle.create({
        group: group._id,
        cycleNumber: cn,
        startDate: cycleStart,
        dueDate: cycleDue,
        expectedTotal: group.contributionAmount * activeMembers.length,
        memberCount: activeMembers.length,
        payoutRecipient: memberIds[cn - 1],
        status: cn === 1 ? 'open' : 'upcoming'
      });
    }

    await group.populate('payoutOrder', 'name phone');

    logAudit({
      entityType: 'group',
      entityId: group._id,
      group: group._id,
      user: req.user._id,
      actionType: 'cycle_started',
      afterState: {
        totalCycles: group.totalCycles,
        payoutMode: payoutMode,
        frequency: group.frequency
      }
    });

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
      if (!group) return res.status(404).json({ success: false, message: 'Group not found' });

      if (group.status !== 'active') {
        return res.status(400).json({ success: false, message: 'Group is not active' });
      }

      var member = group.members.find(function(m) {
        return m.user.toString() === req.user._id.toString() && m.status === 'active';
      });
      if (!member) return res.status(403).json({ success: false, message: 'Not an active member' });

      if (group.hasMemberPaid(req.user._id, group.currentCycle)) {
        return res.status(400).json({ success: false, message: 'Already contributed this cycle' });
      }

      var amount = group.contributionAmount;
      var cycleFee = Math.round(amount * group.cycleFeePercent / 100);
      var totalCharge = amount + cycleFee;

      // Check for late fee
      var lateFee = 0;
      if (group.lateFeeEnabled && group.nextPaymentDate) {
        var graceEnd = new Date(group.nextPaymentDate);
        graceEnd.setDate(graceEnd.getDate() + group.gracePeriodDays);
        if (new Date() > graceEnd) {
          lateFee = group.lateFeeAmount;
          totalCharge += lateFee;
        }
      }

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

      var paymentStatus = req.body.method === 'wallet' ? 'confirmed' : 'pending';

      group.contributions.push({
        member: req.user._id,
        cycle: group.currentCycle,
        amount: amount,
        method: req.body.method,
        transactionRef: req.body.transactionRef || null,
        status: paymentStatus
      });

      if (paymentStatus === 'confirmed') {
        member.totalContributed += amount;
        group.totalCollected += amount;

        // Update cycle record
        await SolCycle.findOneAndUpdate(
          { group: group._id, cycleNumber: group.currentCycle },
          { $inc: { collectedTotal: amount }, status: 'collection_in_progress' }
        );
      }

      await Transaction.create({
        user: req.user._id,
        type: 'payment',
        amount: totalCharge,
        currency: 'HTG',
        method: req.body.method,
        status: paymentStatus === 'confirmed' ? 'completed' : 'pending',
        reference: 'SOL-' + group._id + '-C' + group.currentCycle,
        description: 'Sol contribution: ' + group.name + ' - Cycle ' + group.currentCycle
      });

      var cycleContributions = group.getCycleContributions(group.currentCycle);
      var activeMembers = group.members.filter(function(m) { return m.status === 'active'; });
      var paidCount = cycleContributions.length + (paymentStatus === 'confirmed' ? 1 : 0);
      var allPaid = paidCount >= activeMembers.length;

      if (allPaid) {
        await SolCycle.findOneAndUpdate(
          { group: group._id, cycleNumber: group.currentCycle },
          { status: 'ready_for_payout' }
        );
      }

      await group.save();

      logAudit({
        entityType: 'contribution',
        entityId: group._id,
        group: group._id,
        user: req.user._id,
        actionType: 'contribution_made',
        amount: amount,
        afterState: { cycle: group.currentCycle, method: req.body.method, status: paymentStatus, lateFee: lateFee }
      });

      res.json({
        success: true,
        message: 'Contribution recorded',
        data: {
          amount: amount,
          cycleFee: cycleFee,
          lateFee: lateFee,
          totalCharged: totalCharge,
          cycle: group.currentCycle,
          method: req.body.method,
          status: paymentStatus,
          allMembersPaid: allPaid,
          paidCount: paidCount,
          totalMembers: activeMembers.length
        }
      });
    } catch (err) {
      console.error('Contribute error:', err);
      res.status(500).json({ success: false, message: 'Server error' });
    }
  }
);

// ─── VERIFY CONTRIBUTION (admin confirms external payment) ───
router.patch('/contributions/:contributionId/verify', protect, async function(req, res) {
  try {
    var group = await SolGroup.findOne({ 'contributions._id': req.params.contributionId });
    if (!group) return res.status(404).json({ success: false, message: 'Contribution not found' });

    var isGroupAdmin = group.admins.some(function(a) {
      return a.toString() === req.user._id.toString();
    });
    if (!isGroupAdmin && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admin can verify contributions' });
    }

    var contribution = group.contributions.id(req.params.contributionId);
    if (!contribution) return res.status(404).json({ success: false, message: 'Contribution not found' });

    if (contribution.status === 'confirmed') {
      return res.status(400).json({ success: false, message: 'Already confirmed' });
    }

    contribution.status = 'confirmed';

    var member = group.members.find(function(m) {
      return m.user.toString() === contribution.member.toString();
    });
    if (member) {
      member.totalContributed += contribution.amount;
    }
    group.totalCollected += contribution.amount;

    await SolCycle.findOneAndUpdate(
      { group: group._id, cycleNumber: contribution.cycle },
      { $inc: { collectedTotal: contribution.amount } }
    );

    await group.save();

    logAudit({
      entityType: 'contribution',
      entityId: contribution._id,
      group: group._id,
      user: req.user._id,
      actionType: 'contribution_verified',
      amount: contribution.amount,
      metadata: { member: contribution.member, cycle: contribution.cycle }
    });

    res.json({ success: true, message: 'Contribution verified' });
  } catch (err) {
    console.error('Verify contribution error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET GROUP CONTRIBUTIONS ───
router.get('/:id/contributions', protect, async function(req, res) {
  try {
    var group = await SolGroup.findById(req.params.id)
      .populate('contributions.member', 'name phone');

    if (!group) return res.status(404).json({ success: false, message: 'Group not found' });

    var cycle = req.query.cycle ? parseInt(req.query.cycle) : null;
    var contributions = group.contributions;
    if (cycle) {
      contributions = contributions.filter(function(c) { return c.cycle === cycle; });
    }

    res.json({ success: true, data: contributions });
  } catch (err) {
    console.error('Get contributions error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET USER CONTRIBUTIONS (across all groups) ───
router.get('/users/:userId/contributions', protect, async function(req, res) {
  try {
    var userId = req.params.userId === 'me' ? req.user._id : req.params.userId;
    var groups = await SolGroup.find({ 'contributions.member': userId })
      .select('name contributions');

    var allContributions = [];
    groups.forEach(function(g) {
      g.contributions.forEach(function(c) {
        if (c.member.toString() === userId.toString()) {
          allContributions.push({
            groupId: g._id,
            groupName: g.name,
            cycle: c.cycle,
            amount: c.amount,
            method: c.method,
            status: c.status,
            paidAt: c.paidAt
          });
        }
      });
    });

    res.json({ success: true, data: allContributions });
  } catch (err) {
    console.error('Get user contributions error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET PAYOUTS ───
router.get('/:id/payouts', protect, async function(req, res) {
  try {
    var group = await SolGroup.findById(req.params.id)
      .populate('payouts.recipient', 'name phone');

    if (!group) return res.status(404).json({ success: false, message: 'Group not found' });

    res.json({ success: true, data: group.payouts });
  } catch (err) {
    console.error('Get payouts error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GENERATE PAYOUT FOR CYCLE ───
router.post('/:id/payouts/generate', protect, async function(req, res) {
  try {
    var group = await SolGroup.findById(req.params.id)
      .populate('payoutOrder', 'name phone');

    if (!group) return res.status(404).json({ success: false, message: 'Group not found' });

    var isGroupAdmin = group.admins.some(function(a) {
      return a.toString() === req.user._id.toString();
    });
    if (!isGroupAdmin && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only group admin' });
    }

    if (group.status !== 'active') {
      return res.status(400).json({ success: false, message: 'Group is not active' });
    }

    var existingPayout = group.payouts.find(function(p) {
      return p.cycle === group.currentCycle;
    });
    if (existingPayout) {
      return res.status(400).json({ success: false, message: 'Payout already generated for this cycle' });
    }

    var activeMembers = group.members.filter(function(m) { return m.status === 'active'; });
    var recipientId = group.payoutOrder[group.currentCycle - 1];
    if (!recipientId) {
      return res.status(400).json({ success: false, message: 'No recipient for this cycle' });
    }

    var totalPot = group.contributionAmount * activeMembers.length;
    var withdrawalFee = Math.round(totalPot * group.withdrawalFeePercent / 100);
    var trustFee = group.trustLayerEnabled ? (group.trustFeePerMember * activeMembers.length) : 0;
    var netPayout = totalPot - withdrawalFee - trustFee;

    group.payouts.push({
      recipient: recipientId,
      cycle: group.currentCycle,
      amount: totalPot,
      platformFee: withdrawalFee + trustFee,
      netAmount: netPayout,
      status: 'scheduled'
    });

    await group.save();

    logAudit({
      entityType: 'payout',
      entityId: group._id,
      group: group._id,
      user: req.user._id,
      actionType: 'payout_generated',
      amount: netPayout,
      afterState: { cycle: group.currentCycle, recipient: recipientId, status: 'scheduled' }
    });

    res.json({
      success: true,
      message: 'Payout generated and scheduled',
      data: {
        cycle: group.currentCycle,
        recipient: recipientId,
        totalPot: totalPot,
        platformFee: withdrawalFee + trustFee,
        netPayout: netPayout,
        status: 'scheduled'
      }
    });
  } catch (err) {
    console.error('Generate payout error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── APPROVE PAYOUT ───
router.post('/payouts/:payoutId/approve', protect, async function(req, res) {
  try {
    var group = await SolGroup.findOne({ 'payouts._id': req.params.payoutId });
    if (!group) return res.status(404).json({ success: false, message: 'Payout not found' });

    var isGroupAdmin = group.admins.some(function(a) {
      return a.toString() === req.user._id.toString();
    });
    if (!isGroupAdmin && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admin can approve payouts' });
    }

    var payout = group.payouts.id(req.params.payoutId);
    if (!payout) return res.status(404).json({ success: false, message: 'Payout not found' });

    if (payout.status !== 'scheduled' && payout.status !== 'ready') {
      return res.status(400).json({ success: false, message: 'Payout cannot be approved in current state' });
    }

    var cycleContributions = group.getCycleContributions(payout.cycle);
    var activeMembers = group.members.filter(function(m) { return m.status === 'active'; });
    if (cycleContributions.length < activeMembers.length) {
      return res.status(400).json({
        success: false,
        message: 'Not all members have paid. ' + cycleContributions.length + '/' + activeMembers.length + ' paid.'
      });
    }

    payout.status = 'pending';
    payout.approvedBy = req.user._id;
    payout.approvedAt = new Date();

    await group.save();

    logAudit({
      entityType: 'payout',
      entityId: payout._id,
      group: group._id,
      user: req.user._id,
      actionType: 'payout_approved',
      amount: payout.netAmount,
      afterState: { status: 'pending' }
    });

    res.json({ success: true, message: 'Payout approved, ready to send' });
  } catch (err) {
    console.error('Approve payout error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── SEND PAYOUT (execute the transfer) ───
router.post('/payouts/:payoutId/send', protect, async function(req, res) {
  try {
    var group = await SolGroup.findOne({ 'payouts._id': req.params.payoutId });
    if (!group) return res.status(404).json({ success: false, message: 'Payout not found' });

    var isGroupAdmin = group.admins.some(function(a) {
      return a.toString() === req.user._id.toString();
    });
    if (!isGroupAdmin && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admin' });
    }

    var payout = group.payouts.id(req.params.payoutId);
    if (!payout) return res.status(404).json({ success: false, message: 'Payout not found' });

    if (payout.status !== 'pending') {
      return res.status(400).json({ success: false, message: 'Payout must be approved first' });
    }

    // Credit recipient wallet
    var recipient = await User.findById(payout.recipient);
    if (recipient) {
      recipient.wallet.balance += payout.netAmount;
      await recipient.save();
    }

    var recipientMember = group.members.find(function(m) {
      return m.user.toString() === payout.recipient.toString();
    });
    if (recipientMember) {
      recipientMember.totalReceived += payout.netAmount;
    }

    payout.status = 'completed';
    payout.paidAt = new Date();
    payout.method = req.body.method || 'wallet';
    group.totalDistributed += payout.netAmount;

    await Transaction.create({
      user: payout.recipient,
      type: 'earning',
      amount: payout.netAmount,
      currency: 'HTG',
      method: payout.method,
      status: 'completed',
      reference: 'SOL-' + group._id + '-P' + payout.cycle,
      description: 'Sol payout: ' + group.name + ' - Cycle ' + payout.cycle
    });

    if (payout.platformFee > 0) {
      await Transaction.create({
        user: payout.recipient,
        type: 'commission',
        amount: payout.platformFee,
        currency: 'HTG',
        method: 'wallet',
        status: 'completed',
        reference: 'SOL-FEE-' + group._id + '-C' + payout.cycle,
        description: 'Sol platform fee: ' + group.name
      });
    }

    // Update cycle status
    await SolCycle.findOneAndUpdate(
      { group: group._id, cycleNumber: payout.cycle },
      { status: 'completed', payoutDate: new Date() }
    );

    // Advance cycle
    if (group.currentCycle >= group.totalCycles) {
      group.status = 'completed';
      group.members.forEach(function(m) {
        if (m.status === 'active') m.status = 'completed';
      });
    } else {
      group.currentCycle += 1;
      var nextDate = getNextDate(group.frequency);
      group.nextPaymentDate = nextDate;
      group.nextPayoutDate = nextDate;

      await SolCycle.findOneAndUpdate(
        { group: group._id, cycleNumber: group.currentCycle },
        { status: 'open' }
      );
    }

    await group.save();

    logAudit({
      entityType: 'payout',
      entityId: payout._id,
      group: group._id,
      user: req.user._id,
      actionType: 'payout_sent',
      amount: payout.netAmount,
      afterState: {
        recipient: payout.recipient,
        cycle: payout.cycle,
        groupStatus: group.status,
        nextCycle: group.currentCycle
      }
    });

    res.json({
      success: true,
      message: 'Payout sent!',
      data: {
        recipient: recipient ? { name: recipient.name, phone: recipient.phone } : payout.recipient,
        cycle: payout.cycle,
        netPayout: payout.netAmount,
        groupStatus: group.status,
        nextCycle: group.status === 'completed' ? null : group.currentCycle
      }
    });
  } catch (err) {
    console.error('Send payout error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── HOLD PAYOUT ───
router.post('/payouts/:payoutId/hold', protect, async function(req, res) {
  try {
    var group = await SolGroup.findOne({ 'payouts._id': req.params.payoutId });
    if (!group) return res.status(404).json({ success: false, message: 'Payout not found' });

    var isGroupAdmin = group.admins.some(function(a) {
      return a.toString() === req.user._id.toString();
    });
    if (!isGroupAdmin && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admin' });
    }

    var payout = group.payouts.id(req.params.payoutId);
    if (!payout) return res.status(404).json({ success: false, message: 'Payout not found' });

    payout.status = 'held';
    payout.holdReason = req.body.reason || 'Admin hold';
    await group.save();

    logAudit({
      entityType: 'payout',
      entityId: payout._id,
      group: group._id,
      user: req.user._id,
      actionType: 'payout_held',
      afterState: { reason: payout.holdReason }
    });

    res.json({ success: true, message: 'Payout held', reason: payout.holdReason });
  } catch (err) {
    console.error('Hold payout error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET CYCLE STATUS ───
router.get('/:id/cycle', protect, async function(req, res) {
  try {
    var group = await SolGroup.findById(req.params.id)
      .populate('members.user', 'name phone avatar')
      .populate('payoutOrder', 'name phone');

    if (!group) return res.status(404).json({ success: false, message: 'Group not found' });

    var activeMembers = group.members.filter(function(m) { return m.status === 'active'; });
    var cycleContributions = group.getCycleContributions(group.currentCycle);
    var currentRecipient = group.currentCycle > 0 ? group.payoutOrder[group.currentCycle - 1] : null;

    var cycle = await SolCycle.findOne({ group: group._id, cycleNumber: group.currentCycle });

    var memberStatuses = activeMembers.map(function(m) {
      var paid = group.hasMemberPaid(m.user._id, group.currentCycle);
      return {
        user: m.user,
        position: m.position,
        hasPaid: paid,
        totalContributed: m.totalContributed,
        totalReceived: m.totalReceived,
        missedPayments: m.missedPayments,
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
        gracePeriodDays: group.gracePeriodDays,
        nextPaymentDate: group.nextPaymentDate,
        nextPayoutDate: group.nextPayoutDate,
        currentRecipient: currentRecipient,
        paidCount: cycleContributions.length,
        totalMembers: activeMembers.length,
        allPaid: cycleContributions.length >= activeMembers.length,
        members: memberStatuses,
        cycle: cycle,
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
    if (!group) return res.status(404).json({ success: false, message: 'Group not found' });

    var isGroupAdmin = group.admins.some(function(a) {
      return a.toString() === req.user._id.toString();
    });
    if (!isGroupAdmin && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only group admin can remove members' });
    }

    var member = group.members.find(function(m) {
      return m.user.toString() === req.params.userId;
    });
    if (!member) return res.status(404).json({ success: false, message: 'Member not found' });

    member.status = 'removed';
    await group.save();

    logAudit({
      entityType: 'membership',
      entityId: group._id,
      group: group._id,
      user: req.user._id,
      actionType: 'member_removed',
      metadata: { removedUser: req.params.userId }
    });

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
      .select('name description groupType maxMembers contributionAmount frequency currency status members creator');

    if (!group) return res.status(404).json({ success: false, message: 'Invalid invite code' });

    var activeCount = group.members.filter(function(m) {
      return m.status === 'active' || m.status === 'approved';
    }).length;

    res.json({
      success: true,
      data: {
        name: group.name,
        description: group.description,
        groupType: group.groupType,
        creator: group.creator.name,
        contributionAmount: group.contributionAmount,
        currency: group.currency,
        frequency: group.frequency,
        maxMembers: group.maxMembers,
        currentMembers: activeCount,
        spotsLeft: group.maxMembers - activeCount,
        status: group.status,
        canJoin: (group.status === 'forming' || group.status === 'open') && activeCount < group.maxMembers
      }
    });
  } catch (err) {
    console.error('Invite lookup error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// ─── GET AUDIT LOG FOR GROUP ───
router.get('/:id/audit', protect, async function(req, res) {
  try {
    var group = await SolGroup.findById(req.params.id);
    if (!group) return res.status(404).json({ success: false, message: 'Group not found' });

    var isGroupAdmin = group.admins.some(function(a) {
      return a.toString() === req.user._id.toString();
    });
    if (!isGroupAdmin && req.user.role !== 'admin') {
      return res.status(403).json({ success: false, message: 'Only admin can view audit log' });
    }

    var page = parseInt(req.query.page) || 1;
    var limit = parseInt(req.query.limit) || 50;

    var logs = await SolAuditLog.find({ group: req.params.id })
      .populate('user', 'name phone')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(limit);

    var total = await SolAuditLog.countDocuments({ group: req.params.id });

    res.json({
      success: true,
      data: logs,
      pagination: { page: page, limit: limit, total: total, pages: Math.ceil(total / limit) }
    });
  } catch (err) {
    console.error('Get audit log error:', err);
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
      .select('name status groupType maxMembers contributionAmount frequency currentCycle totalCollected totalDistributed createdAt members')
      .sort('-createdAt')
      .skip((page - 1) * limit)
      .limit(limit);

    var data = groups.map(function(g) {
      return {
        _id: g._id,
        name: g.name,
        status: g.status,
        groupType: g.groupType,
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
