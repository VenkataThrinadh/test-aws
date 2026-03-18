/**
 * Dashboard API Routes
 * 
 * Provides analytics and summary data for loan management dashboard
 * 
 * Routes:
 *   GET    /api/loans/dashboard/summary       - Get dashboard summary
 *   GET    /api/loans/dashboard/stats         - Get loan statistics
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const logger = require('../utils/logger');
// Simple in-memory cache for dashboard metrics
const metricsCache = {};
const METRIC_TTL_MS = parseInt(process.env.LOAN_DASHBOARD_METRIC_TTL_MS || '30000'); // default 30s

function getCachedMetric(key) {
  const c = metricsCache[key];
  if (!c) return null;
  if (Date.now() > c.expiry) {
    delete metricsCache[key];
    return null;
  }
  return c.value;
}

function setCachedMetric(key, value, ttl = METRIC_TTL_MS) {
  const expiry = Date.now() + ttl;
  metricsCache[key] = { value, expiry };
}

router.get('/summary', async (req, res) => {
  let connection = null;
  try {
    connection = await pool.getConnection();

    const [totalLoans] = await connection.execute(
      'SELECT COUNT(*) as total, SUM(amount) as amount FROM loan WHERE status = ?',
      [2]
    );

    const [totalBorrowers] = await connection.execute(
      'SELECT COUNT(*) as total FROM borrower'
    );
    // Count of customers in loan system (customer_loan table) used for Total Customers stat
    const [totalLoanCustomers] = await connection.execute(
      'SELECT COUNT(*) as total FROM customer_loan'
    );

    // Total loans across all statuses
    const [totalLoansAll] = await connection.execute(
      'SELECT COUNT(*) as total FROM loan'
    );

    // Repeat customers according to Borrowers page: borrower rows where customer has >1 borrower entries
    const [repeatBorrowers] = await connection.execute(
      `SELECT COUNT(*) as total FROM borrower b WHERE (SELECT COUNT(DISTINCT borrower_id) FROM borrower WHERE customer_id = b.customer_id) > 1`
    );

    const [totalPayments] = await connection.execute(
      'SELECT COUNT(*) as total, COALESCE(SUM(r.receipt_amount),0) as amount FROM payment p JOIN receipts r ON r.payment_id = p.payment_id WHERE r.status = ?',
      ['issued']
    );

    // Today's payments
    const [todayPayments] = await connection.execute(
      'SELECT COUNT(*) as total, COALESCE(SUM(r.receipt_amount),0) as amount FROM payment p JOIN receipts r ON r.payment_id = p.payment_id WHERE DATE(p.payment_date) = CURDATE() AND r.status = "issued"'
    );

    const [pendingPayments] = await connection.execute(
      'SELECT COUNT(*) as total, COALESCE(SUM(r.receipt_amount),0) as amount FROM payment p JOIN receipts r ON r.payment_id = p.payment_id WHERE r.status = ?',
      ['pending']
    );

    // Total disbursed: sum of loans which have a release date (disbursed)
    const [totalDisbursed] = await connection.execute(
      'SELECT COUNT(*) as total, SUM(amount) as amount FROM loan WHERE date_released IS NOT NULL'
    );

    // add total_profit to summary (collected - disbursed)
    const totalProfit = (Number(totalPayments[0].amount || 0) - Number(totalDisbursed[0].amount || 0)) || 0;

    res.json({
      success: true,
      message: 'Dashboard summary retrieved successfully',
      data: {
        activeLoans: {
          count: totalLoans[0].total || 0,
          totalAmount: totalLoans[0].amount || 0
        },
        borrowers: {
          count: totalBorrowers[0].total || 0,
          repeat_customers: repeatBorrowers[0].total || 0
        },
        customers: {
          count: totalLoanCustomers[0].total || 0
        },
        total_loans: totalLoansAll[0].total || 0,
        disbursed: {
          count: totalDisbursed[0].total || 0,
          totalAmount: totalDisbursed[0].amount || 0
        },
        profit: Number(totalPayments[0].amount || 0) - Number(totalDisbursed[0].amount || 0) || 0,
        payments: {
          completed: {
            count: totalPayments[0].total || 0,
            totalAmount: totalPayments[0].amount || 0
          },
          pending: {
            count: pendingPayments[0].total || 0,
            totalAmount: pendingPayments[0].amount || 0
          },
          today: {
            count: todayPayments[0].total || 0,
            amount: todayPayments[0].amount || 0
          }
        },
        profit: totalProfit,
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Get dashboard summary error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch dashboard summary',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

router.get('/stats', async (req, res) => {
  let connection = null;
  try {
    connection = await pool.getConnection();

    const [loansByStatus] = await connection.execute(
      'SELECT status, COUNT(*) as count, SUM(amount) as amount FROM loan GROUP BY status'
    );

    const [topBorrowers] = await connection.execute(
      `SELECT b.borrower_id, b.full_name, COUNT(l.loan_id) as loan_count, SUM(l.amount) as total_amount
       FROM borrower b LEFT JOIN loan l ON b.borrower_id = l.borrower_id
       GROUP BY b.borrower_id, b.full_name
       ORDER BY total_amount DESC LIMIT 10`
    );

    const [paymentTrends] = await connection.execute(
      `SELECT DATE_FORMAT(payment_date, '%Y-%m') as month, COUNT(*) as count, SUM(actual_amount) as amount
       FROM payment WHERE payment_date >= DATE_SUB(NOW(), INTERVAL 12 MONTH)
       GROUP BY DATE_FORMAT(payment_date, '%Y-%m')
       ORDER BY month DESC LIMIT 12`
    );

    // Compute total profit for stats endpoint as well
    const [collected] = await connection.execute("SELECT COALESCE(SUM(r.receipt_amount),0) AS value FROM payment p JOIN receipts r ON r.payment_id = p.payment_id WHERE r.status = 'issued'");
    const [disbursed] = await connection.execute('SELECT COALESCE(SUM(amount),0) AS value FROM loan WHERE date_released IS NOT NULL');
    const totalProfit = Number(collected[0].value || 0) - Number(disbursed[0].value || 0);

    res.json({
      success: true,
      message: 'Statistics retrieved successfully',
      data: {
        loansByStatus,
        topBorrowers,
        paymentTrends
        , totalProfit
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Get stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch statistics',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

/**
 * GET /api/loans/dashboard
 * Return aggregated counts expected by the frontend loans dashboard
 * Keys: uptodate, today_due, pending, overdue_1_3, overdue_3_6, overdue_6_12, overdue_above_12, closed
 */
