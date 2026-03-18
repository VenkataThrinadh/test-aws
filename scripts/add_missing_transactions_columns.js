#!/usr/bin/env node
/**
 * Migration helper: Add missing columns to transactions table if they don't exist.
 * Run: node scripts/add_missing_transactions_columns.js
 */
const { pool } = require('../db');

async function run() {
  try {
    const connection = await pool.getConnection();
    try {
      // loan_id
      const [loanIdCols] = await connection.execute("SHOW COLUMNS FROM transactions LIKE 'loan_id'");
      if (!loanIdCols || loanIdCols.length === 0) {
        console.log('Adding column loan_id to transactions');
        await connection.execute('ALTER TABLE transactions ADD COLUMN loan_id INT(11) DEFAULT NULL');
      }

      // reference_no
      const [refNoCols] = await connection.execute("SHOW COLUMNS FROM transactions LIKE 'reference_no'");
      if (!refNoCols || refNoCols.length === 0) {
        console.log('Adding column reference_no to transactions');
        await connection.execute("ALTER TABLE transactions ADD COLUMN reference_no VARCHAR(100) DEFAULT NULL");
      }

      // status
      const [statusCols] = await connection.execute("SHOW COLUMNS FROM transactions LIKE 'status'");
      if (!statusCols || statusCols.length === 0) {
        console.log('Adding column status to transactions');
        await connection.execute("ALTER TABLE transactions ADD COLUMN status ENUM('completed','pending','failed') DEFAULT 'pending'");
      }

      console.log('Migration complete.');
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    process.exit(0);
  }
}

run();
