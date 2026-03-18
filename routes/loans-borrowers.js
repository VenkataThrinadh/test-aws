/**
 * Borrowers API Routes
 * 
 * Manages borrower records including creation, retrieval, updates, and deletion
 * Borrowers are individuals who take loans
 * 
 * Routes:
 *   GET    /api/loans/borrowers           - Get all borrowers (paginated)
 *   POST   /api/loans/borrowers           - Create new borrower
 *   GET    /api/loans/borrowers/:id       - Get borrower details
 *   PUT    /api/loans/borrowers/:id       - Update borrower
 *   DELETE /api/loans/borrowers/:id       - Delete borrower
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const logger = require('../utils/logger');

/**
 * GET /api/loans/borrowers
 * Retrieve all borrowers with pagination and search
 */
router.get('/', async (req, res) => {
  let connection = null;
  try {
    const { search = '', page = 1, limit = 10 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    
    connection = await pool.getConnection();
    
    let whereClause = '';
    const queryParams = [];
    
    // Build search filter
    if (search) {
      whereClause = `WHERE (
        b.borrower_id LIKE ? OR 
        b.full_name LIKE ? OR 
        b.contact_no LIKE ? OR
        b.customer_id LIKE ?
      )`;
      const searchTerm = `%${search}%`;
      queryParams.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    // Count total records
    const countQuery = 'SELECT COUNT(*) as total FROM borrower b ' + whereClause;
    const [countRows] = await connection.execute(countQuery, queryParams);
    const totalItems = countRows[0].total;

    // Get paginated data with repeat customer identification
    const dataQuery = `
      SELECT
        b.borrower_id,
        b.customer_id,
        b.full_name,
        b.contact_no,
        b.address,
        b.email,
        b.ref_no,
        b.created_at,
        b.updated_at,
        CASE WHEN (SELECT COUNT(DISTINCT borrower_id) FROM borrower WHERE customer_id = b.customer_id) > 1 THEN true ELSE false END as is_repeat_customer,
        (SELECT COUNT(DISTINCT borrower_id) FROM borrower WHERE customer_id = b.customer_id) as loan_count
      FROM borrower b
      ${whereClause}
      ORDER BY b.borrower_id DESC
      LIMIT ? OFFSET ?
    `;
    
    const [rows] = await connection.execute(dataQuery, [...queryParams, Number(limit), offset]);
    
    const totalPages = Math.ceil(totalItems / Number(limit));

    res.json({
      success: true,
      message: 'Borrowers retrieved successfully',
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
    logger.error('Get borrowers error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch borrowers',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

/**
 * GET /api/loans/borrowers/:id
 * Retrieve specific borrower by ID
 */
router.get('/:id', async (req, res) => {
  let connection = null;
  try {
    const { id } = req.params;
    
    if (!id || isNaN(Number(id))) {
      return res.status(400).json({
        success: false,
        message: 'Valid borrower ID is required',
        timestamp: new Date().toISOString()
      });
    }

    connection = await pool.getConnection();
    
    // First get the borrower to get customer_id
    const [initialRows] = await connection.execute(
      `SELECT customer_id FROM borrower WHERE borrower_id = ?`,
      [id]
    );

    if (initialRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Borrower not found',
        timestamp: new Date().toISOString()
      });
    }

    const customerId = initialRows[0].customer_id;

    // Now get full borrower details with repeat customer info
    const [rows] = await connection.execute(
      `SELECT 
        borrower_id, 
        customer_id, 
        full_name, 
        contact_no, 
        address, 
        email, 
        ref_no, 
        created_at, 
        updated_at,
        CASE WHEN (SELECT COUNT(DISTINCT borrower_id) FROM borrower WHERE customer_id = ?) > 1 THEN true ELSE false END as is_repeat_customer,
        (SELECT COUNT(DISTINCT borrower_id) FROM borrower WHERE customer_id = ?) as loan_count
       FROM borrower 
       WHERE borrower_id = ?`,
      [customerId, customerId, id]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Borrower not found',
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      success: true,
      message: 'Borrower retrieved successfully',
      data: rows[0],
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Get borrower by ID error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch borrower',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

/**
 * POST /api/loans/borrowers
 * Create a new borrower
 */
router.post('/', async (req, res) => {
  let connection = null;
  try {
    const { customer_id, full_name, contact_no, address, email, ref_no } = req.body;
    
    // Validate required fields
    if (!full_name || !contact_no || !email || !address) {
      return res.status(400).json({
        success: false,
        message: 'Full name, contact number, email, and address are required',
        timestamp: new Date().toISOString()
      });
    }

    connection = await pool.getConnection();
    
    // Insert new borrower
    const [result] = await connection.execute(
      `INSERT INTO borrower (customer_id, full_name, contact_no, address, email, ref_no, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        customer_id || null,
        full_name,
        contact_no,
        address,
        email,
        ref_no || `REF${Date.now()}`
      ]
    );

    res.status(201).json({
      success: true,
      message: 'Borrower created successfully',
      data: {
        borrower_id: result.insertId,
        customer_id: customer_id || null,
        full_name,
        contact_no,
        address,
        email,
        ref_no: ref_no || `REF${Date.now()}`
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Create borrower error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create borrower',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

/**
 * PUT /api/loans/borrowers/:id
 * Update an existing borrower
 */
router.put('/:id', async (req, res) => {
  let connection = null;
  try {
    const { id } = req.params;
    const { full_name, contact_no, address, email, ref_no } = req.body;

    if (!id || isNaN(Number(id))) {
      return res.status(400).json({
        success: false,
        message: 'Valid borrower ID is required',
        timestamp: new Date().toISOString()
      });
    }

    connection = await pool.getConnection();
    
    // Check if borrower exists
    const [checkRows] = await connection.execute(
      'SELECT borrower_id FROM borrower WHERE borrower_id = ?',
      [id]
    );

    if (checkRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Borrower not found',
        timestamp: new Date().toISOString()
      });
    }

    // Update borrower
    await connection.execute(
      `UPDATE borrower 
       SET full_name = COALESCE(?, full_name), contact_no = COALESCE(?, contact_no), 
           address = COALESCE(?, address), email = COALESCE(?, email), 
           ref_no = COALESCE(?, ref_no), updated_at = NOW()
       WHERE borrower_id = ?`,
      [full_name || null, contact_no || null, address || null, email || null, ref_no || null, id]
    );

    res.json({
      success: true,
      message: 'Borrower updated successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Update borrower error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update borrower',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

/**
 * DELETE /api/loans/borrowers/:id
 * Delete a borrower
 */
router.delete('/:id', async (req, res) => {
  let connection = null;
  try {
    const { id } = req.params;

    if (!id || isNaN(Number(id))) {
      return res.status(400).json({
        success: false,
        message: 'Valid borrower ID is required',
        timestamp: new Date().toISOString()
      });
    }

    connection = await pool.getConnection();
    
    // Check if borrower exists
    const [checkRows] = await connection.execute(
      'SELECT borrower_id FROM borrower WHERE borrower_id = ?',
      [id]
    );

    if (checkRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Borrower not found',
        timestamp: new Date().toISOString()
      });
    }

    // Delete borrower
    await connection.execute('DELETE FROM borrower WHERE borrower_id = ?', [id]);

    res.json({
      success: true,
      message: 'Borrower deleted successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Delete borrower error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete borrower',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
