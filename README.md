# MyPlopPlop Backend API

Backend for MyPlopPlop delivery marketplace - Haiti's first delivery & rideshare platform.

## Tech Stack
- Node.js + Express
- MongoDB (Mongoose)
- Socket.io (real-time tracking)
- JWT authentication
- Multer (file uploads)

## Quick Start

```bash
npm install
cp .env.example .env   # Edit with your MongoDB URI
npm start              # Uses in-memory DB if no MongoDB URI
```

## API Endpoints

### Auth
- `POST /api/auth/register` - Register (name, phone, password, role)
- `POST /api/auth/login` - Login (phone, password) → returns JWT token
- `GET /api/auth/me` - Get current user (requires token)

### Drivers
- `POST /api/drivers/onboard` - Submit driver application (with document uploads)
- `GET /api/drivers/profile` - Get own profile
- `PUT /api/drivers/location` - Update GPS location
- `PUT /api/drivers/online` - Go online/offline
- `GET /api/drivers/nearby` - Find nearby available drivers
- `GET /api/drivers/stats` - Driver statistics

### Rides & Deliveries
- `POST /api/rides` - Create ride/delivery request
- `GET /api/rides` - List my rides
- `GET /api/rides/available` - Available rides for drivers
- `GET /api/rides/:id` - Ride details
- `PUT /api/rides/:id/accept` - Driver accepts ride
- `PUT /api/rides/:id/status` - Update status (picking_up → in_progress → delivered)
- `PUT /api/rides/:id/cancel` - Cancel ride
- `PUT /api/rides/:id/rate` - Rate ride (1-5 stars)

### Admin
- `GET /api/admin/dashboard` - Platform stats
- `GET /api/admin/drivers` - Driver applications
- `PUT /api/admin/drivers/:id/verify` - Approve/reject driver
- `GET /api/admin/rides` - All rides
- `GET /api/admin/users` - All users
- `GET /api/admin/transactions` - All transactions

### Health
- `GET /api/health` - API health check

## Payment Methods
MonCash, NatCash, CashPaw, Card, Wallet, Cash

## Commission
25% on all rides and deliveries

## Fare Calculation (HTG)
- Delivery: 100 base + 25/km (min 150)
- Ride: 75 base + 20/km (min 100)

## Socket.io Events
- `driver_online` - Driver connects
- `join_ride` - Customer tracks ride
- `driver_location` - Real-time GPS updates
- `new_ride` - New ride request broadcast
- `ride_accepted` / `ride_status` / `ride_cancelled` - Status updates

## Test Accounts (after seed)
```
Admin:    +50937000001 / admin123
Customer: +50937100001 / test123
Driver:   +50937200001 / test123
```
