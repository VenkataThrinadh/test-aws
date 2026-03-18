const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cron = require('node-cron');
const autoLogoutEmployees = require('./scripts/autoLogoutJob');
const cors = require('cors');
const bodyParser = require('body-parser');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcrypt');
// Database connection handled by db.js
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: [
      'http://localhost:3000',
      'http://localhost:3001',
      'http://localhost:3002',
      'http://localhost:3003',
      'https://cewealthzen.com',
      'https://sales.cewealthzen.com',
      'https://loans.cewealthzen.com',
      'https://channelpartner.cewealthzen.com'
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true
  }
});
app.set('io', io);

io.on('connection', (socket) => {
  socket.on('joinDepartmentDesignation', ({ department, designation }) => {
    if (department && designation) {
      socket.join(`${department}_${designation}`);
    }
  });
});
// If the app is behind a reverse proxy (nginx, load balancer) enable trust proxy
// so middleware like express-rate-limit can correctly detect client IPs from X-Forwarded-For.
// Configure trust proxy safely. When behind a known reverse proxy, set TRUST_PROXY
// to a specific value (e.g. 'loopback' or a CIDR/IP list). Avoid enabling a
// permissive `true` in production unless you understand the security implications.
const trustProxy = process.env.TRUST_PROXY || 'loopback';
app.set('trust proxy', trustProxy);

// Create a router for backend routes
const backendRouter = express.Router();
const PORT = process.env.PORT || 3000;

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Create subdirectories for organized file storage
const subDirs = ['properties', 'plans', 'avatars', 'cities', 'banners', 'documents'];
subDirs.forEach(dir => {
  const subDir = path.join(uploadsDir, dir);
  if (!fs.existsSync(subDir)) {
    fs.mkdirSync(subDir, { recursive: true });
  }
});

// Middleware for main app
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    'http://localhost:3003',
    'https://cewealthzen.com',
    'https://sales.cewealthzen.com',
    'https://loans.cewealthzen.com',
    'https://channelpartner.cewealthzen.com'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// Serve static files from public directory
app.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// Middleware for backend router
backendRouter.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://localhost:3002',
    'http://localhost:3003',
    'https://cewealthzen.com',
    'https://sales.cewealthzen.com',
    'https://loans.cewealthzen.com',
    'https://channelpartner.cewealthzen.com'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

backendRouter.use(bodyParser.json({ limit: '50mb' }));
backendRouter.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// Serve static files from public directory for backend routes
backendRouter.use('/uploads', express.static(path.join(__dirname, 'public/uploads')));

// Backend API health check endpoint
backendRouter.get('/api/health', async (req, res) => {
  try {
    let databaseStatus = 'disconnected';
    let databaseError = null;
    
    // Test database connection
    try {
      const { pool } = require('./db');
      const connection = await pool.getConnection();
      await connection.query('SELECT 1 as test');
      connection.release();
      databaseStatus = 'connected';
    } catch (dbError) {
      databaseError = dbError.message;
    }
    
    res.status(200).json({ 
      status: 'ok', 
      message: 'Backend API is healthy',
      database: databaseStatus,
      databaseError: databaseError,
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'production',
      routes: {
        auth: '/backend/api/auth/login',
        notifications: '/backend/api/notifications/unread-count',
        health: '/backend/api/health'
      }
    });
  } catch (error) {
    res.status(200).json({ 
      status: 'partial', 
      message: 'Backend API is running but has issues',
      error: error.message,
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV || 'production'
    });
  }
});


