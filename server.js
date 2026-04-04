require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const connectDB = require('./config/db');
const corsOptions = require('./config/cors');

// Route imports
const authRoutes = require('./routes/auth');
const driverRoutes = require('./routes/drivers');
const rideRoutes = require('./routes/rides');
const adminRoutes = require('./routes/admin');
const paymentRoutes = require('./routes/payments');
const referralRoutes = require('./routes/referrals');
const chatRoutes = require('./routes/chat');

const app = express();
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
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Static files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/drivers', driverRoutes);
app.use('/api/rides', rideRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/payments', paymentRoutes);
app.use('/api/referrals', referralRoutes);
app.use('/api/chat', chatRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'MyPlopPlop API', version: '1.0.0' });
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
}).catch((err) => {
  console.error('Failed to start:', err);
});

module.exports = { app, server, io };
