// Seed script - creates test data for MyPlopPlop
// Run: node scripts/seed.js

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const connectDB = require('../config/db');
const User = require('../models/User');
const DriverProfile = require('../models/DriverProfile');
const Ride = require('../models/Ride');
const Transaction = require('../models/Transaction');

const seed = async () => {
  await connectDB();

  // Clear existing data
  await User.deleteMany({});
  await DriverProfile.deleteMany({});
  await Ride.deleteMany({});
  await Transaction.deleteMany({});
  console.log('Cleared existing data');

  // Create admin
  const admin = await User.create({
    name: 'Admin PlopPlop',
    phone: '+50937000001',
    email: 'admin@myplopplop.com',
    password: 'admin123',
    role: 'admin',
    language: 'fr'
  });
  console.log('Admin created: +50937000001 / admin123');

  // Create test customers
  const customer1 = await User.create({
    name: 'Jean Pierre',
    phone: '+50937100001',
    email: 'jean@test.com',
    password: 'test123',
    role: 'customer',
    language: 'kr'
  });

  const customer2 = await User.create({
    name: 'Marie Claire',
    phone: '+50937100002',
    password: 'test123',
    role: 'customer',
    isDiaspora: true,
    country: 'US',
    language: 'en'
  });
  console.log('Customers created');

  // Create test drivers
  const driver1 = await User.create({
    name: 'Jacques Moto',
    phone: '+50937200001',
    password: 'test123',
    role: 'driver',
    language: 'kr'
  });

  const driver2 = await User.create({
    name: 'Paul Voiture',
    phone: '+50937200002',
    password: 'test123',
    role: 'driver',
    language: 'fr'
  });

  // Create driver profiles
  await DriverProfile.create({
    user: driver1._id,
    vehicleType: 'moto',
    vehiclePlate: 'AA-1234',
    vehicleModel: 'Honda CG 150',
    vehicleColor: 'Rouge',
    licenseNumber: 'DL-001-2026',
    services: ['delivery', 'ride'],
    status: 'approved',
    verifiedBy: admin._id,
    verifiedAt: new Date(),
    isOnline: true,
    currentLocation: {
      type: 'Point',
      coordinates: [-72.3388, 18.5425] // Delmas, Port-au-Prince
    },
    totalRides: 15,
    totalDeliveries: 42,
    totalEarnings: 28500,
    rating: 4.7
  });

  await DriverProfile.create({
    user: driver2._id,
    vehicleType: 'car',
    vehiclePlate: 'BB-5678',
    vehicleModel: 'Toyota Corolla',
    vehicleColor: 'Blanc',
    licenseNumber: 'DL-002-2026',
    services: ['ride'],
    status: 'approved',
    verifiedBy: admin._id,
    verifiedAt: new Date(),
    isOnline: true,
    currentLocation: {
      type: 'Point',
      coordinates: [-72.3460, 18.5392] // Petion-Ville area
    },
    totalRides: 30,
    totalDeliveries: 0,
    totalEarnings: 45000,
    rating: 4.9
  });
  console.log('Drivers created and approved');

  // Create a pending driver application
  const driver3 = await User.create({
    name: 'Max Nouveau',
    phone: '+50937200003',
    password: 'test123',
    role: 'driver',
    language: 'fr'
  });

  await DriverProfile.create({
    user: driver3._id,
    vehicleType: 'moto',
    vehiclePlate: 'CC-9012',
    vehicleModel: 'Suzuki GN 125',
    vehicleColor: 'Noir',
    licenseNumber: 'DL-003-2026',
    services: ['delivery'],
    status: 'pending'
  });
  console.log('Pending driver application created');

  // Create some test rides
  const ride1 = await Ride.create({
    type: 'delivery',
    customer: customer1._id,
    driver: driver1._id,
    pickup: {
      address: 'Supermarché Caribbean, Delmas 33',
      coordinates: { type: 'Point', coordinates: [-72.3200, 18.5450] }
    },
    dropoff: {
      address: 'Rue Faubert, Petion-Ville',
      coordinates: { type: 'Point', coordinates: [-72.2850, 18.5120] }
    },
    items: [
      { name: 'Riz 25kg', quantity: 1, price: 2500, store: 'Caribbean' },
      { name: 'Huile 5L', quantity: 2, price: 800, store: 'Caribbean' }
    ],
    distanceKm: 4.5,
    fare: { total: 213, commission: 53, driverEarning: 160 },
    paymentMethod: 'moncash',
    paymentStatus: 'paid',
    status: 'delivered',
    acceptedAt: new Date(Date.now() - 3600000),
    pickedUpAt: new Date(Date.now() - 3000000),
    deliveredAt: new Date(Date.now() - 1800000),
    driverRating: 5
  });

  const ride2 = await Ride.create({
    type: 'ride',
    customer: customer2._id,
    driver: driver2._id,
    recipient: { name: 'Tante Rose', phone: '+50937300001', address: 'Delmas 75' },
    pickup: {
      address: 'Aeroport International, Tabarre',
      coordinates: { type: 'Point', coordinates: [-72.2950, 18.5750] }
    },
    dropoff: {
      address: 'Hotel Montana, Petion-Ville',
      coordinates: { type: 'Point', coordinates: [-72.2800, 18.5100] }
    },
    distanceKm: 8.2,
    fare: { total: 239, commission: 60, driverEarning: 179 },
    paymentMethod: 'card',
    paymentStatus: 'paid',
    status: 'delivered',
    acceptedAt: new Date(Date.now() - 7200000),
    pickedUpAt: new Date(Date.now() - 6600000),
    deliveredAt: new Date(Date.now() - 5400000),
    driverRating: 5
  });

  // Create an active ride request
  await Ride.create({
    type: 'delivery',
    customer: customer1._id,
    pickup: {
      address: 'Pharmacie Nationale, Delmas 19',
      coordinates: { type: 'Point', coordinates: [-72.3300, 18.5500] }
    },
    dropoff: {
      address: 'Cite Soleil',
      coordinates: { type: 'Point', coordinates: [-72.3500, 18.5800] }
    },
    items: [{ name: 'Medicaments', quantity: 1, price: 1500, store: 'Pharmacie Nationale' }],
    distanceKm: 6.1,
    fare: { total: 253, commission: 63, driverEarning: 190 },
    paymentMethod: 'natcash',
    status: 'requested'
  });
  console.log('Test rides created');

  // Create transactions
  await Transaction.create([
    { user: customer1._id, ride: ride1._id, type: 'payment', amount: 213, method: 'moncash', status: 'completed', description: 'Delivery payment' },
    { user: driver1._id, ride: ride1._id, type: 'earning', amount: 160, status: 'completed', description: 'Delivery earning' },
    { user: driver1._id, ride: ride1._id, type: 'commission', amount: 53, status: 'completed', description: 'Commission (25%)' },
    { user: customer2._id, ride: ride2._id, type: 'payment', amount: 239, method: 'card', status: 'completed', description: 'Ride payment' },
    { user: driver2._id, ride: ride2._id, type: 'earning', amount: 179, status: 'completed', description: 'Ride earning' },
    { user: driver2._id, ride: ride2._id, type: 'commission', amount: 60, status: 'completed', description: 'Commission (25%)' }
  ]);
  console.log('Transactions created');

  console.log('\n=== SEED COMPLETE ===');
  console.log('Test accounts:');
  console.log('  Admin:    +50937000001 / admin123');
  console.log('  Customer: +50937100001 / test123 (Jean Pierre)');
  console.log('  Customer: +50937100002 / test123 (Marie - Diaspora US)');
  console.log('  Driver:   +50937200001 / test123 (Jacques - Moto, approved)');
  console.log('  Driver:   +50937200002 / test123 (Paul - Car, approved)');
  console.log('  Driver:   +50937200003 / test123 (Max - pending approval)');
  console.log('');
  console.log('1 active ride request waiting for a driver');
  console.log('2 completed rides with transactions');

  process.exit(0);
};

seed().catch(err => {
  console.error(err);
  process.exit(1);
});
