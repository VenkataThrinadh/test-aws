
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const auth = require('../middleware/auth');
const { BalanceService } = require('../services/balanceService');

// Utility: create settings and transactions if missing
async function ensureSettingsAndTransactions(connection) {
  try {
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS settings (
        setting_id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
        setting_name VARCHAR(50) NOT NULL UNIQUE,
        setting_value VARCHAR(255) NOT NULL,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    await connection.execute(`
      CREATE TABLE IF NOT EXISTS transactions (
        transaction_id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
        loan_id INT(11) DEFAULT NULL,
        transaction_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        transaction_type ENUM('deposit','loan','expense','withdrawal') NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        description VARCHAR(255) NOT NULL,
        reference_id VARCHAR(50) DEFAULT NULL,
        reference_no VARCHAR(100) DEFAULT NULL,
        balance_before DECIMAL(10,2) NOT NULL,
        balance_after DECIMAL(10,2) NOT NULL,
        created_by VARCHAR(100) DEFAULT NULL,
        status ENUM('completed','pending','failed') DEFAULT 'pending'
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  } catch (e) {
    // continue silently
  }
}

// Ensure table exists (idempotent)
async function ensureTable() {
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        user_id INT NOT NULL PRIMARY KEY,
        menu_visibility JSON NULL,
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        CONSTRAINT fk_user_preferences_users FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);
  } catch (e) {
    // silent
  }
}

// Run once on import
ensureTable();



// --- Department/Designation Feature Toggles ---
// NOTE: In production, all API routes are prefixed with /backend, e.g. /backend/api/settings/feature-toggles
// Get feature toggles for a department/designation (public, no auth)
router.get('/feature-toggles', async (req, res) => {
  try {
    let { department, designation } = req.query;
    if (!department || !designation) {
      return res.status(400).json({ success: false, error: 'department and designation are required' });
    }
    // Normalize designation to snake_case for RBAC
    designation = designation.replace(/\s+/g, '_').toLowerCase();
    const [rows] = await pool.execute(
      'SELECT feature_key, enabled FROM department_role_feature_toggles WHERE department = ? AND designation = ?',
      [department, designation]
    );
    const toggles = {};
    rows.forEach(row => { toggles[row.feature_key] = !!row.enabled; });
    res.json({ success: true, toggles });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to load feature toggles' });
  }
});

const adminAuth = require('../middleware/adminAuth');

// Update feature toggles for a department/designation (admin/sub-admin only)
router.put('/feature-toggles', auth, adminAuth, async (req, res) => {
  try {
    let { department, designation, toggles } = req.body;
    if (!department || !designation || typeof toggles !== 'object') {
      return res.status(400).json({ success: false, error: 'department, designation, and toggles are required' });
    }
    // Normalize designation to snake_case for RBAC
    designation = designation.replace(/\s+/g, '_').toLowerCase();
    // Upsert each toggle
    const promises = Object.entries(toggles).map(([feature_key, enabled]) =>
      pool.execute(
        `INSERT INTO department_role_feature_toggles (department, designation, feature_key, enabled)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), updated_at = CURRENT_TIMESTAMP`,
        [department, designation, feature_key, !!enabled]
      )
    );
    await Promise.all(promises);
    // Emit real-time update to all clients in this department/designation
    const io = req.app.get('io');
    if (io) {
      io.to(`${department}_${designation}`).emit('feature-toggles-updated', { department, designation });
    }
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to save feature toggles' });
  }
});

// Get current user's menu visibility
router.get('/menu-visibility', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const [rows] = await pool.execute(
      'SELECT menu_visibility FROM user_preferences WHERE user_id = ? LIMIT 1',
      [userId]
    );

    if (rows.length === 0 || !rows[0].menu_visibility) {
      return res.json({ success: true, menuVisibility: null });
    }

    // menu_visibility is stored as JSON
    res.json({ success: true, menuVisibility: rows[0].menu_visibility });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to load settings' });
  }
});

// Update current user's menu visibility
router.put('/menu-visibility', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    const { menuVisibility } = req.body;

    if (!menuVisibility || typeof menuVisibility !== 'object') {
      return res.status(400).json({ success: false, error: 'menuVisibility object is required' });
    }

    // Upsert into user_preferences
    await pool.execute(
      `INSERT INTO user_preferences (user_id, menu_visibility)
       VALUES (?, ?)
       ON DUPLICATE KEY UPDATE menu_visibility = VALUES(menu_visibility), updated_at = CURRENT_TIMESTAMP`,
      [userId, JSON.stringify(menuVisibility)]
    );

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: 'Failed to save settings' });
  }
});


// System settings - includes current_balance and other system-level settings
router.get('/system', auth, async (req, res) => {
  // Allow access for admin or sales department
  if (req.user.role !== 'admin' && req.user.department !== 'sales') {
    return res.status(403).json({ error: 'Not authorized' });
  }
  const connection = await pool.getConnection();
  try {
    await ensureSettingsAndTransactions(connection);
    const [rows] = await connection.execute(`SELECT setting_name, setting_value FROM settings`);
    const settings = rows || [];
    const find = (name) => settings.find(s => s.setting_name === name)?.setting_value;
    const systemSettings = {
      current_balance: parseFloat(find('current_balance') || '0') || 0,
      auto_interest_calculation: (find('auto_interest_calculation') || 'true') === 'true',
      default_interest_rate: parseFloat(find('default_interest_rate') || '2.5'),
      grace_period_days: parseInt(find('grace_period_days') || '30'),
      backup_frequency: find('backup_frequency') || 'daily',
      notification_enabled: (find('notification_enabled') || 'true') === 'true',
      fb_leads_token: find('fb_leads_token') || '',
      ig_leads_token: find('ig_leads_token') || '',
      google_leads_token: find('google_leads_token') || ''
    };
    res.json({ success: true, data: systemSettings });
  } catch (error) {
    console.error('GET /settings/system error:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve system settings' });
  } finally {
    connection.release();
  }
});

// Save social media tokens for lead integration (admin only)
router.put('/lead-tokens', auth, adminAuth, async (req, res) => {
  const { fb_leads_token, ig_leads_token, google_leads_token } = req.body;
  if (!fb_leads_token && !ig_leads_token && !google_leads_token) {
    return res.status(400).json({ error: 'At least one token is required' });
  }
  const connection = await pool.getConnection();
  try {
    await ensureSettingsAndTransactions(connection);
    if (fb_leads_token)
      await connection.execute(`INSERT INTO settings (setting_name, setting_value) VALUES ('fb_leads_token', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`, [fb_leads_token]);
    if (ig_leads_token)
      await connection.execute(`INSERT INTO settings (setting_name, setting_value) VALUES ('ig_leads_token', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`, [ig_leads_token]);
    if (google_leads_token)
      await connection.execute(`INSERT INTO settings (setting_name, setting_value) VALUES ('google_leads_token', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)`, [google_leads_token]);
    res.json({ success: true, message: 'Tokens updated' });
  } catch (error) {
    console.error('PUT /settings/lead-tokens error:', error);
    res.status(500).json({ error: 'Failed to update tokens' });
  } finally {
    connection.release();
  }
});

// Current balance endpoints
router.get('/current-balance', auth, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await ensureSettingsAndTransactions(connection);
    const currentBalance = await BalanceService.getCurrentBalance(connection);
    res.json({ success: true, data: { current_balance: currentBalance } });
  } catch (error) {
    console.error('GET /settings/current-balance error:', error);
    res.status(500).json({ success: false, error: 'Failed to retrieve current balance' });
  } finally {
    connection.release();
  }
});

router.put('/current-balance', auth, async (req, res) => {
  const { amount } = req.body;
  if (typeof amount !== 'number' || amount < 0) {
    return res.status(400).json({ success: false, error: 'Valid amount is required' });
  }
  const connection = await pool.getConnection();
  try {
    await ensureSettingsAndTransactions(connection);
    await connection.execute("INSERT INTO settings (setting_name, setting_value) VALUES ('current_balance', ?) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)", [amount.toString()]);
    res.json({ success: true, data: { current_balance: amount } });
  } catch (error) {
    console.error('PUT /settings/current-balance error:', error);
    res.status(500).json({ success: false, error: 'Failed to update current balance' });
  } finally {
    connection.release();
  }
});

// Add to balance
router.post('/add-to-balance', auth, async (req, res) => {
  const { amount, description } = req.body;
  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ success: false, error: 'Valid positive amount is required' });
  }
  const connection = await pool.getConnection();
  try {
    await ensureSettingsAndTransactions(connection);
    console.log('POST /settings/add-to-balance: calling updateWalletBalance', { amount, description });
    const result = await BalanceService.updateWalletBalance(connection, Math.abs(amount), description || 'Manual balance add', `MANUAL_ADD_${Date.now()}`, req.user?.email || req.user?.id || null);
    console.log('POST /settings/add-to-balance: updateWalletBalance result', result);
    if (!result.success) {
      // updateWalletBalance should manage rollback/commit, just return error
      return res.status(500).json({ success: false, error: result.message || 'Failed to add to balance' });
    }
    res.status(200).json({ success: true, message: 'Amount added to balance', data: { current_balance: result.newBalance } });
  } catch (error) {
    await connection.rollback();
    console.error('POST /settings/add-to-balance error:', error);
    res.status(500).json({ success: false, error: 'Failed to add to balance' });
  } finally {
    connection.release();
  }
});

// Subtract from balance
router.post('/subtract-from-balance', auth, async (req, res) => {
  const { amount, description } = req.body;
  if (typeof amount !== 'number' || amount <= 0) {
    return res.status(400).json({ success: false, error: 'Valid positive amount is required' });
  }
  const connection = await pool.getConnection();
  try {
    await ensureSettingsAndTransactions(connection);
    const currentBalance = await BalanceService.getCurrentBalance(connection);
    if (currentBalance < amount) {
      return res.status(400).json({ success: false, error: `Insufficient balance. Current: ₹${currentBalance}` });
    }
    console.log('POST /settings/subtract-from-balance: calling updateWalletBalance', { amount, description });
    const result = await BalanceService.updateWalletBalance(connection, -Math.abs(amount), description || 'Manual balance subtract', `MANUAL_SUB_${Date.now()}`, req.user?.email || req.user?.id || null);
    console.log('POST /settings/subtract-from-balance: updateWalletBalance result', result);
    if (!result.success) {
      return res.status(500).json({ success: false, error: result.message || 'Failed to subtract from balance' });
    }
    res.json({ success: true, message: 'Amount subtracted from balance', data: { current_balance: result.newBalance } });
  } catch (error) {
    await connection.rollback();
    console.error('POST /settings/subtract-from-balance error:', error);
    res.status(500).json({ success: false, error: 'Failed to subtract from balance' });
  } finally {
    connection.release();
  }
});

// Generic balance transaction endpoint (create deposit/withdrawal)
router.post('/balance-transaction', auth, async (req, res) => {
  const { type, amount, description } = req.body;
  // Mirror legacy behavior: require type, amount, description; begin transaction explicitly
  if (!type || !['deposit', 'withdrawal'].includes(type)) {
    return res.status(400).json({ success: false, error: 'Transaction type must be deposit or withdrawal' });
  }
  const value = parseFloat(amount);
  if (isNaN(value) || value <= 0) {
    return res.status(400).json({ success: false, error: 'Valid positive amount is required' });
  }
  if (!description || !String(description).trim()) {
    return res.status(400).json({ success: false, error: 'Description is required' });
  }

  const connection = await pool.getConnection();
  try {
    await ensureSettingsAndTransactions(connection);
    // Start a transaction explicitly to ensure SELECT ... FOR UPDATE works consistently
    await connection.beginTransaction();

    // Read current balance (no FOR UPDATE needed here since we started a transaction)
    const [balanceRows] = await connection.execute("SELECT setting_value FROM settings WHERE setting_name = 'current_balance' LIMIT 1");
    let currentBalance = 0;
    if (!balanceRows || balanceRows.length === 0) {
      // Insert default setting if missing
      await connection.execute("INSERT INTO settings (setting_name, setting_value) VALUES ('current_balance', '0.00')");
    } else {
      currentBalance = parseFloat(balanceRows[0].setting_value) || 0;
    }

    if (type === 'withdrawal' && currentBalance < value) {
      await connection.rollback();
      return res.status(400).json({ success: false, error: `Insufficient balance. Current: ₹${currentBalance}` });
    }

    const newBalance = type === 'deposit' ? currentBalance + value : currentBalance - value;

    // Update the system balance
    await connection.execute("UPDATE settings SET setting_value = ? WHERE setting_name = 'current_balance'", [newBalance.toString()]);

    // Ensure transactions table exists and insert the record
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS transactions (
        transaction_id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
        loan_id INT(11) DEFAULT NULL,
        transaction_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        transaction_type ENUM('deposit','loan','expense','withdrawal') NOT NULL,
        amount DECIMAL(10,2) NOT NULL,
        description VARCHAR(255) NOT NULL,
        reference_id VARCHAR(50) DEFAULT NULL,
        reference_no VARCHAR(100) DEFAULT NULL,
        balance_before DECIMAL(10,2) NOT NULL,
        balance_after DECIMAL(10,2) NOT NULL,
        created_by VARCHAR(100) DEFAULT NULL,
        status ENUM('completed','pending','failed') DEFAULT 'pending'
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    const date = new Date();
    const referenceId = `${type.toUpperCase()}_${Date.now()}`;
    const [insertRes] = await connection.execute(
      `INSERT INTO transactions (transaction_date, transaction_type, amount, description, reference_id, reference_no, balance_before, balance_after, created_by, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [date, type, Math.abs(value), description, referenceId, referenceId, currentBalance, newBalance, req.user?.email || req.user?.id || null, 'completed']
    );

    await connection.commit();
    res.status(201).json({ success: true, message: `Balance ${type} processed successfully`, data: { transactionId: insertRes.insertId || null, balance_before: currentBalance, balance_after: newBalance, type, amount: Math.abs(value), description } });
  } catch (error) {
    try { await connection.rollback(); } catch (rbErr) { /* ignore rollback errors */ }
    console.error('POST /settings/balance-transaction error:', error && error.stack ? error.stack : error);
    if (process.env.NODE_ENV === 'development') {
      res.status(500).json({ success: false, error: 'Failed to process balance transaction', details: error && (error.message || error.sqlMessage || error.code) });
    } else {
      res.status(500).json({ success: false, error: 'Failed to process balance transaction' });
    }
  } finally {
    try { connection.release(); } catch (releaseErr) { console.error('Failed to release DB connection:', releaseErr); }
  }
});

// Get balance history
router.get('/balance-history', auth, async (req, res) => {
  const connection = await pool.getConnection();
  try {
    await ensureSettingsAndTransactions(connection);
    const [cols] = await connection.execute(`SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'transactions'`);
    const colSet = new Set((cols || []).map(c => c.COLUMN_NAME));
    const selectParts = [
      'transaction_id',
      'transaction_date',
      // raw type for internal debugging
      "transaction_type AS raw_transaction_type",
      // map 'loan' and other expense-like types to 'withdrawal' for display
      "CASE WHEN transaction_type IN ('loan','expense') THEN 'withdrawal' ELSE transaction_type END AS transaction_type",
      'amount',
      'description',
      'reference_id',
      colSet.has('loan_id') ? 'loan_id' : 'NULL AS loan_id',
      colSet.has('balance_before') ? 'balance_before' : 'NULL AS balance_before',
      'balance_after',
      colSet.has('created_by') ? 'created_by' : "NULL AS created_by",
    ];
    const [rows] = await connection.execute(`SELECT ${selectParts.join(', ')} FROM transactions WHERE transaction_type IN ('deposit','withdrawal','loan','expense') ORDER BY transaction_date DESC`);
    res.json({ success: true, data: rows });
  } catch (error) {
    console.error('GET /settings/balance-history error:', error);
    res.status(500).json({ success: false, error: 'Failed to get balance history' });
  } finally {
    connection.release();
  }
});

module.exports = router;