router.get('/', async (req, res) => {
  let connection = null;
  try {
    connection = await pool.getConnection();

    const sql = `
      SELECT
        SUM(CASE WHEN l.status = 1 THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN l.status = 3 THEN 1 ELSE 0 END) AS closed,
        SUM(CASE WHEN l.status = 2 AND DATEDIFF(CURDATE(), COALESCE(l.last_payment_date, l.interest_start_date, l.loan_release_date, l.date_released, l.date_created)) <= 30 THEN 1 ELSE 0 END) AS uptodate,
        SUM(CASE WHEN l.status = 2 AND DATEDIFF(CURDATE(), COALESCE(l.last_payment_date, l.interest_start_date, l.loan_release_date, l.date_released, l.date_created)) = 30 THEN 1 ELSE 0 END) AS today_due,
        SUM(CASE WHEN l.status = 2 AND DATEDIFF(CURDATE(), COALESCE(l.last_payment_date, l.interest_start_date, l.loan_release_date, l.date_released, l.date_created)) BETWEEN 31 AND 90 THEN 1 ELSE 0 END) AS overdue_1_3,
        SUM(CASE WHEN l.status = 2 AND DATEDIFF(CURDATE(), COALESCE(l.last_payment_date, l.interest_start_date, l.loan_release_date, l.date_released, l.date_created)) BETWEEN 91 AND 180 THEN 1 ELSE 0 END) AS overdue_3_6,
        SUM(CASE WHEN l.status = 2 AND DATEDIFF(CURDATE(), COALESCE(l.last_payment_date, l.interest_start_date, l.loan_release_date, l.date_released, l.date_created)) BETWEEN 181 AND 365 THEN 1 ELSE 0 END) AS overdue_6_12,
        SUM(CASE WHEN l.status = 2 AND DATEDIFF(CURDATE(), COALESCE(l.last_payment_date, l.interest_start_date, l.loan_release_date, l.date_released, l.date_created)) > 365 THEN 1 ELSE 0 END) AS overdue_above_12
      FROM loan l
    `;

    const [rows] = await connection.execute(sql);
    const result = rows[0] || {};

    res.json({
      success: true,
      message: 'Loan dashboard summary retrieved',
      data: {
        uptodate: Number(result.uptodate) || 0,
        today_due: Number(result.today_due) || 0,
        pending: Number(result.pending) || 0,
        overdue_1_3: Number(result.overdue_1_3) || 0,
        overdue_3_6: Number(result.overdue_3_6) || 0,
        overdue_6_12: Number(result.overdue_6_12) || 0,
        overdue_above_12: Number(result.overdue_above_12) || 0,
        closed: Number(result.closed) || 0,
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Get dashboard root summary error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch dashboard summary',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

// Generic per-card metric endpoint
// Example: GET /api/loans/dashboard/metric?name=total_disbursed
// Returns: { success: true, metric: 'total_disbursed', value: 123 }
router.get('/metric', async (req, res) => {
  let connection = null;
  try {
    const { name } = req.query;
    if (!name) return res.status(400).json({ success: false, message: 'Metric name is required' });

    connection = await pool.getConnection();
    const lowerName = String(name).toLowerCase();

    switch (lowerName) {
      case 'total_disbursed': {
        const [rows] = await connection.execute('SELECT COALESCE(SUM(amount), 0) AS value FROM loan WHERE date_released IS NOT NULL');
        return res.json({ success: true, metric: lowerName, value: Number(rows[0].value || 0) });
      }
      case 'total_collected': {
        const [rows] = await connection.execute("SELECT COALESCE(SUM(r.receipt_amount),0) AS value FROM payment p JOIN receipts r ON r.payment_id = p.payment_id WHERE r.status = 'issued'");
        return res.json({ success: true, metric: lowerName, value: Number(rows[0].value || 0) });
      }
      case 'total_profit': {
        const [collected] = await connection.execute("SELECT COALESCE(SUM(r.receipt_amount),0) AS value FROM payment p JOIN receipts r ON r.payment_id = p.payment_id WHERE r.status = 'issued'");
        const [disbursed] = await connection.execute('SELECT COALESCE(SUM(amount),0) AS value FROM loan WHERE date_released IS NOT NULL');
        const profit = Number(collected[0].value || 0) - Number(disbursed[0].value || 0);
        return res.json({ success: true, metric: lowerName, value: Number(profit || 0) });
      }
      case 'total_customers': {
        const [rows] = await connection.execute('SELECT COUNT(*) AS value FROM customer_loan');
        return res.json({ success: true, metric: lowerName, value: Number(rows[0].value || 0) });
      }
      case 'repeat_customers': {
        const [rows] = await connection.execute("SELECT COUNT(*) AS value FROM borrower b WHERE (SELECT COUNT(DISTINCT borrower_id) FROM borrower WHERE customer_id = b.customer_id) > 1");
        return res.json({ success: true, metric: lowerName, value: Number(rows[0].value || 0) });
      }
      case 'total_loans': {
        const [rows] = await connection.execute('SELECT COUNT(*) AS value FROM loan');
        return res.json({ success: true, metric: lowerName, value: Number(rows[0].value || 0) });
      }
      case 'active_loans': {
        // Status 2 is used as active/released in other endpoints
        const [rows] = await connection.execute('SELECT COUNT(*) AS value FROM loan WHERE status = 2');
        return res.json({ success: true, metric: lowerName, value: Number(rows[0].value || 0) });
      }
      case 'uptodate_loans':
      case 'today_due_loans':
      case 'pending_loans':
      case 'overdue_1_3_loans':
      case 'overdue_3_6_loans':
      case 'overdue_6_12_loans':
      case 'overdue_above_12_loans':
      case 'closed_loans': {
        // Reuse the aggregated SQL and map accordingly
        const aggSql = `
          SELECT
            SUM(CASE WHEN l.status = 1 THEN 1 ELSE 0 END) AS pending,
            SUM(CASE WHEN l.status = 3 THEN 1 ELSE 0 END) AS closed,
            SUM(CASE WHEN l.status = 2 AND DATEDIFF(CURDATE(), COALESCE(l.last_payment_date, l.interest_start_date, l.loan_release_date, l.date_released, l.date_created)) <= 30 THEN 1 ELSE 0 END) AS uptodate,
            SUM(CASE WHEN l.status = 2 AND DATEDIFF(CURDATE(), COALESCE(l.last_payment_date, l.interest_start_date, l.loan_release_date, l.date_released, l.date_created)) = 30 THEN 1 ELSE 0 END) AS today_due,
            SUM(CASE WHEN l.status = 2 AND DATEDIFF(CURDATE(), COALESCE(l.last_payment_date, l.interest_start_date, l.loan_release_date, l.date_released, l.date_created)) BETWEEN 31 AND 90 THEN 1 ELSE 0 END) AS overdue_1_3,
            SUM(CASE WHEN l.status = 2 AND DATEDIFF(CURDATE(), COALESCE(l.last_payment_date, l.interest_start_date, l.loan_release_date, l.date_released, l.date_created)) BETWEEN 91 AND 180 THEN 1 ELSE 0 END) AS overdue_3_6,
            SUM(CASE WHEN l.status = 2 AND DATEDIFF(CURDATE(), COALESCE(l.last_payment_date, l.interest_start_date, l.loan_release_date, l.date_released, l.date_created)) BETWEEN 181 AND 365 THEN 1 ELSE 0 END) AS overdue_6_12,
            SUM(CASE WHEN l.status = 2 AND DATEDIFF(CURDATE(), COALESCE(l.last_payment_date, l.interest_start_date, l.loan_release_date, l.date_released, l.date_created)) > 365 THEN 1 ELSE 0 END) AS overdue_above_12
          FROM loan l
        `;
        const [rows] = await connection.execute(aggSql);
        const r = rows[0] || {};
        let key = '';
        switch (lowerName) {
          case 'uptodate_loans': key = 'uptodate'; break;
          case 'today_due_loans': key = 'today_due'; break;
          case 'pending_loans': key = 'pending'; break;
          case 'overdue_1_3_loans': key = 'overdue_1_3'; break;
          case 'overdue_3_6_loans': key = 'overdue_3_6'; break;
          case 'overdue_6_12_loans': key = 'overdue_6_12'; break;
          case 'overdue_above_12_loans': key = 'overdue_above_12'; break;
          case 'closed_loans': key = 'closed'; break;
        }
        return res.json({ success: true, metric: lowerName, value: Number(r[key] || 0) });
      }
      case 'todays_payments': {
        const [rows] = await connection.execute("SELECT COALESCE(SUM(actual_amount),0) AS value FROM payment WHERE DATE(payment_date) = CURDATE()");
        return res.json({ success: true, metric: lowerName, value: Number(rows[0].value || 0) });
      }
      case 'pending_repayments': {
        // Pending repayments amount sums payments with status 'pending'
        const [rows] = await connection.execute("SELECT COALESCE(SUM(r.receipt_amount),0) AS value FROM payment p JOIN receipts r ON r.payment_id = p.payment_id WHERE r.status = 'pending'");
        return res.json({ success: true, metric: lowerName, value: Number(rows[0].value || 0) });
      }
      default:
        return res.status(400).json({ success: false, message: 'Unknown metric name' });
    }
  } catch (error) {
    logger.error('Get metric error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch metric', error: process.env.NODE_ENV === 'development' ? error.message : undefined });
  } finally {
    if (connection) connection.release();
  }
});

// Per-card endpoints (dedicated routes) with caching
router.get('/total-disbursed', async (req, res) => {
  try {
    const key = 'total_disbursed';
    const cached = getCachedMetric(key);
    if (cached !== null) return res.json({ success: true, value: cached });
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.execute('SELECT COALESCE(SUM(amount),0) AS value FROM loan WHERE date_released IS NOT NULL');
      const value = Number(rows[0].value || 0);
      setCachedMetric(key, value);
      return res.json({ success: true, value });
    } finally { connection.release(); }
  } catch (error) {
    logger.error('total-disbursed error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch total disbursed' });
  }
});

router.get('/total-collected', async (req, res) => {
  try {
    const key = 'total_collected';
    const cached = getCachedMetric(key);
    if (cached !== null) return res.json({ success: true, value: cached });
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.execute("SELECT COALESCE(SUM(r.receipt_amount),0) AS value FROM payment p JOIN receipts r ON r.payment_id = p.payment_id WHERE r.status = 'issued'");
      const value = Number(rows[0].value || 0);
      setCachedMetric(key, value);
      return res.json({ success: true, value });
    } finally { connection.release(); }
  } catch (error) {
    logger.error('total-collected error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch total collected' });
  }
});

router.get('/total-profit', async (req, res) => {
  try {
    const key = 'total_profit';
    const cached = getCachedMetric(key);
    if (cached !== null) return res.json({ success: true, value: cached });
    const connection = await pool.getConnection();
    try {
      const [collected] = await connection.execute("SELECT COALESCE(SUM(r.receipt_amount),0) AS value FROM payment p JOIN receipts r ON r.payment_id = p.payment_id WHERE r.status = 'issued'");
      const [disbursed] = await connection.execute('SELECT COALESCE(SUM(amount),0) AS value FROM loan WHERE date_released IS NOT NULL');
      const value = Number(collected[0].value || 0) - Number(disbursed[0].value || 0);
      setCachedMetric(key, value);
      return res.json({ success: true, value });
    } finally { connection.release(); }
  } catch (error) {
    logger.error('total-profit error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch total profit' });
  }
});

