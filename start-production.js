#!/usr/bin/env node

/**
 * Production Server Starter
 * This script loads the production environment and starts the server
 */

const path = require('path');
const fs = require('fs');

// Load production environment variables
require('dotenv').config();
console.log('✅ Production environment loaded from .env');

// Ensure NODE_ENV is set to production
process.env.NODE_ENV = 'production';

// Start the server
console.log('🚀 Starting Real Estate API Server in Production Mode...');
require('./server.js');