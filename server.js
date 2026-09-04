require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const START_TIME = new Date().toISOString();

const connectDB = require('./config/db');
const corsOptions = require('./config/cors');

// Route imports
const authRoutes = require('./routes/auth');
const driverRoutes = require('./routes/drivers');
const rideRoutes = require('./routes/rides');
const adminRoutes = require('./routes/admin');
const adminPinRoutes = require('./routes/admin-pin');
const paymentRoutes = require('./routes/payments');
const referralRoutes = require('./routes/referrals');
const chatRoutes = require('./routes/chat');
const notificationRoutes = require('./routes/notifications');
const solRoutes = require('./routes/sol');
const orderRoutes = require('./routes/orders');
const storeRoutes = require('./routes/stores');
const payoutRoutes = require('./routes/payouts');
const featuredRoutes = require('./routes/featured');
const koutyeRoutes = require('./routes/koutye');
const koutyePaymentRoutes = require('./routes/koutye-payments');
const utilityRoutes = require('./routes/utility');
const inventoryRoutes = require('./routes/inventory');
const dispatchRoutes = require('./routes/dispatch');
const internationalRoutes = require('./routes/international');
const logisticsRoutes = require('./routes/logistics');
const biznisiqRoutes = require('./routes/biznisiq');
const categoryRoutes = require('./routes/categories');
const supplierRoutes = require('./routes/supplier');
const marketplaceRoutes = require('./routes/marketplace');
const odooRoutes = require('./routes/odoo');
const assistantRoutes = require('./routes/assistant');

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

// Socket.io setup
const io = new Server(server, {
  cors: corsOptions
});
app.set('io', io);

// Security - relaxed CSP for test panel
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000
});
app.use('/api/', limiter);

// Body parsing
app.use(cors(corsOptions));
// 10mb: store/product logos and photos are sent as base64 data URLs.
// The express default (100kb) silently 413'd every real phone photo.
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false, limit: '10mb' }));

// Static files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/drivers', driverRoutes);
app.use('/api/rides', rideRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/admin-pin', adminPinRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/referrals', referralRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/sol', solRoutes);
app.use('/api/orders', orderRoutes);
app.use('/api/stores', storeRoutes);
app.use('/api/payouts', payoutRoutes);
app.use('/api/featured', featuredRoutes);
app.use('/api/koutye', koutyeRoutes);
app.use('/api/koutye-payments', koutyePaymentRoutes);
app.use('/api/utility', utilityRoutes);
app.use('/api/inventory', inventoryRoutes);
app.use('/api/dispatch', dispatchRoutes);
app.use('/api/international', internationalRoutes);
app.use('/api/logistics', logisticsRoutes);
app.use('/api/biznisiq', biznisiqRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/supplier', supplierRoutes);
app.use('/api/marketplace', marketplaceRoutes);
app.use('/api/odoo', odooRoutes);
app.use('/api/assistant', assistantRoutes);

// Health check
app.get('/api/health', (req, res) => {
  // Which commit is actually serving. Without this there is no way to tell a
  // deployed fix from a fix that is still sitting in the repository.
  res.json({
    status: 'ok',
    service: 'MyPlopPlop API',
    version: '1.0.0',
    commit: (process.env.RENDER_GIT_COMMIT || 'local').substring(0, 7),
    startedAt: START_TIME
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ success: false, message: 'Route not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error(err.stack);
  if (err.name === 'MulterError') {
    return res.status(400).json({ success: false, message: err.message });
  }
  res.status(500).json({ success: false, message: 'Server error' });
});

// Socket.io real-time events
io.on('connection', (socket) => {
  console.log(`Client connected: ${socket.id}`);

  // Driver joins their room
  socket.on('driver_online', (data) => {
    socket.join('drivers');
    socket.driverId = data.driverId;
    console.log(`Driver ${data.driverId} online`);
  });

  // Customer joins ride room for tracking
  socket.on('join_ride', (data) => {
    socket.join(`ride_${data.rideId}`);
    console.log(`Joined ride room: ride_${data.rideId}`);
  });

  // Merchant joins store room for order notifications
  socket.on('join_store', (data) => {
    socket.join(`store_${data.storeId}`);
    console.log(`Merchant joined store room: store_${data.storeId}`);
  });

  // Customer joins order room for tracking
  socket.on('join_order', (data) => {
    socket.join(`order_${data.orderId}`);
    console.log(`Joined order room: order_${data.orderId}`);
  });

  // Driver sends location update during ride
  socket.on('driver_location', (data) => {
    io.to(`ride_${data.rideId}`).emit('location_update', {
      rideId: data.rideId,
      latitude: data.latitude,
      longitude: data.longitude
    });
  });

  // Chat: send message via socket (alternative to REST)
  socket.on('chat_message', (data) => {
    io.to(`ride_${data.rideId}`).emit('new_message', {
      sender: { _id: data.senderId, name: data.senderName },
      senderRole: data.senderRole,
      message: data.message,
      type: 'text',
      createdAt: new Date()
    });
  });

  // Chat: typing indicator
  socket.on('typing', (data) => {
    socket.to(`ride_${data.rideId}`).emit('user_typing', {
      name: data.name,
      role: data.role
    });
  });

  // Driver goes offline
  socket.on('driver_offline', () => {
    socket.leave('drivers');
    console.log(`Driver offline: ${socket.driverId}`);
  });

  socket.on('disconnect', () => {
    console.log(`Client disconnected: ${socket.id}`);
  });
});

// Connect DB and start server
const PORT = process.env.PORT || 5000;

connectDB().then(() => {
  server.listen(PORT, () => {
    console.log(`MyPlopPlop API running on port ${PORT}`);
    console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  });

  // Automatic delivery dispatch ticker: re-offer timed-out delivery offers to the
  // next closest driver every 10s (30s accept window). No human dispatching.
  try {
    const deliveryDispatch = require('./services/deliveryDispatch');
    setInterval(() => {
      deliveryDispatch.dispatchTick(io).catch((e) => console.error('dispatchTick error:', e.message));
    }, 10000);
    console.log('Delivery dispatch engine started (10s tick)');
  } catch (e) {
    console.error('Failed to start dispatch engine:', e.message);
  }

  // Odoo catalogue sync: merchants running Odoo (MSC Xpress) change prices
  // constantly, so we re-pull whatever moved on their side. Each connection
  // carries its own interval; this ticker just checks who is due.
  try {
    const odooSync = require('./services/odoo/odooSync');
    setInterval(() => {
      odooSync.tick().catch((e) => console.error('Odoo sync tick error:', e.message));
    }, 60 * 1000);
    console.log('Odoo catalogue sync started (60s tick)');
  } catch (e) {
    console.error('Failed to start Odoo sync:', e.message);
  }
}).catch((err) => {
  console.error('Failed to start:', err);
});

module.exports = { app, server, io };
