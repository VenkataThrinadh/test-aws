const mysql = require('mysql2/promise');
require('dotenv').config();

// Database configuration for MySQL
const dbConfig = {
  // Use 127.0.0.1 by default to avoid IPv6 (::1) vs IPv4 binding issues on some Windows setups
  host: process.env.DB_HOST || '127.0.0.1',
  user: process.env.DB_USER || 'cewealthzen_mobile_application',
  database: process.env.DB_NAME || 'cewealthzen_real_estate_db',
  password: process.env.DB_PASSWORD || 'Thrinadh@1999',
  port: parseInt(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit: process.env.NODE_ENV === 'production' ? 10 : 15,
  queueLimit: 0,
  // Add charset configuration
  charset: 'utf8mb4',
  // Add SSL configuration if required by shared hosting
  ssl: process.env.DB_SSL === 'true' ? {
    rejectUnauthorized: false
  } : false,
  // Add timezone configuration
  timezone: '+00:00'
};

const pool = mysql.createPool(dbConfig);

// Test database connection
async function testConnection() {
  try {
    const connection = await pool.getConnection();
    await connection.query('SELECT 1 as test');
    connection.release();
    
    // Log success in both environments
    console.log('✅ Database connected successfully');
    return true;
  } catch (err) {
    console.error('❌ Database connection failed:', err.message);
    console.error('Database config:', {
      host: dbConfig.host,
      user: dbConfig.user,
      database: dbConfig.database,
      port: dbConfig.port
    });
    
    // Don't exit in any environment - let the app continue
    // This allows the server to start even if database is temporarily unavailable
    console.warn('⚠️  Server will continue without database connection');
    console.warn('   Some features may not work properly');
    return false;
  }
}

// Add connection pool error handling
pool.on('connection', function (connection) {
  // Only log connection details in development
  if (process.env.NODE_ENV === 'development') {
    console.log('Database connection established as id ' + connection.threadId);
  }
});

pool.on('error', function(err) {
  console.error('Database pool error:', err);
  if(err.code === 'PROTOCOL_CONNECTION_LOST') {
    console.warn('Database connection was closed.');
  }
  if(err.code === 'ER_CON_COUNT_ERROR') {
    console.warn('Database has too many connections.');
  }
  if(err.code === 'ECONNREFUSED') {
    console.warn('Database connection was refused.');
  }
});

testConnection();

module.exports = { pool };