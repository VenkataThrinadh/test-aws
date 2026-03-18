/**
 * Loan Plans API Routes
 * 
 * Manages loan plan templates (different loan product types, terms, etc.)
 * 
 * Routes:
 *   GET    /api/loans/loan-plans         - Get all loan plans
 *   POST   /api/loans/loan-plans         - Create loan plan
 *   GET    /api/loans/loan-plans/:id     - Get loan plan details
 *   PUT    /api/loans/loan-plans/:id     - Update loan plan
 *   DELETE /api/loans/loan-plans/:id     - Delete loan plan
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const logger = require('../utils/logger');

router.get('/', async (req, res) => {
  let connection = null;
  try {
    const { status = '', page = 1, limit = 10 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    connection = await pool.getConnection();

    // The frontend Settings UI uses legacy `loan_plan` fields (lplan_id, lplan_month, lplan_interest_3m, etc.).
    // Prefer returning legacy `loan_plan` rows so the UI shows values as expected.
    let whereClause = 'WHERE 1=1';
    const queryParams = [];

    if (status) {
      whereClause += ' AND status = ?';
      queryParams.push(status);
    }

    // Combined count from legacy and extended tables
    const countQuery = `SELECT (SELECT COUNT(*) FROM loan_plan${status ? ' WHERE status = ?' : ''}) + (SELECT COUNT(*) FROM loan_plan_extended${status ? ' WHERE status = ?' : ''}) as total`;
    const countParams = status ? [status, status] : [];
    const [countRows] = await connection.execute(countQuery, countParams);
    const totalItems = countRows[0].total;

    // Return combined rows mapped to legacy shape, but put extended rows first.
    // Apply COLLATE to text columns to avoid 'Illegal mix of collations for operation UNION' errors.
    const dataQuery = `
      SELECT * FROM (
         SELECT plan_id AS lplan_id,
           tenure_months AS lplan_month,
           -- Prefer explicit lplan_interest_* columns if present, otherwise fall back to interest_rate mapping
           COALESCE(lplan_interest_3m, CASE WHEN tenure_months = 3 THEN interest_rate ELSE NULL END) AS lplan_interest_3m,
           -- Keep a generic interest column for backwards compatibility
           interest_rate AS lplan_interest,
           COALESCE(lplan_interest_6m, CASE WHEN tenure_months = 6 THEN interest_rate ELSE NULL END) AS lplan_interest_6m,
           COALESCE(lplan_interest_12m, CASE WHEN tenure_months = 12 THEN interest_rate ELSE NULL END) AS lplan_interest_12m,
           -- Convert string columns to utf8mb4 and use a consistent collation
           CONVERT(plan_name USING utf8mb4) COLLATE utf8mb4_general_ci AS plan_name,
           min_amount,
           max_amount,
           CONVERT(status USING utf8mb4) COLLATE utf8mb4_general_ci AS status,
           created_at
         FROM loan_plan_extended
        ${status ? "WHERE status = ?" : ''}
        UNION ALL
        SELECT lplan_id,
               lplan_month,
               lplan_interest_3m,
               lplan_interest,
               lplan_interest_6m,
               lplan_interest_12m,
               CONVERT(plan_name USING utf8mb4) COLLATE utf8mb4_general_ci AS plan_name,
               min_amount,
               max_amount,
               CONVERT(status USING utf8mb4) COLLATE utf8mb4_general_ci AS status,
               created_at
        FROM loan_plan
        ${status ? "WHERE status = ?" : ''}
      ) AS combined
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;

    const dataParams = status ? [status, status, Number(limit), offset] : [Number(limit), offset];
    const [rows] = await connection.execute(dataQuery, dataParams);
    const totalPages = Math.ceil(totalItems / Number(limit));

    res.json({
      success: true,
      message: 'Loan plans retrieved successfully',
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
    logger.error('Get loan plans error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch loan plans',
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
      return res.status(400).json({ success: false, message: 'Valid plan ID required', timestamp: new Date().toISOString() });
    }
    connection = await pool.getConnection();

    // Try legacy loan_plan first
    const [legacyRows] = await connection.execute('SELECT * FROM loan_plan WHERE lplan_id = ?', [id]);
    if (legacyRows.length > 0) {
      return res.json({ success: true, message: 'Loan plan retrieved (legacy)', data: legacyRows[0], timestamp: new Date().toISOString() });
    }

    // Fall back to extended
    const [rows] = await connection.execute('SELECT * FROM loan_plan_extended WHERE plan_id = ?', [id]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Loan plan not found', timestamp: new Date().toISOString() });
    }

    // Transform extended shape into legacy-shaped object so frontend Settings UI can display interest fields
    const ext = rows[0];
    const transformed = {
      lplan_id: ext.plan_id,
      lplan_month: ext.tenure_months,
      lplan_interest_3m: (typeof ext.lplan_interest_3m !== 'undefined' && ext.lplan_interest_3m !== null) ? ext.lplan_interest_3m : (ext.tenure_months === 3 ? ext.interest_rate : null),
      lplan_interest: ext.interest_rate,
      lplan_interest_6m: (typeof ext.lplan_interest_6m !== 'undefined' && ext.lplan_interest_6m !== null) ? ext.lplan_interest_6m : (ext.tenure_months === 6 ? ext.interest_rate : null),
      lplan_interest_12m: (typeof ext.lplan_interest_12m !== 'undefined' && ext.lplan_interest_12m !== null) ? ext.lplan_interest_12m : (ext.tenure_months === 12 ? ext.interest_rate : null),
      plan_name: ext.plan_name,
      min_amount: ext.min_amount,
      max_amount: ext.max_amount,
      status: ext.status,
      created_at: ext.created_at
    };

    res.json({ success: true, message: 'Loan plan retrieved', data: transformed, timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error('Get loan plan error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch loan plan',
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
    // Accept both legacy frontend payload (`lplan_month`, `lplan_interest_*`) and new payload
    // (`plan_name`, `min_amount`, `max_amount`, `interest_rate`). If frontend sends legacy
    // fields, insert into `loan_plan` table. If it sends new fields, insert into `loan_plan_extended`.
    const {
      plan_name,
      min_amount,
      max_amount,
      interest_rate,
      tenure_months,
      status,
      // legacy fields
      lplan_month,
      lplan_interest_3m,
      lplan_interest,
      lplan_interest_6m,
      lplan_interest_12m
    } = req.body;

    connection = await pool.getConnection();

    if (lplan_month) {
      // Insert into legacy `loan_plan` table so the Settings UI shows created plan immediately
      const [result] = await connection.execute(
        `INSERT INTO loan_plan (lplan_month, lplan_interest_3m, lplan_interest, lplan_interest_6m, lplan_interest_12m, plan_name, min_amount, max_amount, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          lplan_month,
          lplan_interest_3m || 0,
          lplan_interest || 0,
          lplan_interest_6m || 0,
          lplan_interest_12m || null,
          plan_name || `Plan ${lplan_month}m`,
          min_amount || 0,
          max_amount || 0,
          status || 'active'
        ]
      );

      res.status(201).json({
        success: true,
        message: 'Loan plan created successfully (legacy table)',
        data: { lplan_id: result.insertId },
        timestamp: new Date().toISOString()
      });
    } else {
      // Validate new-style payload: require plan_name at minimum. Numeric fields may be 0.
      if (!plan_name) {
        return res.status(400).json({
          success: false,
          message: 'Plan name is required',
          timestamp: new Date().toISOString()
        });
      }

      // Persist values into extended table and also store legacy interest columns
      const safe = (v) => (typeof v !== 'undefined' && v !== null) ? v : null;
      const interestVal = (typeof interest_rate !== 'undefined' && interest_rate !== null) ? interest_rate : 0;
      const tenure = safe(tenure_months) || 12;
      const l3 = (tenure == 3) ? interestVal : (typeof lplan_interest_3m !== 'undefined' ? lplan_interest_3m : null);
      const l6 = (tenure == 6) ? interestVal : (typeof lplan_interest_6m !== 'undefined' ? lplan_interest_6m : null);
      const l12 = (tenure == 12) ? interestVal : (typeof lplan_interest_12m !== 'undefined' ? lplan_interest_12m : null);

      const [result] = await connection.execute(
        `INSERT INTO loan_plan_extended (plan_name, min_amount, max_amount, interest_rate, tenure_months, status, lplan_interest_3m, lplan_interest_6m, lplan_interest_12m, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [plan_name, safe(min_amount) || 0, safe(max_amount) || 0, interestVal, tenure, status || 'active', l3, l6, l12]
      );

      res.status(201).json({
        success: true,
        message: 'Loan plan created successfully',
        data: { plan_id: result.insertId },
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    logger.error('Create loan plan error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create loan plan',
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
    const { plan_name, min_amount, max_amount, interest_rate, tenure_months, status,
      // legacy
      lplan_month, lplan_interest_3m, lplan_interest, lplan_interest_6m, lplan_interest_12m
    } = req.body;

    if (!id || isNaN(Number(id))) {
      return res.status(400).json({ success: false, message: 'Valid plan ID required', timestamp: new Date().toISOString() });
    }

    connection = await pool.getConnection();

    // If record exists in legacy table, update it
    const [legacyRows] = await connection.execute('SELECT lplan_id FROM loan_plan WHERE lplan_id = ?', [id]);
    if (legacyRows.length > 0) {
      // Use explicit undefined checks so numeric 0 is preserved
      const safeVal = (v) => (typeof v !== 'undefined' ? v : null);
      await connection.execute(
        `UPDATE loan_plan SET lplan_month = ?, lplan_interest_3m = ?, lplan_interest = ?, lplan_interest_6m = ?, lplan_interest_12m = ?, plan_name = ?, min_amount = ?, max_amount = ?, status = ? WHERE lplan_id = ?`,
        [ safeVal(lplan_month), (typeof lplan_interest_3m !== 'undefined' ? lplan_interest_3m : 0), (typeof lplan_interest !== 'undefined' ? lplan_interest : 0), (typeof lplan_interest_6m !== 'undefined' ? lplan_interest_6m : 0), (typeof lplan_interest_12m !== 'undefined' ? lplan_interest_12m : null), safeVal(plan_name), safeVal(min_amount), safeVal(max_amount), safeVal(status), id ]
      );
    } else {
      // Update extended table - preserve zeros and allow numeric 0 values
      const safeParam = (v) => (typeof v !== 'undefined' ? v : null);

      // Compute lplan_interest_* values: prefer explicit values if provided, otherwise derive from interest_rate + tenure
      const interestVal = (typeof interest_rate !== 'undefined' ? interest_rate : null);
      const l3 = (typeof lplan_interest_3m !== 'undefined' && lplan_interest_3m !== null) ? lplan_interest_3m : (tenure_months == 3 ? interestVal : null);
      const l6 = (typeof lplan_interest_6m !== 'undefined' && lplan_interest_6m !== null) ? lplan_interest_6m : (tenure_months == 6 ? interestVal : null);
      const l12 = (typeof lplan_interest_12m !== 'undefined' && lplan_interest_12m !== null) ? lplan_interest_12m : (tenure_months == 12 ? interestVal : null);

      await connection.execute(
        `UPDATE loan_plan_extended SET plan_name = ?, min_amount = ?, max_amount = ?, interest_rate = ?, tenure_months = ?, status = ?, lplan_interest_3m = ?, lplan_interest_6m = ?, lplan_interest_12m = ? WHERE plan_id = ?`,
        [ safeParam(plan_name), safeParam(min_amount), safeParam(max_amount), safeParam(interest_rate), safeParam(tenure_months), safeParam(status), l3, l6, l12, id ]
      );
    }

    res.json({ success: true, message: 'Loan plan updated successfully', timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error('Update loan plan error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update loan plan',
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
      return res.status(400).json({ success: false, message: 'Valid plan ID required', timestamp: new Date().toISOString() });
    }
    connection = await pool.getConnection();

    // Try delete from legacy table first
    const [legacyRows] = await connection.execute('SELECT lplan_id FROM loan_plan WHERE lplan_id = ?', [id]);
    if (legacyRows.length > 0) {
      await connection.execute('DELETE FROM loan_plan WHERE lplan_id = ?', [id]);
    } else {
      await connection.execute('DELETE FROM loan_plan_extended WHERE plan_id = ?', [id]);
    }

    res.json({ success: true, message: 'Loan plan deleted successfully', timestamp: new Date().toISOString() });
  } catch (error) {
    logger.error('Delete loan plan error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete loan plan',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