// Import and use route files for backend router
backendRouter.use('/api/auth', require('./routes/auth'));
backendRouter.use('/api/properties', require('./routes/properties'));
backendRouter.use('/api/users', require('./routes/users'));
backendRouter.use('/api/customers', require('./routes/customers'));
// Email status and test endpoints
backendRouter.use('/api/email-status', require('./routes/email-status'));
backendRouter.use('/api/staff', require('./routes/staff'));
backendRouter.use('/api/holidays', require('./routes/holidays'));
backendRouter.use('/api/teams', require('./routes/teams'));
backendRouter.use('/api/staff-documents', require('./routes/staff-documents'));
backendRouter.use('/api/documents', require('./routes/documents'));
backendRouter.use('/api/favorites', require('./routes/favorites'));
backendRouter.use('/api/enquiries', require('./routes/enquiries'));
backendRouter.use('/api/leads', require('./routes/leads'));
backendRouter.use('/api/uploads', require('./routes/uploads'));
backendRouter.use('/api/cities', require('./routes/cities'));
backendRouter.use('/api/banners', require('./routes/banners'));
backendRouter.use('/api/amenities', require('./routes/amenities'));
backendRouter.use('/api/specifications', require('./routes/specifications'));
backendRouter.use('/api/plans', require('./routes/plans'));
backendRouter.use('/api/plots', require('./routes/plots'));
backendRouter.use('/api/land-plots', require('./routes/landPlots'));
backendRouter.use('/api/property-blocks', require('./routes/propertyBlockConfig'));
backendRouter.use('/api/property-block-config', require('./routes/propertyBlockConfig'));
backendRouter.use('/api/admin', require('./routes/admin'));
backendRouter.use('/api/notifications', require('./routes/notifications'));
backendRouter.use('/api/reports', require('./routes/reports'));
backendRouter.use('/api/settings', require('./routes/settings'));

// === LOAN MANAGEMENT ROUTES (Phase 2) ===
// Import rate limiter for loan endpoints
const loansRateLimiter = require('./middleware/loansRateLimiter');

// Mount all loan routes with rate limiting middleware
backendRouter.use('/api/loans/borrowers', loansRateLimiter, require('./routes/loans-borrowers'));
backendRouter.use('/api/loans/customers', loansRateLimiter, require('./routes/loans-customers'));
backendRouter.use('/api/loans/customer-documents', loansRateLimiter, require('./routes/loans-customer-documents'));
backendRouter.use('/api/loans/loans', loansRateLimiter, require('./routes/loans-loans'));
backendRouter.use('/api/loans/payments', loansRateLimiter, require('./routes/loans-payments'));
backendRouter.use('/api/loans/receipts', loansRateLimiter, require('./routes/loans-receipts'));
backendRouter.use('/api/loans/transactions', loansRateLimiter, require('./routes/loans-transactions'));
backendRouter.use('/api/loans/loan-plans', loansRateLimiter, require('./routes/loans-loan-plans'));
backendRouter.use('/api/loans/loan-types', loansRateLimiter, require('./routes/loans-loan-types'));
backendRouter.use('/api/loans/dashboard', loansRateLimiter, require('./routes/loans-dashboard'));
backendRouter.use('/api/loans/reports', loansRateLimiter, require('./routes/loans-reports'));
backendRouter.use('/api/loans/settings', loansRateLimiter, require('./routes/loans-settings'));
backendRouter.use('/api/loans/reference-numbers', loansRateLimiter, require('./routes/loans-reference-numbers'));
backendRouter.use('/api/loans/upload', loansRateLimiter, require('./routes/loans-upload'));

// Test email connection function
async function testEmailConnection() {
  try {
    const nodemailer = require('nodemailer');
    const transporter = nodemailer.createTransporter({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
      }
    });
    
    await transporter.verify();
    return true;
  } catch (error) {
    console.error('Email connection test failed:', error);
    return false;
  }
}

// Verify email page route
backendRouter.get('/verify-email', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/verify-email.html'));
});

// Email service health check endpoints
backendRouter.get('/api/email-health', async (req, res) => {
  try {
    const emailStatus = await testEmailConnection();
    res.status(200).json({ 
      status: emailStatus ? 'ok' : 'error', 
      message: emailStatus ? 'Email service is working' : 'Email service connection failed',
      emailConfigured: !!(process.env.EMAIL_USER && process.env.EMAIL_PASSWORD)
    });
  } catch (error) {
    res.status(500).json({ 
      status: 'error', 
      message: 'Email service health check failed',
      error: error.message 
    });
  }
});

// Health check endpoints (for /backend subdirectory)
backendRouter.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', message: 'Server is running' });
});

