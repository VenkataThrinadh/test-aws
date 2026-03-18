/**
 * Loans API Routes
 * 
 * Manages loan records (disbursements, amounts, terms, etc.)
 * 
 * Routes:
 *   GET    /api/loans/loans                - Get all loans
 *   POST   /api/loans/loans                - Create new loan
 *   GET    /api/loans/loans/:id            - Get loan details
 *   PUT    /api/loans/loans/:id            - Update loan
 *   DELETE /api/loans/loans/:id            - Delete loan
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const logger = require('../utils/logger');
const ReferenceNumberManager = require('../utils/referenceNumberManager');
const { BalanceService } = require('../services/balanceService');

router.get('/', async (req, res) => {
  let connection = null;
  try {
    const { borrower_id, status = '', page = 1, limit = 10, filter = '', search = '' } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    connection = await pool.getConnection();

    let whereClause = 'WHERE 1=1';
    const queryParams = [];

    if (borrower_id) {
      whereClause += ' AND l.borrower_id = ?';
      queryParams.push(borrower_id);
    }
    if (status) {
      whereClause += ' AND l.status = ?';
      queryParams.push(status);
    }

    // Apply tab filters coming from frontend (e.g., uptodate, today_due, pending, overdue ranges, closed)
    // We'll compute days since last payment using COALESCE(MAX(payment.payment_date), l.date_released)
    if (filter) {
      switch (filter) {
        case 'pending':
          whereClause += ' AND l.status = 1';
          break;
        case 'closed':
          whereClause += ' AND l.status = 3';
          break;
        case 'today_due':
          whereClause += ` AND l.status = 2 AND (
            DATEDIFF(CURDATE(), COALESCE((SELECT MAX(p.payment_date) FROM payment p WHERE p.loan_id = l.loan_id), DATE(l.date_released))) = 30
          )`;
          break;
        case 'uptodate': // Due 0-30d
          whereClause += ` AND l.status = 2 AND (
            DATEDIFF(CURDATE(), COALESCE((SELECT MAX(p.payment_date) FROM payment p WHERE p.loan_id = l.loan_id), DATE(l.date_released))) BETWEEN 0 AND 30
          )`;
          break;
        case 'overdue_1_3':
          whereClause += ` AND l.status = 2 AND (
            DATEDIFF(CURDATE(), COALESCE((SELECT MAX(p.payment_date) FROM payment p WHERE p.loan_id = l.loan_id), DATE(l.date_released))) BETWEEN 31 AND 90
          )`;
          break;
        case 'overdue_3_6':
          whereClause += ` AND l.status = 2 AND (
            DATEDIFF(CURDATE(), COALESCE((SELECT MAX(p.payment_date) FROM payment p WHERE p.loan_id = l.loan_id), DATE(l.date_released))) BETWEEN 91 AND 180
          )`;
          break;
        case 'overdue_6_12':
          whereClause += ` AND l.status = 2 AND (
            DATEDIFF(CURDATE(), COALESCE((SELECT MAX(p.payment_date) FROM payment p WHERE p.loan_id = l.loan_id), DATE(l.date_released))) BETWEEN 181 AND 365
          )`;
          break;
        case 'overdue_above_12':
          whereClause += ` AND l.status = 2 AND (
            DATEDIFF(CURDATE(), COALESCE((SELECT MAX(p.payment_date) FROM payment p WHERE p.loan_id = l.loan_id), DATE(l.date_released))) > 365
          )`;
          break;
        default:
          // Unknown filter: ignore
          break;
      }
    }

    // Search across loan reference number, borrower name or borrower customer id
    if (search && String(search).trim().length > 0) {
      whereClause += ' AND (l.ref_no LIKE ? OR b.full_name LIKE ? OR b.customer_id LIKE ?)';
      const like = `%${String(search).trim()}%`;
      queryParams.push(like, like, like);
    }

    const countQuery = `SELECT COUNT(*) as total FROM loan l ${whereClause}`;
    const [countRows] = await connection.execute(countQuery, queryParams);
    const totalItems = countRows[0].total;

    // Join borrower, loan_plan, and loan_type so frontend gets expected fields
    // Aggregate payments per loan (principal portion = actual_amount - interest_amount - reduction_amount)
    const dataQuery = `
      SELECT
        l.loan_id,
        b.ref_no AS borrower_ref_no,
        b.customer_id AS customer_id,
        b.full_name AS full_name,
        l.amount AS amount,
        l.active_interest_rate AS active_interest_rate,
        COALESCE(lp.lplan_month, lpe.tenure_months) AS lplan_month,
        lt.ltype_name AS ltype_name,
        l.status,
        l.disbursed_date AS loan_release_date,
        l.date_released AS date_released,
        l.maturity_date AS maturity_date,
        l.eligible_amount AS eligible_amount,
        l.gold_photo AS gold_photo,
        -- Aggregated payment values
        COALESCE(pagg.principal_paid, 0) AS total_principal_paid,
        -- days since last payment (or since date_released if no payment)
        DATEDIFF(CURDATE(), COALESCE(pagg.last_payment_date, DATE(l.date_released))) AS days_since_last_payment,
        -- remaining principal and outstanding amount (principal remaining + remaining_interest)
        (l.amount - COALESCE(pagg.principal_paid, 0)) AS remaining_principal,
        ((l.amount - COALESCE(pagg.principal_paid, 0)) + COALESCE(l.remaining_interest, 0)) AS outstanding,
        l.ref_no AS ref_no,
        l.borrower_id
      FROM loan l
      LEFT JOIN borrower b ON l.borrower_id = b.borrower_id
      LEFT JOIN loan_type lt ON l.ltype_id = lt.ltype_id
      LEFT JOIN loan_plan lp ON l.lplan_id = lp.lplan_id
      LEFT JOIN loan_plan_extended lpe ON l.lplan_id = lpe.plan_id
      LEFT JOIN (
        SELECT p.loan_id,
               SUM(COALESCE(p.actual_amount,0) - COALESCE(p.interest_amount,0) - COALESCE(p.reduction_amount,0)) AS principal_paid,
               MAX(p.payment_date) AS last_payment_date
        FROM payment p
        GROUP BY p.loan_id
      ) AS pagg ON pagg.loan_id = l.loan_id
      ${whereClause}
      ORDER BY l.loan_id DESC
      LIMIT ? OFFSET ?
    `;

    const [rows] = await connection.execute(dataQuery, [...queryParams, Number(limit), offset]);
    const totalPages = Math.ceil(totalItems / Number(limit));

    res.json({
      success: true,
      message: 'Loans retrieved successfully',
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
    logger.error('Get loans error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch loans',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

// Lightweight search endpoint used by Payments UI to find loans by reference/customer
router.get('/search-for-payment', async (req, res) => {
  let connection = null;
  try {
    const q = (req.query.q || '').trim();
    if (!q || q.length < 1) {
      return res.json({ success: true, message: 'No query provided', data: [] });
    }

    connection = await pool.getConnection();
    const searchLike = `%${q}%`;

    // Aggregate payments per loan to compute remaining principal and last payment
    const dataQuery = `
      SELECT
        l.loan_id,
        l.ref_no AS ref_no,
        b.ref_no AS borrower_ref_no,
        b.customer_id AS customer_id,
        b.full_name AS borrower_name,
        l.amount AS amount,
        l.active_interest_rate AS active_interest_rate,
        COALESCE(pagg.principal_paid, 0) AS principal_paid,
        (l.amount - COALESCE(pagg.principal_paid, 0)) AS remaining_principal,
        ((l.amount - COALESCE(pagg.principal_paid, 0)) + COALESCE(l.remaining_interest, 0)) AS outstanding,
        DATEDIFF(CURDATE(), COALESCE(pagg.last_payment_date, DATE(l.date_released))) AS days_since_last_payment,
        l.borrower_id
      FROM loan l
      LEFT JOIN borrower b ON l.borrower_id = b.borrower_id
      LEFT JOIN (
        SELECT p.loan_id,
               SUM(COALESCE(p.actual_amount,0) - COALESCE(p.interest_amount,0) - COALESCE(p.reduction_amount,0)) AS principal_paid,
               MAX(p.payment_date) AS last_payment_date
        FROM payment p
        GROUP BY p.loan_id
      ) AS pagg ON pagg.loan_id = l.loan_id
      WHERE (l.ref_no LIKE ? OR b.ref_no LIKE ? OR b.full_name LIKE ? OR b.customer_id LIKE ?)
      ORDER BY l.loan_id DESC
      LIMIT 50
    `;

    const [rows] = await connection.execute(dataQuery, [searchLike, searchLike, searchLike, searchLike]);

    // Normalize fields for frontend convenience
    // Use the borrower's reference number (borrower.ref_no) as the canonical ref shown in the UI.
    // Do not fall back to loan-level or generated reference numbers to avoid confusion.
    const normalized = (rows || []).map(r => ({
      loan_id: r.loan_id,
      ref_no: r.borrower_ref_no || null,
      borrower_ref_no: r.borrower_ref_no || null,
      borrower_name: r.borrower_name,
      customer_id: r.customer_id,
      amount: Number(r.amount) || 0,
      remaining_principal: Number(r.remaining_principal) || 0,
      remaining_interest: Number(r.remaining_interest) || 0,
      outstanding: Number(r.outstanding) || 0,
      days_overdue: Number(r.days_since_last_payment) || 0,
      active_interest_rate: Number(r.active_interest_rate) || 0,
      borrower_id: r.borrower_id
    }));

    res.json({ success: true, message: 'Search results', data: normalized });
  } catch (error) {
    logger.error('Search for payment error:', error);
    res.status(500).json({ success: false, message: 'Failed to search loans for payment', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
  } finally {
    if (connection) connection.release();
  }
});

router.get('/:id', async (req, res) => {
  let connection = null;
  try {
    const { id } = req.params;
    if (!id || isNaN(Number(id))) {
      return res.status(400).json({ success: false, message: 'Valid loan ID required', timestamp: new Date().toISOString() });
    }
    connection = await pool.getConnection();

    // Fetch loan basic info with borrower, plan and type + aggregated payment info
    const [loanRows] = await connection.execute(
      `SELECT
         l.*, 
         b.ref_no AS borrower_ref_no,
         b.customer_id AS borrower_customer_id,
         b.full_name AS borrower_name,
         lt.ltype_name AS ltype_name,
         COALESCE(lp.lplan_month, lpe.tenure_months) AS lplan_month,
         COALESCE(pagg.principal_paid,0) AS total_principal_paid,
         COALESCE(pagg.last_payment_date, NULL) AS last_payment_date,
         (l.amount - COALESCE(pagg.principal_paid,0)) AS remaining_principal,
         ((l.amount - COALESCE(pagg.principal_paid,0)) + COALESCE(l.remaining_interest,0)) AS outstanding
       FROM loan l
       LEFT JOIN borrower b ON l.borrower_id = b.borrower_id
       LEFT JOIN loan_type lt ON l.ltype_id = lt.ltype_id
       LEFT JOIN loan_plan lp ON l.lplan_id = lp.lplan_id
       LEFT JOIN loan_plan_extended lpe ON l.lplan_id = lpe.plan_id
       LEFT JOIN (
         SELECT p.loan_id,
                SUM(COALESCE(p.actual_amount,0) - COALESCE(p.interest_amount,0) - COALESCE(p.reduction_amount,0)) AS principal_paid,
                MAX(p.payment_date) AS last_payment_date
         FROM payment p
         WHERE p.loan_id = ?
         GROUP BY p.loan_id
       ) AS pagg ON pagg.loan_id = l.loan_id
       WHERE l.loan_id = ?
       LIMIT 1`,
      [id, id]
    );

    if (loanRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Loan not found', timestamp: new Date().toISOString() });
    }

    const loan = loanRows[0];

    // Fetch recent payments for this loan
    const [payments] = await connection.execute(
      `SELECT payment_id, loan_id, actual_amount, interest_amount, reduction_amount, payment_date, payment_mode, receipt_no
       FROM payment WHERE loan_id = ? ORDER BY payment_date DESC LIMIT 50`,
      [id]
    );

    // Fetch loan schedule if exists
    let schedules = [];
    try {
      const [schedRows] = await connection.execute(
        `SELECT loan_sched_id, due_date, principal_amount, interest_amount, status FROM loan_schedule WHERE loan_id = ? ORDER BY due_date`,
        [id]
      );
      schedules = schedRows;
    } catch (e) {
      // ignore if schedule table has no rows or different schema
      schedules = [];
    }

    res.json({
      success: true,
      message: 'Loan retrieved successfully',
      data: { loan, payments, schedules },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Get loan error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch loan',
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
    let { borrower_id, loan_amount, interest_rate, tenure_months, status, disbursed_date, lplan_id, ltype_id, purpose, eligible_amount } = req.body;

    // Basic validation + type coercion
    borrower_id = borrower_id ? Number(borrower_id) : null;
    loan_amount = (typeof loan_amount !== 'undefined' && loan_amount !== null) ? Number(loan_amount) : null;
    interest_rate = (typeof interest_rate !== 'undefined' && interest_rate !== null) ? Number(interest_rate) : null;
    tenure_months = (typeof tenure_months !== 'undefined' && tenure_months !== null && tenure_months !== '') ? Number(tenure_months) : null;
    status = (typeof status !== 'undefined' && status !== null) ? Number(status) : 0;
    lplan_id = (typeof lplan_id !== 'undefined' && lplan_id !== null && lplan_id !== '') ? Number(lplan_id) : null;
    ltype_id = (typeof ltype_id !== 'undefined' && ltype_id !== null && ltype_id !== '') ? Number(ltype_id) : null;
    purpose = (typeof purpose !== 'undefined' && purpose !== null) ? String(purpose) : '';
    eligible_amount = (typeof eligible_amount !== 'undefined' && eligible_amount !== null && eligible_amount !== '') ? Number(eligible_amount) : 0;

    // Sanitize numeric inputs and enforce DB column ranges
    // `loan.amount` is DECIMAL(10,2) -> max 99999999.99
    const MAX_DECIMAL_10_2 = 99999999.99;
    if (loan_amount !== null) {
      if (!isFinite(loan_amount)) {
        logger.warn('Create loan validation failed: loan_amount not finite', { body: req.body });
        return res.status(400).json({ success: false, message: 'Invalid loan_amount value', timestamp: new Date().toISOString() });
      }
      // Round to 2 decimals
      loan_amount = Math.round(Number(loan_amount) * 100) / 100;
      if (Math.abs(loan_amount) > MAX_DECIMAL_10_2) {
        logger.warn('Create loan validation failed: loan_amount out of range', { body: req.body, max: MAX_DECIMAL_10_2 });
        return res.status(400).json({ success: false, message: `loan_amount exceeds maximum allowed (${MAX_DECIMAL_10_2})`, timestamp: new Date().toISOString() });
      }
    }
    if (eligible_amount !== null) {
      if (!isFinite(eligible_amount)) eligible_amount = 0;
      eligible_amount = Math.round(Number(eligible_amount) * 100) / 100;
      if (Math.abs(eligible_amount) > MAX_DECIMAL_10_2) eligible_amount = MAX_DECIMAL_10_2;
    }

    if (!borrower_id || isNaN(borrower_id)) {
      logger.warn('Create loan validation failed: invalid borrower_id', { body: req.body });
      return res.status(400).json({ success: false, message: 'Valid borrower_id is required', timestamp: new Date().toISOString() });
    }
    if (loan_amount === null || isNaN(loan_amount)) {
      logger.warn('Create loan validation failed: missing or invalid loan_amount', { body: req.body });
      return res.status(400).json({ success: false, message: 'Valid loan_amount is required', timestamp: new Date().toISOString() });
    }
    if (interest_rate === null || isNaN(interest_rate)) {
      logger.warn('Create loan validation failed: missing or invalid interest_rate', { body: req.body });
      return res.status(400).json({ success: false, message: 'Valid interest_rate is required', timestamp: new Date().toISOString() });
    }

    connection = await pool.getConnection();

    // Determine if release is immediate (status or request flag)
    const releaseImmediately = (typeof status !== 'undefined' && Number(status) === 2) || Boolean(req.body && req.body.release_immediately === true);

    // Start transaction so reserved reference and loan insert are atomic
    await connection.beginTransaction();

    // Only check wallet balance when the loan is set to release immediately
    if (releaseImmediately) {
      try {
        const currentBalance = await BalanceService.getCurrentBalance(connection);
        if (Number(currentBalance) < Number(loan_amount)) {
          await connection.rollback();
          return res.status(400).json({ success: false, message: `Insufficient funds in account. Current balance: ₹${Number(currentBalance).toFixed(2)}`, timestamp: new Date().toISOString() });
        }
      } catch (e) {
        logger.error('Failed to check wallet balance before creating loan (release immediate):', e);
        await connection.rollback();
        return res.status(500).json({ success: false, message: 'Failed to check wallet balance', timestamp: new Date().toISOString() });
      }
    }

    const branchPrefix = (req.body && req.body.branch_prefix) ? String(req.body.branch_prefix).toUpperCase() : 'MAIN';

    // Ensure borrower exists to avoid FK errors and require borrower's own ref_no
    const [borrowerRows] = await connection.execute('SELECT borrower_id, ref_no FROM borrower WHERE borrower_id = ? LIMIT 1', [borrower_id]);
    if (borrowerRows.length === 0) {
      await connection.rollback();
      return res.status(400).json({ success: false, message: 'Borrower not found', timestamp: new Date().toISOString() });
    }
    const borrowerRefNo = borrowerRows[0].ref_no || null;
    // Require that the borrower already has a reference number (generated at borrower creation).
    // Do NOT generate new reference numbers during loan creation from the Loans page.
    if (!borrowerRefNo || String(borrowerRefNo).trim().length === 0) {
      await connection.rollback();
      logger.warn('Create loan validation failed: borrower has no reference number', { borrower_id });
      return res.status(400).json({ success: false, message: 'Borrower must have a reference number. Create borrower with reference id first.', timestamp: new Date().toISOString() });
    }
    const refNo = String(borrowerRefNo).trim();

    // Validate loan plan exists (loan.lplan_id is NOT NULL in schema)
    if (!lplan_id) {
      await connection.rollback();
      logger.warn('Create loan validation failed: missing lplan_id', { body: req.body });
      return res.status(400).json({ success: false, message: 'Valid lplan_id is required', timestamp: new Date().toISOString() });
    }
    // check in legacy loan_plan or extended
    const [planRows] = await connection.execute('SELECT lplan_id FROM loan_plan WHERE lplan_id = ? LIMIT 1', [lplan_id]);
    if (planRows.length === 0) {
      const [extRows] = await connection.execute('SELECT plan_id FROM loan_plan_extended WHERE plan_id = ? LIMIT 1', [lplan_id]);
      if (extRows.length === 0) {
        await connection.rollback();
        logger.warn('Create loan validation failed: lplan_id not found', { body: req.body });
        return res.status(400).json({ success: false, message: 'Loan plan (lplan_id) not found', timestamp: new Date().toISOString() });
      }
    }

    // Validate loan type exists; if not, NULL it out (FK will reject otherwise)
    if (ltype_id) {
      const [typeRows] = await connection.execute('SELECT ltype_id FROM loan_type WHERE ltype_id = ? LIMIT 1', [ltype_id]);
      if (typeRows.length === 0) {
        logger.warn('Create loan: provided ltype_id not found; clearing ltype_id to NULL', { body: req.body });
        ltype_id = null;
      }
    }

    // Normalize date param for MySQL. Accept strings or dates; if not present, leave null so DB default may apply
    let disbursedDateParam = null;
    if (disbursed_date) {
      const d = new Date(disbursed_date);
      if (!isNaN(d.getTime())) {
        // format YYYY-MM-DD (date column) or datetime depending on usage
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        disbursedDateParam = `${yyyy}-${mm}-${dd}`;
      }
    }
    // Compute date_released (datetime NOT NULL in schema) - use disbursed_date if provided, else now
    let dateReleasedParam = null;
    if (disbursedDateParam) {
      // set to start of day for the provided disbursed date
      dateReleasedParam = `${disbursedDateParam} 00:00:00`;
    } else {
      // current timestamp in MySQL DATETIME format
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const hh = String(now.getHours()).padStart(2, '0');
      const mi = String(now.getMinutes()).padStart(2, '0');
      const ss = String(now.getSeconds()).padStart(2, '0');
      dateReleasedParam = `${yyyy}-${mm}-${dd} ${hh}:${mi}:${ss}`;
    }

    // Map API fields to DB columns. Include lplan_id/ltype_id and compute maturity_date only if tenure_months provided
    let insertQuery;
    let params;
    if (tenure_months) {
      insertQuery = `INSERT INTO loan (borrower_id, lplan_id, amount, active_interest_rate, ltype_id, status, disbursed_date, maturity_date, date_released, purpose, eligible_amount, ref_no, date_created)
                     VALUES (?, ?, ?, ?, ?, ?, ?, DATE_ADD(?, INTERVAL ? MONTH), ?, ?, ?, ?, NOW())`;
      // params: borrower_id, lplan_id, amount, interest_rate, ltype_id, status, disbursedDateParam, disbursedDateParam, tenure_months, dateReleasedParam, purpose, eligible_amount, refNo
      params = [borrower_id, lplan_id, loan_amount, interest_rate, ltype_id, status || 0, disbursedDateParam, disbursedDateParam, tenure_months, dateReleasedParam, purpose, eligible_amount, refNo];
    } else {
      insertQuery = `INSERT INTO loan (borrower_id, lplan_id, amount, active_interest_rate, ltype_id, status, disbursed_date, date_released, purpose, eligible_amount, ref_no, date_created)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`;
      params = [borrower_id, lplan_id, loan_amount, interest_rate, ltype_id, status || 0, disbursedDateParam, dateReleasedParam, purpose, eligible_amount, refNo];
    }

    let result;
    try {
      [result] = await connection.execute(insertQuery, params);
      logger.verbose && logger.verbose('Create loan insert params:', { insertQuery, params });
    } catch (dbErr) {
      logger.error('Create loan DB error on insert:', dbErr, { insertQuery, params });
      // Handle foreign key constraint errors with clearer messages
      if (dbErr && dbErr.code === 'ER_NO_REFERENCED_ROW_2') {
        logger.error('Create loan FK error:', dbErr);
        await connection.rollback();
        return res.status(400).json({ success: false, message: 'Invalid foreign key value provided (lplan_id/ltype_id)', error: dbErr.message, timestamp: new Date().toISOString() });
      }
      throw dbErr;
    }

    // Link the reserved reference to this loan and mark as used
    // If the reference was generated by ReferenceNumberManager, the row should already exist.
    // If the reference came from borrower.ref_no and no row exists, insert one.
    try {
      const [updateRes] = await connection.execute(
        'UPDATE reference_number SET loan_id = ?, is_used = 1 WHERE reference_number = ?',
        [result.insertId, refNo]
      );
      // If no rows were updated, try inserting a new reference_number row with this ref
      if (updateRes.affectedRows === 0) {
        try {
          await connection.execute(
            'INSERT INTO reference_number (loan_id, reference_number, prefix, generated_date, is_used, created_at) VALUES (?, ?, ?, NOW(), 1, NOW())',
            [result.insertId, refNo, branchPrefix]
          );
        } catch (insertErr) {
          // If insert fails due to duplicate (race), attempt to update again
          if (insertErr && (insertErr.code === 'ER_DUP_ENTRY' || insertErr.errno === 1062)) {
            await connection.execute(
              'UPDATE reference_number SET loan_id = ?, is_used = 1 WHERE reference_number = ?',
              [result.insertId, refNo]
            );
          } else {
            throw insertErr;
          }
        }
      }
    } catch (refErr) {
      logger.error('Failed to link reference number to loan:', refErr);
      // Do not fail the whole transaction for reference linking issues; log and continue
    }

    // If loan was released immediately, deduct the loan amount from wallet balance
    if (releaseImmediately) {
      try {
        const username = req.user?.email || req.user?.username || null;
        const walletUpdate = await BalanceService.updateWalletBalance(connection, Number(loan_amount), `Loan disbursed for loan ${result.insertId}`, `LOAN_${result.insertId}_${Date.now()}`, username, 'loan', result.insertId, dateReleasedParam);
        if (!walletUpdate.success) {
          // Rollback the created loan if wallet update failed
          await connection.rollback();
          return res.status(500).json({ success: false, message: 'Failed to deduct disbursed loan amount from wallet' });
        }
      } catch (e) {
        await connection.rollback();
        throw e;
      }
    }
    await connection.commit();

    res.status(201).json({
      success: true,
      message: 'Loan created successfully',
      data: { loan_id: result.insertId, ref_no: refNo },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Create loan error:', error);
    if (connection) {
      try { await connection.rollback(); } catch (e) { /* ignore rollback errors */ }
    }
    res.status(500).json({
      success: false,
      message: 'Failed to create loan',
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
    const { borrower_id, loan_amount, interest_rate, tenure_months, status } = req.body;

    if (!id || isNaN(Number(id))) {
      return res.status(400).json({ success: false, message: 'Valid loan ID required', timestamp: new Date().toISOString() });
    }

    connection = await pool.getConnection();
    // Use COALESCE so missing fields in request do not overwrite existing DB values with NULL
    await connection.query('START TRANSACTION');
    const updateQuery = `
      UPDATE loan SET
        borrower_id = COALESCE(?, borrower_id),
        amount = COALESCE(?, amount),
        active_interest_rate = COALESCE(?, active_interest_rate),
        status = COALESCE(?, status)
      WHERE loan_id = ?`;
    try {
      // Fetch existing loan row to detect status change
      const [existingRows] = await connection.execute('SELECT status, amount FROM loan WHERE loan_id = ?', [id]);
      const existingLoan = (existingRows && existingRows[0]) || { status: null, amount: 0 };
      await connection.execute(updateQuery, [
        (typeof borrower_id !== 'undefined' ? borrower_id : null),
        (typeof loan_amount !== 'undefined' ? loan_amount : null),
        (typeof interest_rate !== 'undefined' ? interest_rate : null),
        (typeof status !== 'undefined' ? status : null),
        id
      ]);
      // If status changed to 2 (released) from non-2, ensure wallet has sufficient balance, then attempt to deduct loan amount if not already deducted
      const newStatus = (typeof status !== 'undefined') ? Number(status) : existingLoan.status;
      if (newStatus === 2 && Number(existingLoan.status) !== 2) {
        try {
          const newAmt = (typeof loan_amount !== 'undefined' && loan_amount !== null) ? Number(loan_amount) : Number(existingLoan.amount || 0);
          // Check balance
          try {
            const currentBalance = await BalanceService.getCurrentBalance(connection);
            if (Number(currentBalance) < Number(newAmt)) {
              await connection.query('ROLLBACK');
              return res.status(400).json({ success: false, message: `Insufficient funds in account. Current balance: ₹${Number(currentBalance).toFixed(2)}`, timestamp: new Date().toISOString() });
            }
          } catch (checkErr) {
            logger.error('Failed to check wallet balance before releasing loan:', checkErr);
            await connection.query('ROLLBACK');
            return res.status(500).json({ success: false, message: 'Failed to check wallet balance', timestamp: new Date().toISOString() });
          }
          const [txRows] = await connection.execute(`SELECT COUNT(*) as cnt FROM transactions WHERE transaction_type = 'loan' AND loan_id = ?`, [id]);
          const already = (txRows && txRows[0] && txRows[0].cnt) || 0;
          if (Number(already) === 0 && newAmt > 0) {
            const username = req.user?.email || req.user?.username || null;
            const walletUpdate = await BalanceService.updateWalletBalance(connection, Number(newAmt), `Loan disbursed for loan ${id}`, `LOAN_${id}_${Date.now()}`, username, 'loan', id, new Date());
            if (!walletUpdate.success) {
              await connection.query('ROLLBACK');
              return res.status(500).json({ success: false, message: 'Failed to deduct wallet during loan status update', detail: walletUpdate.message, timestamp: new Date().toISOString() });
            }
          }
        } catch (e) {
          logger.error('Error deducting loan amount on status update', e);
        }
      }
      await connection.query('COMMIT');
    } catch (dbErr) {
      logger.error('Update loan DB error:', dbErr);
      if (dbErr && dbErr.code === 'ER_NO_REFERENCED_ROW_2') {
        return res.status(400).json({ success: false, message: 'Invalid foreign key value provided when updating loan', error: dbErr.message, timestamp: new Date().toISOString() });
      }
      throw dbErr;
    }

    res.json({
      success: true,
      message: 'Loan updated successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Update loan error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update loan',
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
      return res.status(400).json({ success: false, message: 'Valid loan ID required', timestamp: new Date().toISOString() });
    }

    connection = await pool.getConnection();
    await connection.execute('DELETE FROM loan WHERE loan_id = ?', [id]);

    res.json({
      success: true,
      message: 'Loan deleted successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Delete loan error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete loan',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
