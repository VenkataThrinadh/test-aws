/**
 * Receipts API Routes
 * 
 * Manages receipt records for payments
 * 
 * Routes:
 *   GET    /api/loans/receipts            - Get all receipts
 *   POST   /api/loans/receipts            - Create receipt
 *   GET    /api/loans/receipts/:id        - Get receipt details
 *   DELETE /api/loans/receipts/:id        - Delete receipt
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const logger = require('../utils/logger');
const { BalanceService } = require('../services/balanceService');

router.get('/', async (req, res) => {
  let connection = null;
  try {
    const { payment_id, page = 1, limit = 10 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    connection = await pool.getConnection();

    let whereClause = 'WHERE 1=1';
    const queryParams = [];

    if (payment_id) {
      whereClause += ' AND payment_id = ?';
      queryParams.push(payment_id);
    }

    const countQuery = `SELECT COUNT(*) as total FROM receipt ${whereClause}`;
    const [countRows] = await connection.execute(countQuery, queryParams);
    const totalItems = countRows[0].total;

    const dataQuery = `
      SELECT receipt_id, payment_id, receipt_number, receipt_amount, receipt_date, status, created_at
      FROM receipt
      ${whereClause}
      ORDER BY receipt_date DESC
      LIMIT ? OFFSET ?
    `;

    const [rows] = await connection.execute(dataQuery, [...queryParams, Number(limit), offset]);
    const totalPages = Math.ceil(totalItems / Number(limit));

    res.json({
      success: true,
      message: 'Receipts retrieved successfully',
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
    logger.error('Get receipts error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch receipts',
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
      return res.status(400).json({ success: false, message: 'Valid receipt ID required', timestamp: new Date().toISOString() });
    }

    connection = await pool.getConnection();
    const [rows] = await connection.execute(
      'SELECT * FROM receipt WHERE receipt_id = ?',
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Receipt not found', timestamp: new Date().toISOString() });
    }

    res.json({
      success: true,
      message: 'Receipt retrieved successfully',
      data: rows[0],
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Get receipt error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch receipt',
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
    const { payment_id, receipt_number, receipt_amount, receipt_date, status } = req.body;

    if (!receipt_number || !receipt_amount) {
      return res.status(400).json({
        success: false,
        message: 'Payment ID, receipt number, and amount are required',
        timestamp: new Date().toISOString()
      });
    }

    connection = await pool.getConnection();
    // If receipt is not associated with a payment, treat as manual receipt and credit the wallet
    if (!payment_id) {
      await connection.query('START TRANSACTION');
      const [result] = await connection.execute(
        `INSERT INTO receipt (payment_id, receipt_number, receipt_amount, receipt_date, status, created_at)
         VALUES (?, ?, ?, ?, ?, NOW())`,
        [payment_id, receipt_number, receipt_amount, receipt_date || new Date(), status || 'issued']
      );
      try {
        // Add to wallet
        const walletUpdate = await BalanceService.updateWalletBalance(connection, Number(receipt_amount), `Manual receipt ${receipt_number}`, `RECEIPT_${result.insertId}_${Date.now()}`, req.user?.email || req.user?.id || null, 'deposit', null);
        if (!walletUpdate.success) {
          await connection.query('ROLLBACK');
          return res.status(500).json({ success: false, message: 'Failed to update wallet balance for manual receipt' });
        }
        await connection.query('COMMIT');
      } catch (err) {
        await connection.query('ROLLBACK');
        throw err;
      }
      // Use result from above for response
      res.status(201).json({
        success: true,
        message: 'Receipt created successfully (manual receipt)',
        data: { receipt_id: result.insertId },
        timestamp: new Date().toISOString()
      });
      return;
    } else {
      const [result] = await connection.execute(
        `INSERT INTO receipt (payment_id, receipt_number, receipt_amount, receipt_date, status, created_at)
         VALUES (?, ?, ?, ?, ?, NOW())`,
        [payment_id, receipt_number, receipt_amount, receipt_date || new Date(), status || 'issued']
      );
      res.status(201).json({
        success: true,
        message: 'Receipt created successfully',
        data: { receipt_id: result.insertId },
        timestamp: new Date().toISOString()
      });
      return;
    }

    res.status(201).json({
      success: true,
      message: 'Receipt created successfully',
      data: { receipt_id: result.insertId },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Create receipt error:', error);
    try { if (connection) await connection.query('ROLLBACK'); } catch (e) { }
    res.status(500).json({
      success: false,
      message: 'Failed to create receipt',
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
      return res.status(400).json({ success: false, message: 'Valid receipt ID required', timestamp: new Date().toISOString() });
    }

    connection = await pool.getConnection();
    const [rows] = await connection.execute('SELECT payment_id, receipt_amount FROM receipt WHERE receipt_id = ?', [id]);
    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Receipt not found', timestamp: new Date().toISOString() });
    }
    const r = rows[0];
    await connection.query('START TRANSACTION');
    try {
      // If manual receipt (no payment_id) - it credited the wallet, so revert
      if (!r.payment_id) {
        const revert = await BalanceService.updateWalletBalance(connection, -Math.abs(Number(r.receipt_amount || 0)), `Revert manual receipt ${id}`, `RECEIPT_DELETE_${id}_${Date.now()}`, req.user?.email || req.user?.id || null, null, null);
        if (!revert.success) {
          await connection.query('ROLLBACK');
          return res.status(500).json({ success: false, message: 'Failed to revert wallet balance for receipt' });
        }
      }
      await connection.execute('DELETE FROM receipt WHERE receipt_id = ?', [id]);
      await connection.query('COMMIT');
    } catch (err) {
      await connection.query('ROLLBACK');
      throw err;
    }

    res.json({
      success: true,
      message: 'Receipt deleted successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Delete receipt error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete receipt',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
