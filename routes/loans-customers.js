/**
 * Loan Customers API Routes
 * 
 * Manages customer records for loan management system
 * Different from real estate customers - specific to loans
 * 
 * Routes:
 *   GET    /api/loans/customers           - Get all customers
 *   POST   /api/loans/customers           - Create new customer
 *   GET    /api/loans/customers/:id       - Get customer details
 *   PUT    /api/loans/customers/:id       - Update customer
 *   DELETE /api/loans/customers/:id       - Delete customer
 *   GET    /api/loans/customers/available/sales - Get available sales customers for import
 *   POST   /api/loans/customers/import    - Import customer from sales
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const logger = require('../utils/logger');

router.get('/', async (req, res) => {
  let connection = null;
  try {
    const { search = '', page = 1, limit = 10 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);
    
    connection = await pool.getConnection();
    
    let whereClause = '';
    const queryParams = [];
    
    if (search) {
      whereClause = `WHERE (customer_id LIKE ? OR full_name LIKE ? OR phone LIKE ? OR email LIKE ?)`;
      const searchTerm = `%${search}%`;
      queryParams.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    const countQuery = 'SELECT COUNT(*) as total FROM customer_loan c ' + whereClause;
    const [countRows] = await connection.execute(countQuery, queryParams);
    const totalItems = countRows[0].total;

    const dataQuery = `
      SELECT customer_id, full_name, phone, email, address, state, district, zip_code, photo, created_at
      FROM customer_loan
      ${whereClause}
      ORDER BY customer_id DESC
      LIMIT ? OFFSET ?
    `;
    
    const [rows] = await connection.execute(dataQuery, [...queryParams, Number(limit), offset]);
    const totalPages = Math.ceil(totalItems / Number(limit));

    res.json({
      success: true,
      message: 'Customers retrieved successfully',
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
    logger.error('Get customers error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch customers',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

// Get available sales customers for import
router.get('/available/sales', async (req, res) => {
  let connection = null;
  try {
    const { search = '', page = 1, limit = 100 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    connection = await pool.getConnection();

    let whereClause = '';
    const queryParams = [];

    // Only get customers that are not already imported
    whereClause = `WHERE u.customer_id IS NOT NULL 
                   AND u.customer_id NOT IN (
                     SELECT customer_id FROM customer_loan WHERE customer_id IS NOT NULL
                   )`;

    if (search) {
      whereClause += ` AND (c.full_name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR u.customer_id LIKE ?)`;
      const searchTerm = `%${search}%`;
      queryParams.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }

    const countQuery = `
      SELECT COUNT(DISTINCT c.id) as total 
      FROM customers c
      LEFT JOIN users u ON c.user_id = u.id
      ${whereClause}
    `;
    const [countRows] = await connection.execute(countQuery, queryParams);
    const totalItems = countRows[0].total;

    const dataQuery = `
      SELECT 
        u.customer_id,
        c.full_name,
        c.phone,
        c.email,
        c.address,
        c.city as state,
        c.zip_code,
        c.id as sales_customer_internal_id
      FROM customers c
      LEFT JOIN users u ON c.user_id = u.id
      ${whereClause}
      ORDER BY c.full_name ASC
      LIMIT ? OFFSET ?
    `;

    const [rows] = await connection.execute(dataQuery, [...queryParams, Number(limit), offset]);
    const totalPages = Math.ceil(totalItems / Number(limit));

    res.json({
      success: true,
      message: 'Available sales customers retrieved successfully',
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
    logger.error('Get available sales customers error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch available sales customers',
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
      return res.status(400).json({ success: false, message: 'Valid customer ID required', timestamp: new Date().toISOString() });
    }

    connection = await pool.getConnection();
    const [rows] = await connection.execute(
      'SELECT * FROM customer_loan WHERE customer_id = ?',
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Customer not found', timestamp: new Date().toISOString() });
    }

    res.json({
      success: true,
      message: 'Customer retrieved successfully',
      data: rows[0],
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Get customer error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch customer',
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
    const { customer_id, full_name, phone, email, address, state, district, zip_code, photo } = req.body;
    
    if (!full_name || !phone) {
      return res.status(400).json({
        success: false,
        message: 'Full name and phone are required',
        timestamp: new Date().toISOString()
      });
    }

    connection = await pool.getConnection();
    
    // If customer_id is provided, use it; otherwise let the database auto-generate
    let result;
    if (customer_id) {
      const [existingCustomer] = await connection.execute(
        'SELECT customer_id FROM customer_loan WHERE customer_id = ?',
        [customer_id]
      );
      
      if (existingCustomer.length > 0) {
        return res.status(400).json({
          success: false,
          message: 'Customer ID already exists',
          timestamp: new Date().toISOString()
        });
      }
      
      [result] = await connection.execute(
        `INSERT INTO customer_loan (customer_id, full_name, phone, email, address, state, district, zip_code, photo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [customer_id, full_name, phone, email || '', address || '', state || '', district || '', zip_code || '', photo || null]
      );
    } else {
      [result] = await connection.execute(
        `INSERT INTO customer_loan (full_name, phone, email, address, state, district, zip_code, photo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [full_name, phone, email || '', address || '', state || '', district || '', zip_code || '', photo || null]
      );
    }

    res.status(201).json({
      success: true,
      message: 'Customer created successfully',
      data: { customer_id: customer_id || result.insertId },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Create customer error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create customer',
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
    const { full_name, phone, email, address, state, district, zip_code, photo } = req.body;

    if (!id || isNaN(Number(id))) {
      return res.status(400).json({ success: false, message: 'Valid customer ID required', timestamp: new Date().toISOString() });
    }

    connection = await pool.getConnection();
    await connection.execute(
      `UPDATE customer_loan SET full_name = ?, phone = ?, email = ?, address = ?, state = ?, district = ?, zip_code = ?, photo = ? WHERE customer_id = ?`,
      [full_name || null, phone || null, email || null, address || null, state || null, district || null, zip_code || null, photo || null, id]
    );

    res.json({
      success: true,
      message: 'Customer updated successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Update customer error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update customer',
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
      return res.status(400).json({ success: false, message: 'Valid customer ID required', timestamp: new Date().toISOString() });
    }

    connection = await pool.getConnection();
    await connection.execute('DELETE FROM customer_loan WHERE customer_id = ?', [id]);

    res.json({
      success: true,
      message: 'Customer deleted successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Delete customer error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete customer',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

// Import existing customer from sales dashboard
router.post('/import', async (req, res) => {
  let connection = null;
  try {
    const { sales_customer_id } = req.body;
    
    if (!sales_customer_id) {
      return res.status(400).json({
        success: false,
        message: 'Sales customer ID is required',
        timestamp: new Date().toISOString()
      });
    }

    connection = await pool.getConnection();
    
    // Fetch customer data from sales customers table using customer_id from users table
    const [salesCustomerRows] = await connection.execute(`
      SELECT 
        u.customer_id,
        c.full_name,
        c.phone,
        c.email,
        c.address,
        c.city as state,
        c.zip_code
      FROM customers c
      LEFT JOIN users u ON c.user_id = u.id
      WHERE u.customer_id = ?
    `, [sales_customer_id]);

    if (salesCustomerRows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Customer not found in sales database',
        timestamp: new Date().toISOString()
      });
    }

    const salesCustomer = salesCustomerRows[0];

    // Check if customer_id exists (should always exist for imported customers)
    if (!salesCustomer.customer_id) {
      return res.status(400).json({
        success: false,
        message: 'Customer does not have a valid customer ID in the system',
        timestamp: new Date().toISOString()
      });
    }

    // Check if customer already exists in loan customers table using the same customer_id
    const [existingLoanCustomer] = await connection.execute(
      'SELECT customer_id FROM customer_loan WHERE customer_id = ?',
      [salesCustomer.customer_id]
    );

    if (existingLoanCustomer.length > 0) {
      return res.status(400).json({
        success: false,
        message: 'Customer already exists in loan dashboard',
        timestamp: new Date().toISOString()
      });
    }

    // Insert customer into customer_loan table using the existing customer_id from users table
    const [result] = await connection.execute(
      `INSERT INTO customer_loan (customer_id, full_name, phone, email, address, state, zip_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        salesCustomer.customer_id,
        salesCustomer.full_name || '',
        salesCustomer.phone || '',
        salesCustomer.email || '',
        salesCustomer.address || '',
        salesCustomer.state || '',
        salesCustomer.zip_code || ''
      ]
    );

    res.status(201).json({
      success: true,
      message: 'Customer imported successfully',
      data: {
        loan_customer_id: salesCustomer.customer_id,
        full_name: salesCustomer.full_name,
        phone: salesCustomer.phone,
        email: salesCustomer.email
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Import customer error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to import customer',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