router.get('/total-customers', async (req, res) => {
  try {
    const key = 'total_customers';
    const cached = getCachedMetric(key);
    if (cached !== null) return res.json({ success: true, value: cached });
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.execute('SELECT COUNT(*) AS value FROM customer_loan');
      const value = Number(rows[0].value || 0);
      setCachedMetric(key, value);
      return res.json({ success: true, value });
    } finally { connection.release(); }
  } catch (error) {
    logger.error('total-customers error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch total customers' });
  }
});

router.get('/repeat-customers', async (req, res) => {
  try {
    const key = 'repeat_customers';
    const cached = getCachedMetric(key);
    if (cached !== null) return res.json({ success: true, value: cached });
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.execute("SELECT COUNT(*) AS value FROM borrower b WHERE (SELECT COUNT(DISTINCT borrower_id) FROM borrower WHERE customer_id = b.customer_id) > 1");
      const value = Number(rows[0].value || 0);
      setCachedMetric(key, value);
      return res.json({ success: true, value });
    } finally { connection.release(); }
  } catch (error) {
    logger.error('repeat-customers error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch repeat customers' });
  }
});

router.get('/total-loans', async (req, res) => {
  try {
    const key = 'total_loans';
    const cached = getCachedMetric(key);
    if (cached !== null) return res.json({ success: true, value: cached });
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.execute('SELECT COUNT(*) AS value FROM loan');
      const value = Number(rows[0].value || 0);
      setCachedMetric(key, value);
      return res.json({ success: true, value });
    } finally { connection.release(); }
  } catch (error) {
    logger.error('total-loans error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch total loans' });
  }
});

