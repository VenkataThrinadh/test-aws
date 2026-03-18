#!/usr/bin/env node

/**
 * Enhanced Server Startup Script
 * Handles initialization, error checking, and graceful startup
 */

const fs = require('fs');
const path = require('path');

console.log('🚀 Starting Real Estate Backend Server...');
console.log('==========================================\n');

// Pre-flight checks
function preflightChecks() {
  console.log('🔍 Running pre-flight checks...');
  
  // Check if required files exist
  const requiredFiles = ['server.js', 'package.json', '.env', 'db.js'];
  for (const file of requiredFiles) {
    if (!fs.existsSync(path.join(__dirname, file))) {
      console.error(`❌ Missing required file: ${file}`);
      process.exit(1);
    }
  }
  
  // Check if uploads directory exists
  const uploadsDir = path.join(__dirname, 'public/uploads');
  if (!fs.existsSync(uploadsDir)) {
    console.log('📁 Creating uploads directory...');
    fs.mkdirSync(uploadsDir, { recursive: true });
    
    // Create subdirectories
    const subDirs = ['properties', 'plans', 'avatars', 'cities', 'banners', 'documents'];
    subDirs.forEach(dir => {
      const subDir = path.join(uploadsDir, dir);
      if (!fs.existsSync(subDir)) {
        fs.mkdirSync(subDir, { recursive: true });
      }
    });
  }
  
  console.log('✅ Pre-flight checks completed\n');
}

// Load environment variables
function loadEnvironment() {
  console.log('🔧 Loading environment configuration...');
  
  try {
    require('dotenv').config();
    
    // Auto-detect environment based on hostname or explicit setting
    if (!process.env.NODE_ENV) {
      // If running locally, set to development
      const isLocal = process.env.DB_HOST === 'localhost' || 
                     process.env.DB_HOST === '127.0.0.1' ||
                     process.env.PORT === '3000';
      process.env.NODE_ENV = isLocal ? 'development' : 'production';
    }
    
    // Validate critical environment variables but don't exit if missing
    const required = ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'];
    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
      console.warn('⚠️  Missing environment variables:', missing.join(', '));
      console.warn('   Some features may not work properly');
    }
    
    console.log('✅ Environment configuration loaded');
    console.log(`   Database: ${process.env.DB_NAME || 'Not configured'}`);
    console.log(`   Environment: ${process.env.NODE_ENV || 'production'}`);
    console.log(`   Port: ${process.env.PORT || 3000}\n`);
    
  } catch (error) {
    console.error('❌ Error loading environment:', error.message);
    console.warn('⚠️  Continuing with default configuration...\n');
  }
}

// Test database connection
async function testDatabase() {
  console.log('🗄️  Testing database connection...');
  
  try {
    const { pool } = require('./db');
    const connection = await pool.getConnection();
    await connection.query('SELECT 1 as test');
    connection.release();
    
    console.log('✅ Database connection successful\n');
    return true;
  } catch (error) {
    console.warn('⚠️  Database connection failed:', error.message);
    console.warn('   Server will continue without database connection');
    console.warn('   Some features may not work properly\n');
    return false;
  }
}

// Start the server
async function startServer() {
  try {
    console.log('🌐 Starting Express server...');
    
    // Import and start the server
    const app = require('./server');
    
    console.log('✅ Server started successfully!');
    console.log('\n🔗 Server URLs:');
    console.log(`   Local: http://localhost:${process.env.PORT || 3000}`);
    console.log(`   API: http://localhost:${process.env.PORT || 3000}/api`);
    console.log(`   Health: http://localhost:${process.env.PORT || 3000}/api/health`);
    
    if (process.env.NODE_ENV !== 'development') {
      console.log('\n🌍 Live URLs:');
      console.log('   Live: https://api.ceinfotech.in');
      console.log('   API: https://api.ceinfotech.in/api');
      console.log('   Health: https://api.ceinfotech.in/api/health');
    }
    
    console.log('\n📊 Server Status: RUNNING');
    console.log('Press Ctrl+C to stop the server\n');
    
  } catch (error) {
    console.error('❌ Failed to start server:', error.message);
    
    if (process.env.NODE_ENV === 'development') {
      console.error('\nFull error details:');
      console.error(error);
    }
    
    process.exit(1);
  }
}

// Main startup sequence
async function main() {
  try {
    preflightChecks();
    loadEnvironment();
    
    const dbConnected = await testDatabase();
    // Always continue regardless of database connection
    // This allows testing the admin dashboard even without database
    
    if (!dbConnected) {
      console.log('⚠️  Starting server without database connection');
      console.log('   API endpoints will return appropriate error messages\n');
    }
    
    await startServer();
    
  } catch (error) {
    console.error('❌ Startup failed:', error.message);
    
    // In development, show more details
    if (process.env.NODE_ENV === 'development') {
      console.error('Full error:', error);
    }
    
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🔄 Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🔄 Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

// Global error handlers for better production diagnostics
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason && reason.stack ? reason.stack : reason);
  // Consider exiting the process in production; for now, just log
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception thrown:', err && err.stack ? err.stack : err);
  // Optionally exit with non-zero status if severe
});

// Start the application
main();