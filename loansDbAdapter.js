/**
 * Loans Database Adapter
 * 
 * Bridges changing-crm's multi-branch database pattern to main-crm's single pool
 * All branch parameters are normalized to use the main connection pool
 * 
 * This adapter allows changing-crm loan controllers to work with main-crm's
 * database architecture without modification
 */

const { pool } = require('./db');
const logger = require('./utils/logger');

/**
 * Adapter to translate changing-crm's multi-branch database pattern
 * to main-crm's single MySQL pool architecture
 */
const loansDbAdapter = {
  /**
   * Get a database connection from the pool
   * Branch parameter is accepted for API compatibility but ignored
   * Returns a connection from the main pool
   * 
   * @param {string} branch - Branch identifier (ignored, for compatibility)
   * @returns {Promise} Database connection object
   */
  getDatabaseConnection: async (branch = 'main') => {
    try {
      const connection = await pool.getConnection();
      logger.dev(`Loans DB Adapter: Connection obtained (branch param: ${branch})`);
      return connection;
    } catch (error) {
      logger.error(`Loans DB Adapter: Failed to get connection for branch ${branch}`, error.message);
      throw error;
    }
  },

  /**
   * Get the connection pool
   * Branch parameter is accepted for API compatibility but ignored
   * Returns the main pool
   * 
   * @param {string} branch - Branch identifier (ignored, for compatibility)
   * @returns {Object} MySQL connection pool
   */
  getConnectionPool: (branch = 'main') => {
    logger.dev(`Loans DB Adapter: Pool accessed (branch param: ${branch})`);
    return pool;
  },

  /**
   * Test database connection
   * Branch parameter is accepted for API compatibility but ignored
   * Tests connection using the main pool
   * 
   * @param {string} branch - Branch identifier (ignored, for compatibility)
   * @returns {Promise<boolean>} true if connection successful, false otherwise
   */
  testDatabaseConnection: async (branch = 'main') => {
    try {
      const connection = await pool.getConnection();
      await connection.query('SELECT 1 as test');
      connection.release();
      logger.dev(`Loans DB Adapter: Database test successful (branch: ${branch})`);
      return true;
    } catch (error) {
      logger.error(`Loans DB Adapter: Database test failed for branch ${branch}`, error.message);
      return false;
    }
  },

  /**
   * Branch configurations - Returns main branch config
   * Used for compatibility with changing-crm codebase
   */
  branchConfigs: {
    'main': {
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      port: parseInt(process.env.DB_PORT) || 3306
    }
  }
};

module.exports = loansDbAdapter;