router.get('/active-loans', async (req, res) => {
  try {
    const key = 'active_loans';
    const cached = getCachedMetric(key);
    if (cached !== null) return res.json({ success: true, value: cached });
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.execute('SELECT COUNT(*) AS value FROM loan WHERE status = 2');
      const value = Number(rows[0].value || 0);
      setCachedMetric(key, value);
      return res.json({ success: true, value });
    } finally { connection.release(); }
  } catch (error) {
    logger.error('active-loans error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch active loans' });
  }
});

// Reuse aggregated SQL for overdue buckets
const AGG_OVERVIEW_SQL = `
  SELECT
    SUM(CASE WHEN l.status = 1 THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN l.status = 3 THEN 1 ELSE 0 END) AS closed,
    SUM(CASE WHEN l.status = 2 AND DATEDIFF(CURDATE(), COALESCE(l.last_payment_date, l.interest_start_date, l.loan_release_date, l.date_released, l.date_created)) <= 30 THEN 1 ELSE 0 END) AS uptodate,
    SUM(CASE WHEN l.status = 2 AND DATEDIFF(CURDATE(), COALESCE(l.last_payment_date, l.interest_start_date, l.loan_release_date, l.date_released, l.date_created)) = 30 THEN 1 ELSE 0 END) AS today_due,
    SUM(CASE WHEN l.status = 2 AND DATEDIFF(CURDATE(), COALESCE(l.last_payment_date, l.interest_start_date, l.loan_release_date, l.date_released, l.date_created)) BETWEEN 31 AND 90 THEN 1 ELSE 0 END) AS overdue_1_3,
    SUM(CASE WHEN l.status = 2 AND DATEDIFF(CURDATE(), COALESCE(l.last_payment_date, l.interest_start_date, l.loan_release_date, l.date_released, l.date_created)) BETWEEN 91 AND 180 THEN 1 ELSE 0 END) AS overdue_3_6,
    SUM(CASE WHEN l.status = 2 AND DATEDIFF(CURDATE(), COALESCE(l.last_payment_date, l.interest_start_date, l.loan_release_date, l.date_released, l.date_created)) BETWEEN 181 AND 365 THEN 1 ELSE 0 END) AS overdue_6_12,
    SUM(CASE WHEN l.status = 2 AND DATEDIFF(CURDATE(), COALESCE(l.last_payment_date, l.interest_start_date, l.loan_release_date, l.date_released, l.date_created)) > 365 THEN 1 ELSE 0 END) AS overdue_above_12
  FROM loan l
`;

