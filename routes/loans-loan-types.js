/**
 * Loan Types API Routes
 * 
 * Manages different loan types (personal, mortgage, business, etc.)
 * 
 * Routes:
 *   GET    /api/loans/loan-types         - Get all loan types
 *   POST   /api/loans/loan-types         - Create loan type
 *   GET    /api/loans/loan-types/:id     - Get loan type details
 *   PUT    /api/loans/loan-types/:id     - Update loan type
 *   DELETE /api/loans/loan-types/:id     - Delete loan type
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const logger = require('../utils/logger');

router.get('/', async (req, res) => {
  let connection = null;
  try {
    const { page = 1, limit = 10 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    connection = await pool.getConnection();

    // Frontend Settings expects legacy `loan_type` fields (ltype_id, ltype_name).
    // Return legacy `loan_type` rows so the UI shows values as expected.
    // Combined count from legacy and extended tables
    const countQuery = `SELECT (SELECT COUNT(*) FROM loan_type) + (SELECT COUNT(*) FROM loan_type_extended) as total`;
    const [countRows] = await connection.execute(countQuery);
    const totalItems = countRows[0].total;

    // Prefer returning extended table rows first so Settings UI shows extended types.
    // Use COLLATE for string columns and handle legacy table missing created_at.
    const dataQuery = `
      SELECT * FROM (
        SELECT type_id AS ltype_id,
               -- Convert to utf8mb4 and apply consistent collation to avoid charset mismatch
               CONVERT(type_name USING utf8mb4) COLLATE utf8mb4_general_ci AS ltype_name,
               CONVERT(description USING utf8mb4) COLLATE utf8mb4_general_ci AS ltype_desc,
               min_amount,
               max_amount,
               created_at
        FROM loan_type_extended
        UNION ALL
        SELECT ltype_id,
               CONVERT(ltype_name USING utf8mb4) COLLATE utf8mb4_general_ci AS ltype_name,
               CONVERT(ltype_desc USING utf8mb4) COLLATE utf8mb4_general_ci AS ltype_desc,
               NULL AS min_amount,
               NULL AS max_amount,
               NULL AS created_at
        FROM loan_type
      ) AS combined
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;

    const [rows] = await connection.execute(dataQuery, [Number(limit), offset]);
    const totalPages = Math.ceil(totalItems / Number(limit));

    res.json({
      success: true,
      message: 'Loan types retrieved successfully',
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
    logger.error('Get loan types error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch loan types',
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
      return res.status(400).json({ success: false, message: 'Valid type ID required', timestamp: new Date().toISOString() });
    }

    connection = await pool.getConnection();

    // Try legacy loan_type first
    const [legacyRows] = await connection.execute('SELECT * FROM loan_type WHERE ltype_id = ?', [id]);
    if (legacyRows.length > 0) {
      return res.json({ success: true, message: 'Loan type retrieved (legacy)', data: legacyRows[0], timestamp: new Date().toISOString() });
    }

    const [rows] = await connection.execute('SELECT * FROM loan_type_extended WHERE type_id = ?', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Loan type not found', timestamp: new Date().toISOString() });
    }

    res.json({ success: true, message: 'Loan type retrieved', data: rows[0], timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error('Get loan type error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch loan type',
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
    // Accept both legacy (`ltype_name`, `ltype_desc`) and new (`type_name`) payloads.
    const { type_name, description, min_amount, max_amount, ltype_name, ltype_desc } = req.body;

    connection = await pool.getConnection();

    if (ltype_name) {
      // Insert into legacy `loan_type` table
      const [result] = await connection.execute(
        `INSERT INTO loan_type (ltype_name, ltype_desc)
         VALUES (?, ?)`,
        [ltype_name, ltype_desc || '']
      );

      res.status(201).json({
        success: true,
        message: 'Loan type created successfully (legacy table)',
        data: { ltype_id: result.insertId },
        timestamp: new Date().toISOString()
      });
    } else {
      if (!type_name) {
        return res.status(400).json({
          success: false,
          message: 'Loan type name is required',
          timestamp: new Date().toISOString()
        });
      }

      const [result] = await connection.execute(
        `INSERT INTO loan_type_extended (type_name, description, min_amount, max_amount, created_at)
         VALUES (?, ?, ?, ?, NOW())`,
        [type_name, description || '', min_amount || 0, max_amount || 0]
      );

      res.status(201).json({
        success: true,
        message: 'Loan type created successfully',
        data: { type_id: result.insertId },
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    logger.error('Create loan type error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create loan type',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

router.put('/:id', async (req, res) => {
  let connection = null;
  try {
    const { id } = req.params;
    const { type_name, description, min_amount, max_amount, ltype_name, ltype_desc } = req.body;

    if (!id || isNaN(Number(id))) {
      return res.status(400).json({ success: false, message: 'Valid type ID required', timestamp: new Date().toISOString() });
    }

    connection = await pool.getConnection();

    // If exists in legacy table, update it
    const [legacyRows] = await connection.execute('SELECT ltype_id FROM loan_type WHERE ltype_id = ?', [id]);
    if (legacyRows.length > 0) {
      await connection.execute('UPDATE loan_type SET ltype_name = ?, ltype_desc = ? WHERE ltype_id = ?', [ltype_name || type_name || null, ltype_desc || description || null, id]);
    } else {
      await connection.execute(
        `UPDATE loan_type_extended SET type_name = ?, description = ?, min_amount = ?, max_amount = ? WHERE type_id = ?`,
        [type_name || null, description || null, min_amount || null, max_amount || null, id]
      );
    }

    res.json({ success: true, message: 'Loan type updated successfully', timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error('Update loan type error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update loan type',
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
      return res.status(400).json({ success: false, message: 'Valid type ID required', timestamp: new Date().toISOString() });
    }

    connection = await pool.getConnection();

    // Try delete from legacy table first
    const [legacyRows] = await connection.execute('SELECT ltype_id FROM loan_type WHERE ltype_id = ?', [id]);
    if (legacyRows.length > 0) {
      await connection.execute('DELETE FROM loan_type WHERE ltype_id = ?', [id]);
    } else {
      await connection.execute('DELETE FROM loan_type_extended WHERE type_id = ?', [id]);
    }

    res.json({ success: true, message: 'Loan type deleted successfully', timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error('Delete loan type error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete loan type',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
