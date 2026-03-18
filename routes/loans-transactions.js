/**
 * Transactions API Routes
 * 
 * Manages transaction records (ledger entries, fund movements, etc.)
 * 
 * Routes:
 *   GET    /api/loans/transactions       - Get all transactions
 *   POST   /api/loans/transactions       - Create transaction
 *   GET    /api/loans/transactions/:id   - Get transaction details
 *   DELETE /api/loans/transactions/:id   - Delete transaction
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const logger = require('../utils/logger');
const { BalanceService } = require('../services/balanceService');

router.get('/', async (req, res) => {
  let connection = null;
  try {
    let { loan_id, type = '', status = '', date_from, date_to, search = '', page = 1, limit = 10 } = req.query;
    if (loan_id === 'undefined') loan_id = undefined;
    // guard against 'undefined' string payloads
    if (type === 'undefined') type = '';
    if (status === 'undefined') status = '';
    if (date_from === 'undefined') date_from = undefined;
    if (date_to === 'undefined') date_to = undefined;
    if (search === 'undefined') search = '';

    const pageNum = Number(page) || 1;
    const limitNum = Number(limit) || 10;
    const offset = (pageNum - 1) * limitNum;

    connection = await pool.getConnection();

    // Base FROM and joins to include borrower details when available
    const baseFrom = 'FROM transactions t LEFT JOIN loan l ON t.loan_id = l.loan_id LEFT JOIN borrower b ON l.borrower_id = b.borrower_id';

    let whereClause = 'WHERE 1=1';
    const queryParams = [];

    if (loan_id) {
      whereClause += ' AND t.loan_id = ?';
      queryParams.push(loan_id);
    }
    if (type) {
      whereClause += ' AND t.transaction_type = ?';
      queryParams.push(type);
    }
    if (status) {
      whereClause += ' AND t.status = ?';
      queryParams.push(status);
    }
    if (date_from) {
      whereClause += ' AND DATE(t.transaction_date) >= ?';
      queryParams.push(date_from);
    }
    if (date_to) {
      whereClause += ' AND DATE(t.transaction_date) <= ?';
      queryParams.push(date_to);
    }
    if (search) {
      whereClause += ' AND (CAST(t.transaction_id AS CHAR) LIKE ? OR t.reference_id LIKE ? OR t.description LIKE ? OR b.full_name LIKE ?)';
      const searchTerm = `%${search}%`;
      queryParams.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }
    const countQuery = `SELECT COUNT(*) as total ${baseFrom} ${whereClause}`;
    const [countRows] = await connection.execute(countQuery, queryParams);
    const totalItems = countRows[0].total;

      const dataQuery = `
        SELECT t.transaction_id, t.loan_id, t.transaction_type, t.amount, t.transaction_date, t.status, t.created_by, t.reference_id, t.balance_before, t.balance_after, b.full_name AS customer_name
        ${baseFrom}
      ${whereClause}
      ORDER BY t.transaction_date DESC
      LIMIT ? OFFSET ?
    `;

    const [rows] = await connection.execute(dataQuery, [...queryParams, limitNum, offset]);
    const totalPages = Math.ceil(totalItems / Number(limit));

    res.json({
      success: true,
      message: 'Transactions retrieved successfully',
      data: {
        data: rows,
        pagination: {
          currentPage: Number(page),
          totalPages,
          totalItems,
          itemsPerPage: Number(limit),
          hasNextPage: Number(page) < totalPages,
          hasPreviousPage: Number(page) > 1
        }
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    // Log query context where available to help debug SQL errors
    try {
      logger.error('Get transactions error:', { error: error?.message, query: dataQuery, params: queryParams });
    } catch (e) {
      logger.error('Get transactions error:', error);
    }
    res.status(500).json({
      success: false,
      message: 'Failed to fetch transactions',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

router.get('/:id', async (req, res) => {
  let connection = null;
  try {
    const { id } = req.params;
    if (!id || isNaN(Number(id))) {
      return res.status(400).json({ success: false, message: 'Valid transaction ID required', timestamp: new Date().toISOString() });
    }

    connection = await pool.getConnection();
    // Include borrower info for detailed transaction view
    const [rows] = await connection.execute(
      `SELECT t.*, b.full_name AS customer_name FROM transactions t LEFT JOIN loan l ON t.loan_id = l.loan_id LEFT JOIN borrower b ON l.borrower_id = b.borrower_id WHERE t.transaction_id = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Transaction not found', timestamp: new Date().toISOString() });
    }

    res.json({
      success: true,
      message: 'Transaction retrieved successfully',
      data: rows[0],
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Get transaction error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch transaction',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

router.post('/', async (req, res) => {
  let connection = null;
  try {
    const { loan_id, transaction_type, amount, transaction_date, status } = req.body;

    if (!transaction_type || (typeof amount === 'undefined' || amount === null)) {
      return res.status(400).json({
        success: false,
        message: 'Loan ID, transaction type, and amount are required',
        timestamp: new Date().toISOString()
      });
    }
    connection = await pool.getConnection();
    try {
      await connection.query('START TRANSACTION');

      // Use BalanceService to perform the balance update and record transaction.
      const description = req.body.description || '';
      const referenceId = req.body.reference_id || null;
      const txDate = transaction_date || new Date();
      const username = req.user?.email || req.user?.username || null;
      const balanceUpdate = await BalanceService.updateWalletBalance(connection, Number(amount), description, referenceId, username, transaction_type, loan_id, txDate);
      if (!balanceUpdate.success) {
        await connection.query('ROLLBACK');
        return res.status(500).json({ success: false, message: 'Failed to create transaction', error: balanceUpdate.message });
      }
      await connection.query('COMMIT');
      res.status(201).json({ success: true, message: 'Transaction created successfully', data: { transaction_id: balanceUpdate.transactionId }, timestamp: new Date().toISOString() });
    } catch (err) {
      if (connection) await connection.query('ROLLBACK');
      throw err;
    }
  } catch (error) {
    logger.error('Create transaction error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create transaction',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

router.delete('/:id', async (req, res) => {
  let connection = null;
  try {
    const { id } = req.params;
    if (!id || isNaN(Number(id))) {
      return res.status(400).json({ success: false, message: 'Valid transaction ID required', timestamp: new Date().toISOString() });
    }

    connection = await pool.getConnection();
    // Fetch transaction to determine amount and type
    const [rows] = await connection.execute('SELECT transaction_type, amount, loan_id FROM transactions WHERE transaction_id = ?', [id]);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Transaction not found', timestamp: new Date().toISOString() });
    }
    const tx = rows[0];
    await connection.query('START TRANSACTION');
    try {
      // To revert, compute delta: if deposit, subtract amount; else add amount
      let delta = 0;
      const amt = Number(tx.amount || 0);
      if ((tx.transaction_type || '').toLowerCase() === 'deposit') {
        delta = -amt;
      } else {
        delta = amt;
      }
      const revert = await BalanceService.updateWalletBalance(connection, delta, `Revert transaction ${id}`, `REVERT_${id}_${Date.now()}`, req.user?.email || req.user?.username || null, null, tx.loan_id || null);
      if (!revert.success) {
        await connection.query('ROLLBACK');
        return res.status(500).json({ success: false, message: 'Failed to revert wallet balance for transaction', timestamp: new Date().toISOString() });
      }
      await connection.execute('DELETE FROM transactions WHERE transaction_id = ?', [id]);
      await connection.query('COMMIT');
    } catch (err) {
      await connection.query('ROLLBACK');
      throw err;
    }

    res.json({
      success: true,
      message: 'Transaction deleted successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Delete transaction error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete transaction',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