router.get('/uptodate-loans', async (req, res) => {
  try {
    const key = 'uptodate_loans';
    const cached = getCachedMetric(key);
    if (cached !== null) return res.json({ success: true, value: cached });
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.execute(AGG_OVERVIEW_SQL);
      const value = Number(rows[0].uptodate || 0);
      setCachedMetric(key, value);
      return res.json({ success: true, value });
    } finally { connection.release(); }
  } catch (error) {
    logger.error('uptodate-loans error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch uptodate loans' });
  }
});

router.get('/today-due-loans', async (req, res) => {
  try {
    const key = 'today_due_loans';
    const cached = getCachedMetric(key);
    if (cached !== null) return res.json({ success: true, value: cached });
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.execute(AGG_OVERVIEW_SQL);
      const value = Number(rows[0].today_due || 0);
      setCachedMetric(key, value);
      return res.json({ success: true, value });
    } finally { connection.release(); }
  } catch (error) {
    logger.error('today-due-loans error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch today due loans' });
  }
});

router.get('/pending-loans', async (req, res) => {
  try {
    const key = 'pending_loans';
    const cached = getCachedMetric(key);
    if (cached !== null) return res.json({ success: true, value: cached });
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.execute(AGG_OVERVIEW_SQL);
      const value = Number(rows[0].pending || 0);
      setCachedMetric(key, value);
      return res.json({ success: true, value });
    } finally { connection.release(); }
  } catch (error) {
    logger.error('pending-loans error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch pending loans' });
  }
});

