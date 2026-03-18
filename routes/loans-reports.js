/**
 * Reports API Routes
 * 
 * Generates various reports for loan management (collections, overdue, etc.)
 * 
 * Routes:
 *   GET    /api/loans/reports/collections    - Get collection report
 *   GET    /api/loans/reports/overdue        - Get overdue report
 *   GET    /api/loans/reports/summary        - Get summary report
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const logger = require('../utils/logger');

router.get('/collections', async (req, res) => {
  let connection = null;
  try {
    const { start_date, end_date } = req.query;

    connection = await pool.getConnection();

    let query = `
      SELECT 
        p.payment_id, 
        p.loan_id, 
        p.actual_amount AS payment_amount, 
        p.payment_date, 
        p.payment_mode AS payment_method,
        b.full_name,
        l.amount AS loan_amount,
        r.status AS receipt_status
      FROM payment p
      JOIN loan l ON p.loan_id = l.loan_id
      JOIN borrower b ON l.borrower_id = b.borrower_id
      LEFT JOIN receipts r ON r.payment_id = p.payment_id
      WHERE r.status = 'issued'
    `;

    const params = [];

    if (start_date) {
      query += ` AND p.payment_date >= ?`;
      params.push(start_date);
    }
    if (end_date) {
      query += ` AND p.payment_date <= ?`;
      params.push(end_date);
    }

    query += ` ORDER BY p.payment_date DESC`;

    const [rows] = await connection.execute(query, params);

    const totalCollected = rows.reduce((sum, row) => sum + (row.payment_amount || 0), 0);
    const totalRecords = rows.length;

    res.json({
      success: true,
      message: 'Collection report retrieved successfully',
      data: {
        collections: rows,
        summary: {
          totalCollected,
          totalRecords,
          period: { start: start_date || 'N/A', end: end_date || 'N/A' }
        }
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Get collections report error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch collection report',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

router.get('/overdue', async (req, res) => {
  let connection = null;
  try {
    connection = await pool.getConnection();

    const [rows] = await connection.execute(`
      SELECT 
        l.loan_id,
        b.full_name,
        b.contact_no AS phone,
        l.amount AS loan_amount,
        l.maturity_date,
        DATEDIFF(NOW(), l.maturity_date) as days_overdue,
        (SELECT COALESCE(SUM(p.actual_amount),0) FROM payment p JOIN receipts rr ON rr.payment_id = p.payment_id WHERE p.loan_id = l.loan_id AND rr.status = 'issued') as paid_amount
      FROM loan l
      JOIN borrower b ON l.borrower_id = b.borrower_id
      WHERE l.status = 2 AND l.maturity_date < NOW()
      ORDER BY l.maturity_date ASC
    `);

    const totalOverdueAmount = rows.reduce((sum, row) => sum + (row.loan_amount - (row.paid_amount || 0)), 0);

    res.json({
      success: true,
      message: 'Overdue report retrieved successfully',
      data: {
        overdueLoans: rows,
        summary: {
          totalOverdueLoans: rows.length,
          totalOverdueAmount
        }
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Get overdue report error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch overdue report',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

router.get('/summary', async (req, res) => {
  let connection = null;
  try {
    connection = await pool.getConnection();

    const [loanStats] = await connection.execute(`
      SELECT 
        COUNT(*) as totalLoans,
        SUM(amount) as totalAmount,
        AVG(amount) as averageAmount,
        MIN(amount) as minAmount,
        MAX(amount) as maxAmount
      FROM loan
    `);

    const [statusBreakdown] = await connection.execute(`
      SELECT status, COUNT(*) as count, SUM(amount) as amount
      FROM loan
      GROUP BY status
    `);

    const [collectionStats] = await connection.execute(`
      SELECT 
        COUNT(*) as totalPayments,
        COALESCE(SUM(r.receipt_amount),0) as totalCollected,
        AVG(r.receipt_amount) as averagePayment
      FROM payment p
      JOIN receipts r ON r.payment_id = p.payment_id
      WHERE r.status = 'issued'
    `);

    res.json({
      success: true,
      message: 'Summary report retrieved successfully',
      data: {
        loanStatistics: loanStats[0],
        statusBreakdown,
        collectionStatistics: collectionStats[0]
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Get summary report error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch summary report',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