// Additional health check endpoint for mobile app
backendRouter.get('/mobile-health', (req, res) => {
  res.status(200).json({ 
    status: 'ok', 
    message: 'Server is running and accessible from mobile app',
    timestamp: new Date().toISOString()
  });
});

// Simple diagnostic endpoint
backendRouter.get('/diagnostic', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Node.js server is running',
    timestamp: new Date().toISOString(),
    path: req.path,
    method: req.method,
    baseUrl: req.baseUrl,
    originalUrl: req.originalUrl,
    environment: process.env.NODE_ENV,
    cors: {
      origin: req.headers.origin,
      allowedOrigins: [
        'http://localhost:3000',
        'http://localhost:3001',
        'https://cewealthzen.com',
        'https://cewealthzen.com'
      ]
    }
  });
});

// Test auth endpoint without authentication
backendRouter.get('/api/test-auth', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Auth endpoint is accessible',
    timestamp: new Date().toISOString(),
    path: req.path,
    method: req.method,
    note: 'This is a test endpoint to verify routing is working'
  });
});

// Test notifications endpoint without authentication
backendRouter.get('/api/test-notifications', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Notifications endpoint is accessible',
    timestamp: new Date().toISOString(),
    path: req.path,
    method: req.method,
    note: 'This is a test endpoint to verify routing is working'
  });
});

// Database connectivity test endpoint
backendRouter.get('/api/test-db', async (req, res) => {
  try {
    const { pool } = require('./db');
    const connection = await pool.getConnection();
    await connection.query('SELECT 1 as test');
    connection.release();
    
    res.status(200).json({ 
      status: 'ok', 
      message: 'Database connection successful',
      timestamp: new Date().toISOString(),
      environment: process.env.NODE_ENV,
      database: process.env.DB_NAME
    });
  } catch (error) {
    console.error('Database test failed:', error);
    res.status(500).json({ 
      status: 'error', 
      message: 'Database connection failed',
      error: process.env.NODE_ENV === 'development' ? error.message : 'Database connectivity issue',
      timestamp: new Date().toISOString()
    });
  }
});

// Deployment status endpoint
backendRouter.get('/api/deployment-status', (req, res) => {
  res.status(200).json({
    status: 'ok',
    message: 'Backend deployed successfully',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV,
    nodeVersion: process.version,
    deployment: {
      path: '/backend subdirectory deployment',
      apiBaseUrl: 'https://cewealthzen.com/backend/api',
      staticFiles: 'https://cewealthzen.com/backend/uploads'
    }
  });
});

// Add root page route to backend router
backendRouter.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Mount the backend router under /backend path
app.use('/backend', backendRouter);

// Root page (served from main app, not backend)
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Catch-all handler for React Router (SPA routing)
// This should handle all routes that don't match backend routes
app.get('*', (req, res, next) => {
  // Skip if this is a backend API route
  if (req.path.startsWith('/backend')) {
    return next();
  }
  
  // Skip if this is a static file request
  if (req.path.includes('.')) {
    return next();
  }
  
  // For all other routes, serve the React app
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? (err && err.stack ? err.stack : err.message) : 'Something went wrong'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Not found',
    message: `Route ${req.method} ${req.path} not found`,
    availableRoutes: {
      root: '/',
      test: '/test',
      backend: '/backend/*',
      api: '/backend/api/*'
    }
  });
});

// Schedule auto-logout job to run every hour
cron.schedule('0 * * * *', () => {
  autoLogoutEmployees();
});

// Start server
server.listen(PORT, () => {
  if (process.env.NODE_ENV === 'development') {
    console.log(`🚀 Real Estate Backend Server running on port ${PORT}`);
    console.log(`📱 Mobile API: http://localhost:${PORT}/backend/api`);
    console.log(`🌐 Health Check: http://localhost:${PORT}/backend/api/health`);
    console.log(`🧪 Test Page: http://localhost:${PORT}/test`);
    console.log(`📊 Environment: ${process.env.NODE_ENV}`);
  } else {
    // In production, show minimal startup message
    console.log(`Server started on port ${PORT} - ${process.env.NODE_ENV || 'production'} mode`);
  }
});

module.exports = app;