router.get('/closed-loans', async (req, res) => {
  try {
    const key = 'closed_loans';
    const cached = getCachedMetric(key);
    if (cached !== null) return res.json({ success: true, value: cached });
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.execute(AGG_OVERVIEW_SQL);
      const value = Number(rows[0].closed || 0);
      setCachedMetric(key, value);
      return res.json({ success: true, value });
    } finally { connection.release(); }
  } catch (error) {
    logger.error('closed-loans error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch closed loans' });
  }
});

router.get('/overdue-1-3-loans', async (req, res) => {
  try {
    const key = 'overdue_1_3_loans';
    const cached = getCachedMetric(key);
    if (cached !== null) return res.json({ success: true, value: cached });
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.execute(AGG_OVERVIEW_SQL);
      const value = Number(rows[0].overdue_1_3 || 0);
      setCachedMetric(key, value);
      return res.json({ success: true, value });
    } finally { connection.release(); }
  } catch (error) {
    logger.error('overdue-1-3-loans error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch overdue 1-3 loans' });
  }
});

router.get('/overdue-3-6-loans', async (req, res) => {
  try {
    const key = 'overdue_3_6_loans';
    const cached = getCachedMetric(key);
    if (cached !== null) return res.json({ success: true, value: cached });
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.execute(AGG_OVERVIEW_SQL);
      const value = Number(rows[0].overdue_3_6 || 0);
      setCachedMetric(key, value);
      return res.json({ success: true, value });
    } finally { connection.release(); }
  } catch (error) {
    logger.error('overdue-3-6-loans error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch overdue 3-6 loans' });
  }
});

