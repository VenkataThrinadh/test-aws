/**
 * Reference Numbers API Routes
 * 
 * Manages reference number generation and tracking for loans
 * 
 * Routes:
 *   GET    /api/loans/reference-numbers       - Get all reference numbers
 *   POST   /api/loans/reference-numbers       - Generate new reference number
 *   GET    /api/loans/reference-numbers/check/:ref_no  - Check if exists
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const ReferenceNumberManager = require('../utils/referenceNumberManager');
const logger = require('../utils/logger');

const refNumManager = new ReferenceNumberManager(pool);

router.get('/', async (req, res) => {
  let connection = null;
  try {
    const { page = 1, limit = 10 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    connection = await pool.getConnection();

    const countQuery = 'SELECT COUNT(*) as total FROM reference_number';
    const [countRows] = await connection.execute(countQuery);
    const totalItems = countRows[0].total;

    const dataQuery = `
      SELECT ref_id, loan_id, reference_number, prefix, generated_date, is_used, created_at
      FROM reference_number
      ORDER BY generated_date DESC
      LIMIT ? OFFSET ?
    `;

    const [rows] = await connection.execute(dataQuery, [Number(limit), offset]);
    const totalPages = Math.ceil(totalItems / Number(limit));

    res.json({
      success: true,
      message: 'Reference numbers retrieved successfully',
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
    logger.error('Get reference numbers error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch reference numbers',
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
    const { loan_id, prefix } = req.body;

    if (!loan_id) {
      return res.status(400).json({
        success: false,
        message: 'Loan ID is required',
        timestamp: new Date().toISOString()
      });
    }

    connection = await pool.getConnection();

    // Generate unique reference number
    const referenceNumber = await refNumManager.generateUniqueRefNo(prefix || 'MAIN');

    // Insert into database
    const [result] = await connection.execute(
      `INSERT INTO reference_number (loan_id, reference_number, prefix, generated_date, is_used, created_at)
       VALUES (?, ?, ?, NOW(), 0, NOW())`,
      [loan_id, referenceNumber, prefix || 'MAIN']
    );

    res.status(201).json({
      success: true,
      message: 'Reference number generated successfully',
      data: {
        ref_id: result.insertId,
        reference_number: referenceNumber
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Generate reference number error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate reference number',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

router.get('/check/:ref_no', async (req, res) => {
  try {
    const { ref_no } = req.params;

    if (!ref_no) {
      return res.status(400).json({
        success: false,
        message: 'Reference number is required',
        timestamp: new Date().toISOString()
      });
    }

    const exists = await refNumManager.refNoExists(ref_no);

    res.json({
      success: true,
      message: 'Reference number check completed',
      data: {
        reference_number: ref_no,
        exists: exists,
        available: !exists
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Check reference number error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check reference number',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
});

// Endpoint to get next available reference number (does not create record in reference_number table)
router.get('/next', async (req, res) => {
  try {
    const prefix = req.query.prefix || 'MAIN';

    // Use the manager to generate the next reference number
    const nextRef = await refNumManager.generateUniqueRefNo(prefix);

    res.json({
      success: true,
      message: 'Next reference number generated',
      data: {
        reference_number: nextRef,
        prefix: prefix
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Get next reference number error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate next reference number',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  }
});

module.exports = router;
