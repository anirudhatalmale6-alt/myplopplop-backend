const corsOptions = {
  origin: function(origin, callback) {
    const allowed = [
      'https://myplopplop.com',
      'https://www.myplopplop.com',
      'http://localhost:3000',
      'http://localhost:5500',
      'http://127.0.0.1:5500'
    ];
    // Allow requests with no origin (mobile apps, curl) or from allowed origins
    // Also allow trycloudflare.com tunnels during development
    if (!origin || allowed.includes(origin) || origin.endsWith('.trycloudflare.com')) {
      callback(null, true);
    } else {
      callback(null, true); // Allow all for now during development
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
};

module.exports = corsOptions;