router.get('/overdue-6-12-loans', async (req, res) => {
  try {
    const key = 'overdue_6_12_loans';
    const cached = getCachedMetric(key);
    if (cached !== null) return res.json({ success: true, value: cached });
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.execute(AGG_OVERVIEW_SQL);
      const value = Number(rows[0].overdue_6_12 || 0);
      setCachedMetric(key, value);
      return res.json({ success: true, value });
    } finally { connection.release(); }
  } catch (error) {
    logger.error('overdue-6-12-loans error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch overdue 6-12 loans' });
  }
});

router.get('/overdue-above-12-loans', async (req, res) => {
  try {
    const key = 'overdue_above_12_loans';
    const cached = getCachedMetric(key);
    if (cached !== null) return res.json({ success: true, value: cached });
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.execute(AGG_OVERVIEW_SQL);
      const value = Number(rows[0].overdue_above_12 || 0);
      setCachedMetric(key, value);
      return res.json({ success: true, value });
    } finally { connection.release(); }
  } catch (error) {
    logger.error('overdue-above-12-loans error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch overdue above 12 loans' });
  }
});

// Today's payments and pending repayments
router.get('/todays-payments', async (req, res) => {
  try {
    const key = 'todays_payments';
    const cached = getCachedMetric(key);
    if (cached !== null) return res.json({ success: true, value: cached });
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.execute("SELECT COALESCE(SUM(actual_amount),0) AS value FROM payment WHERE DATE(payment_date) = CURDATE()");
      const value = Number(rows[0].value || 0);
      setCachedMetric(key, value);
      return res.json({ success: true, value });
    } finally { connection.release(); }
  } catch (error) {
    logger.error('todays-payments error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch today\'s payments' });
  }
});

router.get('/pending-repayments', async (req, res) => {
  try {
    const key = 'pending_repayments';
    const cached = getCachedMetric(key);
    if (cached !== null) return res.json({ success: true, value: cached });
    const connection = await pool.getConnection();
    try {
      const [rows] = await connection.execute("SELECT COALESCE(SUM(r.receipt_amount),0) AS value FROM payment p JOIN receipts r ON r.payment_id = p.payment_id WHERE r.status = 'pending'");
      const value = Number(rows[0].value || 0);
      setCachedMetric(key, value);
      return res.json({ success: true, value });
    } finally { connection.release(); }
  } catch (error) {
    logger.error('pending-repayments error:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch pending repayments' });
  }
});

module.exports = router;
