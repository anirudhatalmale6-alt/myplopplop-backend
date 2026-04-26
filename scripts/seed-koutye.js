// Seed script for Koutye Biznis test data
// Run: node scripts/seed-koutye.js
// NOTE: Run AFTER seed.js (needs existing users)

require('dotenv').config();
const mongoose = require('mongoose');
const connectDB = require('../config/db');
const User = require('../models/User');
const Koutye = require('../models/Koutye');
const KoutyeReferral = require('../models/KoutyeReferral');
const KoutyeCommission = require('../models/KoutyeCommission');
const KoutyePayout = require('../models/KoutyePayout');

const seed = async () => {
  await connectDB();

  await Koutye.deleteMany({});
  await KoutyeReferral.deleteMany({});
  await KoutyeCommission.deleteMany({});
  await KoutyePayout.deleteMany({});
  console.log('Cleared existing Koutye data');

  const admin = await User.findOne({ role: 'admin' });
  if (!admin) {
    console.log('No admin found - run seed.js first');
    process.exit(1);
  }

  // Create a test Koutye user
  let koutyeUser = await User.findOne({ phone: '+50937200001' });
  if (!koutyeUser) {
    koutyeUser = await User.create({
      name: 'Marc Antoine',
      phone: '+50937200001',
      email: 'marc@test.com',
      password: 'test123',
      role: 'customer',
      language: 'kr'
    });
  }
  console.log('Koutye user: +50937200001 / test123');

  // Create Koutye profile
  const koutye = await Koutye.create({
    user: koutyeUser._id,
    koutyeCode: 'KB-MAR7X',
    whatsapp: '+50937200001',
    bio: 'Koutye aktif nan Delmas',
    payoutMethod: 'moncash',
    payoutDetails: { phone: '+50937200001' },
    stats: {
      totalReferrals: 5,
      activeReferrals: 4,
      totalEarnings: 3250,
      pendingEarnings: 875,
      paidEarnings: 2375,
      totalPayouts: 3
    },
    tier: 'bronze'
  });
  console.log('Koutye created: KB-MAR7X');

  // Create some referrals across platforms
  const platforms = [
    { platform: '48hoursready', name: 'Salon Belle', type: 'business', rate: 0.10 },
    { platform: 'msouwout', name: 'Joseph Driver', type: 'driver', rate: 0.10 },
    { platform: 'myplopplop', name: 'Ti Machann', type: 'merchant', rate: 0.10 },
    { platform: 'utility', name: 'Marie Claire', type: 'customer', rate: 0.05 },
    { platform: 'prolakay', name: 'Jean Mecanicien', type: 'professional', rate: 0.10 }
  ];

  const referrals = [];
  for (const p of platforms) {
    const start = new Date();
    start.setMonth(start.getMonth() - Math.floor(Math.random() * 6));
    const expiry = new Date(start);
    expiry.setDate(expiry.getDate() + 365);

    const ref = await KoutyeReferral.create({
      koutye: koutye._id,
      koutyeCode: 'KB-MAR7X',
      platform: p.platform,
      referredEntity: { type: p.type, name: p.name, phone: '+5093700000' + referrals.length },
      commissionRate: p.rate,
      commissionType: 'percentage',
      startDate: start,
      expiryDate: expiry,
      totalCommissionEarned: Math.floor(Math.random() * 1000) + 100,
      commissionCount: Math.floor(Math.random() * 10) + 1,
      sourceDescription: `${p.platform} referral`
    });
    referrals.push(ref);
  }
  console.log(`Created ${referrals.length} referrals`);

  // Create some commissions
  for (const ref of referrals) {
    const count = Math.floor(Math.random() * 3) + 1;
    for (let i = 0; i < count; i++) {
      const sourceAmount = Math.floor(Math.random() * 5000) + 500;
      await KoutyeCommission.create({
        koutye: koutye._id,
        referral: ref._id,
        platform: ref.platform,
        sourceAmount,
        commissionRate: ref.commissionRate,
        amount: Math.round(sourceAmount * ref.commissionRate),
        status: ['pending', 'approved', 'paid'][Math.floor(Math.random() * 3)],
        description: `Commission from ${ref.platform} - ${ref.referredEntity.name}`
      });
    }
  }
  const commCount = await KoutyeCommission.countDocuments({ koutye: koutye._id });
  console.log(`Created ${commCount} commissions`);

  // Create a paid payout
  await KoutyePayout.create({
    koutye: koutye._id,
    amount: 1500,
    method: 'moncash',
    details: { phone: '+50937200001' },
    status: 'paid',
    processedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
    processedBy: admin._id,
    reference: 'MC-2026-001'
  });

  // Create a pending payout
  await KoutyePayout.create({
    koutye: koutye._id,
    amount: 875,
    method: 'moncash',
    details: { phone: '+50937200001' },
    status: 'pending'
  });
  console.log('Created 2 payouts (1 paid, 1 pending)');

  // Create a second Koutye
  let koutyeUser2 = await User.findOne({ phone: '+50937200002' });
  if (!koutyeUser2) {
    koutyeUser2 = await User.create({
      name: 'Sandra Louis',
      phone: '+50937200002',
      email: 'sandra@test.com',
      password: 'test123',
      role: 'customer',
      language: 'kr'
    });
  }

  await Koutye.create({
    user: koutyeUser2._id,
    koutyeCode: 'KB-SAN3K',
    whatsapp: '+50937200002',
    payoutMethod: 'natcash',
    payoutDetails: { phone: '+50937200002' },
    stats: { totalReferrals: 2, activeReferrals: 2, totalEarnings: 650 },
    tier: 'bronze'
  });
  console.log('Second Koutye created: KB-SAN3K');

  console.log('\n--- Koutye Seed Complete ---');
  console.log('Koutye 1: KB-MAR7X (Marc Antoine, +50937200001)');
  console.log('Koutye 2: KB-SAN3K (Sandra Louis, +50937200002)');
  console.log('Password: test123');
  console.log('Admin: use existing admin from seed.js');

  process.exit(0);
};

seed().catch(err => {
  console.error('Seed error:', err);
  process.exit(1);
});
