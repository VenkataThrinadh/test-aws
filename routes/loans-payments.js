/**
 * Payments API Routes
 * 
 * Manages payment records for loans
 * 
 * Routes:
 *   GET    /api/loans/payments            - Get all payments
 *   POST   /api/loans/payments            - Record payment
 *   GET    /api/loans/payments/:id        - Get payment details
 *   PUT    /api/loans/payments/:id        - Update payment
 *   DELETE /api/loans/payments/:id        - Delete payment
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const logger = require('../utils/logger');
const PDFDocument = require('pdfkit');
const { BalanceService } = require('../services/balanceService');

router.get('/', async (req, res) => {
  let connection = null;
  try {
    const { loan_id, page = 1, limit = 10 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    connection = await pool.getConnection();

    let whereClause = 'WHERE 1=1';
    const queryParams = [];

    if (loan_id) {
      whereClause += ' AND loan_id = ?';
      queryParams.push(loan_id);
    }

    const countQuery = `SELECT COUNT(*) as total FROM payment ${whereClause}`;
    const [countRows] = await connection.execute(countQuery, queryParams);
    const totalItems = countRows[0].total;

    const dataQuery = `
      SELECT p.payment_id, p.loan_id, p.borrower_id, p.payment_date, p.actual_amount, p.interest_amount, p.reduction_amount, p.remaining_interest_after_payment, p.payment_mode, p.receipt_no, p.date_created,
             b.ref_no AS borrower_ref_no, b.full_name AS borrower_name, b.customer_id AS borrower_customer_id
      FROM payment p
      LEFT JOIN borrower b ON p.borrower_id = b.borrower_id
      ${whereClause}
      ORDER BY p.payment_date DESC
      LIMIT ? OFFSET ?
    `;

    const [rows] = await connection.execute(dataQuery, [...queryParams, Number(limit), offset]);
    const totalPages = Math.ceil(totalItems / Number(limit));

    res.json({
      success: true,
      message: 'Payments retrieved successfully',
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
    logger.error('Get payments error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payments',
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
      return res.status(400).json({ success: false, message: 'Valid payment ID required', timestamp: new Date().toISOString() });
    }

    connection = await pool.getConnection();
    const [rows] = await connection.execute(
      `SELECT p.*, b.ref_no AS borrower_ref_no, b.full_name AS borrower_name, b.customer_id AS borrower_customer_id, l.ref_no AS loan_ref_no
       FROM payment p
       LEFT JOIN borrower b ON p.borrower_id = b.borrower_id
       LEFT JOIN loan l ON p.loan_id = l.loan_id
       WHERE p.payment_id = ?`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Payment not found', timestamp: new Date().toISOString() });
    }

    res.json({
      success: true,
      message: 'Payment retrieved successfully',
      data: rows[0],
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Get payment error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch payment',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

// Generate and stream a PDF receipt for a payment
router.get('/:id/receipt-pdf', async (req, res) => {
  let connection = null;
  try {
    const { id } = req.params;
    if (!id || isNaN(Number(id))) {
      return res.status(400).json({ success: false, message: 'Valid payment ID required', timestamp: new Date().toISOString() });
    }

    connection = await pool.getConnection();
    const [rows] = await connection.execute(
      `SELECT p.*, b.ref_no AS borrower_ref_no, b.full_name AS borrower_name, b.customer_id AS borrower_customer_id, l.ref_no AS loan_ref_no, l.amount AS loan_amount
       FROM payment p
       LEFT JOIN borrower b ON p.borrower_id = b.borrower_id
       LEFT JOIN loan l ON p.loan_id = l.loan_id
       WHERE p.payment_id = ?`,
      [id]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Payment not found', timestamp: new Date().toISOString() });
    }

    const payment = rows[0];

    // Set headers for PDF download
    const filename = `receipt_${payment.receipt_no || payment.payment_id}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // Create PDF and stream to response (refined layout)
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    doc.pipe(res);

    // Helpers
    const fmt = (v) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 }).format(Number(v || 0));
    const accent = '#D4AF37';

    // Page metrics
    const left = doc.page.margins.left;
    const right = doc.page.width - doc.page.margins.right;
    const pageWidth = right - left;

    // Title centered in gold
    doc.fillColor(accent).fontSize(20).font('Helvetica-Bold').text('PAYMENT RECEIPT', left, 60, { align: 'center' });

    // Date box top-right (outlined box with small text)
    const dateText = payment.payment_date ? new Date(payment.payment_date).toLocaleDateString('en-GB') : new Date().toLocaleDateString('en-GB');
    const dateBoxW = 110;
    const dateBoxH = 26;
    const dateBoxX = right - dateBoxW;
    const dateBoxY = 56;
    doc.save();
    doc.roundedRect(dateBoxX, dateBoxY, dateBoxW, dateBoxH, 4).lineWidth(1).stroke('#DDDDDD');
    doc.fontSize(10).fillColor('#000').font('Helvetica');
    doc.text(`Date: ${dateText}`, dateBoxX + 8, dateBoxY + 6, { width: dateBoxW - 16, align: 'left' });
    doc.restore();

    // Left column: Name and Receipt No aligned like reference
    const metaX = left;
    const metaY = dateBoxY + dateBoxH + 12;
    doc.fontSize(11).fillColor('#000').font('Helvetica-Bold');
    doc.text('Name: ', metaX, metaY, { continued: true });
    doc.font('Helvetica');
    doc.text(payment.borrower_name || '', { continued: false });
    doc.moveDown(0.2);
    doc.font('Helvetica-Bold');
    doc.text('Receipt No: ', { continued: true });
    doc.font('Helvetica');
    doc.text(payment.receipt_no || `RCPT${payment.payment_id || ''}`);

    // Table layout
    const tableTop = doc.y + 12;
    const tableLeft = left;
    const tableWidth = pageWidth;
    const colDescWidth = Math.floor(tableWidth * 0.7);
    const colAmtWidth = tableWidth - colDescWidth;
    const rowH = 30;

    // Draw header row background and borders
    doc.rect(tableLeft, tableTop, tableWidth, rowH).fill('#F6F6F6').stroke('#E0E0E0');
    doc.fillColor('#333').fontSize(11).font('Helvetica-Bold');
    doc.text('Description', tableLeft + 10, tableTop + 9, { width: colDescWidth - 20 });
    doc.text('Amount', tableLeft + colDescWidth + 6, tableTop + 9, { width: colAmtWidth - 16, align: 'right' });

    // Rows - convert decimal values to proper numbers first
    const principalVal = parseFloat(String(payment.actual_amount || 0).replace(/[^\d.-]/g, '')) || 0;
    const interestVal = parseFloat(String(payment.interest_amount || 0).replace(/[^\d.-]/g, '')) || 0;
    const reductionVal = parseFloat(String(payment.reduction_amount || 0).replace(/[^\d.-]/g, '')) || 0;

    const tableRows = [
      { label: 'Principal Amount', value: principalVal },
      { label: 'Interest Amount', value: interestVal },
      { label: 'Reduction Amount', value: reductionVal }
    ];

    let currentY = tableTop + rowH;
    for (let i = 0; i < tableRows.length; i++) {
      // row background (white) and separator line
      doc.rect(tableLeft, currentY, tableWidth, rowH).fill('#FFFFFF').stroke('#EEEEEE');
      doc.fillColor('#000').fontSize(11).font('Helvetica');
      doc.text(tableRows[i].label, tableLeft + 10, currentY + 9, { width: colDescWidth - 20 });
      doc.text(fmt(tableRows[i].value), tableLeft + colDescWidth + 6, currentY + 9, { width: colAmtWidth - 16, align: 'right' });
      currentY += rowH;
    }

    // Total row - highlighted
    doc.rect(tableLeft, currentY, tableWidth, rowH).fill('#F0F0F0').stroke('#CCCCCC');
    const principal = principalVal;
    const interest = interestVal;
    const reduction = reductionVal;
    const total = principal + interest - reduction;
    doc.fillColor('#000').fontSize(12).font('Helvetica-Bold');
    doc.text('Total Paid', tableLeft + 10, currentY + 7, { width: colDescWidth - 20 });
    doc.text(fmt(total), tableLeft + colDescWidth + 6, currentY + 7, { width: colAmtWidth - 16, align: 'right' });

    // Move below table
    doc.y = currentY + rowH + 18;

    // Remaining principal calc (reuse previous logic)
    let remainingPrincipal = 0;
    try {
      if (payment.loan_id) {
        const [agg] = await connection.execute(
          `SELECT COALESCE(SUM(actual_amount - interest_amount - reduction_amount), 0) AS principal_paid FROM payment WHERE loan_id = ?`,
          [payment.loan_id]
        );
        const principalPaid = Number((agg && agg[0] && (agg[0].principal_paid !== undefined ? agg[0].principal_paid : agg.principal_paid)) || 0);
        const loanAmount = Number(payment.loan_amount || 0);
        remainingPrincipal = Math.max(0, loanAmount - principalPaid);
      }
    } catch (e) {
      remainingPrincipal = 0;
    }

    // Payment method and remaining principal - styled like reference
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#000');
    doc.text('Payment Method: ', left, doc.y, { continued: true });
    doc.font('Helvetica');
    doc.text((payment.payment_mode || 'Cash'));
    doc.moveDown(0.6);
    const remainingPrincipalNumeric = parseFloat(String(remainingPrincipal || 0).replace(/[^\d.-]/g, '')) || 0;
    doc.font('Helvetica-Bold');
    doc.text('Remaining Principal: ', { continued: true });
    doc.font('Helvetica');
    doc.text(fmt(remainingPrincipalNumeric));

    // Footer timestamp right-aligned
    doc.fontSize(9).fillColor('#777').text(`Generated on ${new Date().toLocaleString('en-GB')}`, left, doc.page.height - doc.page.margins.bottom - 18, { width: pageWidth, align: 'right' });

    doc.end();
  } catch (error) {
    logger.error('Generate receipt PDF error:', error);
    if (res.headersSent) {
      // If headers already sent, we can't change response code
      return;
    }
    res.status(500).json({ success: false, message: 'Failed to generate receipt PDF', error: process.env.NODE_ENV === 'development' ? error.message : undefined, timestamp: new Date().toISOString() });
  } finally {
    if (connection) connection.release();
  }
});

/**
 * GET /api/loans/payments/calculate-overdue/:loanId
 * Calculate overdue interest for a loan and update loan.remaining_interest
 */
router.get('/calculate-overdue/:loanId', async (req, res) => {
  let connection = null;
  try {
    const { loanId } = req.params;
    if (!loanId || isNaN(Number(loanId))) {
      return res.status(400).json({ success: false, message: 'Valid loanId required', timestamp: new Date().toISOString() });
    }

    connection = await pool.getConnection();

    // Fetch loan + aggregated payments info
    const [rows] = await connection.execute(
      `SELECT l.loan_id, l.amount, l.active_interest_rate, l.remaining_interest, l.date_released,
              COALESCE(MAX(p.payment_date), NULL) AS last_payment_date,
              COALESCE(SUM(p.actual_amount - p.interest_amount - p.reduction_amount), 0) AS principal_paid
       FROM loan l
       LEFT JOIN payment p ON p.loan_id = l.loan_id
       WHERE l.loan_id = ?
       GROUP BY l.loan_id`,
      [loanId]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Loan not found', timestamp: new Date().toISOString() });
    }

    const loan = rows[0];
    const amount = Number(loan.amount || 0);
    const principalPaid = Number(loan.principal_paid || 0);
    const remainingPrincipal = Math.max(0, amount - principalPaid);

    // Determine last payment date or use date_released
    const lastPaymentDate = loan.last_payment_date ? new Date(loan.last_payment_date) : null;
    const baseDate = lastPaymentDate || (loan.date_released ? new Date(loan.date_released) : null);
    if (!baseDate) {
      return res.status(400).json({ success: false, message: 'Cannot determine base date for overdue calculation', timestamp: new Date().toISOString() });
    }

    const today = new Date();
    const diffTime = today.setHours(0,0,0,0) - baseDate.setHours(0,0,0,0);
    const days = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    if (days <= 0) {
      return res.json({ success: true, message: 'No overdue days to calculate', overdue_days: days, current_interest: 0, total_overdue_interest: Number(loan.remaining_interest || 0), timestamp: new Date().toISOString() });
    }

    const rate = Number(loan.active_interest_rate || 0);
    const dailyRate = rate / 100 / 365;
    // daily interest on remaining principal
    const dailyInterest = Math.round(remainingPrincipal * dailyRate * 100) / 100;
    const currentInterest = Math.round(remainingPrincipal * dailyRate * days * 100) / 100;

    // Update loan.remaining_interest and last_interest_update
    const existingRemainingInterest = Number(loan.remaining_interest || 0);
    const newRemainingInterest = Math.round(((existingRemainingInterest + currentInterest) * 100)) / 100;
    await connection.execute(
      `UPDATE loan SET remaining_interest = ?, last_interest_update = ? WHERE loan_id = ?`,
      [newRemainingInterest, new Date().toISOString().slice(0,10), loanId]
    );

    res.json({
      success: true,
      message: 'Overdue interest calculated',
      remaining_principal: remainingPrincipal,
      interest_rate: rate,
      overdue_days: days,
      daily_interest: dailyInterest,
      current_interest: currentInterest,
      total_overdue_interest: newRemainingInterest,
      remaining_interest: newRemainingInterest,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Calculate overdue error:', error);
    res.status(500).json({ success: false, message: 'Failed to calculate overdue', error: process.env.NODE_ENV === 'development' ? error.message : undefined, timestamp: new Date().toISOString() });
  } finally {
    if (connection) connection.release();
  }
});

router.post('/', async (req, res) => {
  let connection = null;
  try {
    const { loan_id, borrower_id, actual_amount, interest_amount, reduction_amount, payment_date, payment_mode, receipt_no } = req.body;

    if (!loan_id || (actual_amount === undefined || actual_amount === null)) {
      return res.status(400).json({
        success: false,
        message: 'Loan ID and payment amount are required',
        timestamp: new Date().toISOString()
      });
    }

    connection = await pool.getConnection();
    await connection.query('START TRANSACTION');
    const receipt = receipt_no || `RCPT${Date.now()}`;
    const [result] = await connection.execute(
      `INSERT INTO payment (loan_id, borrower_id, actual_amount, interest_amount, reduction_amount, payment_date, payment_mode, receipt_no, date_created)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [loan_id, borrower_id || null, Number(actual_amount) || 0, Number(interest_amount) || 0, Number(reduction_amount) || 0, payment_date || new Date(), payment_mode || 'cash', receipt]
    );

    const insertedId = result.insertId;

    // Fetch the inserted payment with borrower and loan info
    const [paymentRows] = await connection.execute(
      `SELECT p.payment_id, p.loan_id, p.borrower_id, p.payment_date, p.actual_amount, p.interest_amount, p.reduction_amount, p.payment_mode, p.receipt_no, p.date_created,
              b.ref_no AS borrower_ref_no, b.full_name AS borrower_name, b.customer_id AS borrower_customer_id,
              l.ref_no AS loan_ref_no, l.amount AS loan_amount, l.remaining_interest AS loan_remaining_interest
       FROM payment p
       LEFT JOIN borrower b ON p.borrower_id = b.borrower_id
       LEFT JOIN loan l ON p.loan_id = l.loan_id
       WHERE p.payment_id = ?`,
      [insertedId]
    );

    const paymentRow = (paymentRows && paymentRows[0]) || null;

    // Compute remaining principal and outstanding using aggregated payments
    let remainingPrincipal = 0;
    let remainingInterest = 0;
    let totalOutstanding = 0;
    if (paymentRow) {
      const loanId = paymentRow.loan_id;
      const [agg] = await connection.execute(
        `SELECT COALESCE(SUM(actual_amount - interest_amount - reduction_amount), 0) AS principal_paid
         FROM payment WHERE loan_id = ?`,
        [loanId]
      );

      const principalPaid = Number(agg && agg[0] && agg[0].principal_paid ? agg[0].principal_paid : (agg && agg.principal_paid) || 0);
      const loanAmount = Number(paymentRow.loan_amount || 0);
      remainingPrincipal = Math.max(0, loanAmount - principalPaid);
      remainingInterest = Number(paymentRow.loan_remaining_interest || 0);
      totalOutstanding = remainingPrincipal + remainingInterest;
    }

    // Update wallet balance for this payment (principal + interest)
    try {
      const totalPayment = Number(actual_amount || 0) + Number(interest_amount || 0);
      const description = `Payment received for loan ${loan_id}`;
      const walletUpdate = await BalanceService.updateWalletBalance(connection, totalPayment, description, receipt, req.user?.email || req.user?.id || null, 'deposit', loan_id);
      if (!walletUpdate.success) {
        throw new Error(walletUpdate.message || 'Failed to update wallet balance');
      }
      await connection.query('COMMIT');
    } catch (e) {
      await connection.query('ROLLBACK');
      throw e;
    }

    res.status(201).json({
      success: true,
      message: 'Payment recorded successfully',
      data: {
        payment_id: insertedId,
        payment_details: paymentRow,
        remaining_principal: remainingPrincipal,
        remaining_interest: remainingInterest,
        total_outstanding: totalOutstanding
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Create payment error:', error);
    try {
      if (connection) await connection.query('ROLLBACK');
    } catch (e) {
      // ignore rollback errors
    }
    res.status(500).json({
      success: false,
      message: 'Failed to record payment',
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
    const { loan_id, borrower_id, actual_amount, interest_amount, reduction_amount, payment_date, payment_mode, receipt_no } = req.body;

    if (!id || isNaN(Number(id))) {
      return res.status(400).json({ success: false, message: 'Valid payment ID required', timestamp: new Date().toISOString() });
    }

    connection = await pool.getConnection();
    await connection.query('START TRANSACTION');
    const fields = [];
    const params = [];
    if (loan_id !== undefined) { fields.push('loan_id = ?'); params.push(loan_id); }
    if (borrower_id !== undefined) { fields.push('borrower_id = ?'); params.push(borrower_id); }
    if (actual_amount !== undefined) { fields.push('actual_amount = ?'); params.push(Number(actual_amount)); }
    if (interest_amount !== undefined) { fields.push('interest_amount = ?'); params.push(Number(interest_amount)); }
    if (reduction_amount !== undefined) { fields.push('reduction_amount = ?'); params.push(Number(reduction_amount)); }
    if (payment_date !== undefined) { fields.push('payment_date = ?'); params.push(payment_date); }
    if (payment_mode !== undefined) { fields.push('payment_mode = ?'); params.push(payment_mode); }
    if (receipt_no !== undefined) { fields.push('receipt_no = ?'); params.push(receipt_no); }

    // Compute delta for wallet if actual_amount/interest_amount changed
    const [existingRows] = await connection.execute('SELECT actual_amount, interest_amount, loan_id FROM payment WHERE payment_id = ?', [id]);
    if (!existingRows || existingRows.length === 0) {
      await connection.query('ROLLBACK');
      return res.status(404).json({ success: false, message: 'Payment not found' });
    }
    const existing = existingRows[0];
    const oldTotal = Number(existing.actual_amount || 0) + Number(existing.interest_amount || 0);
    const newActual = (typeof actual_amount !== 'undefined') ? Number(actual_amount) : Number(existing.actual_amount || 0);
    const newInterest = (typeof interest_amount !== 'undefined') ? Number(interest_amount) : Number(existing.interest_amount || 0);
    const newTotal = newActual + newInterest;
    const delta = newTotal - oldTotal;
    try {
      if (fields.length > 0) {
        params.push(id);
        await connection.execute(`UPDATE payment SET ${fields.join(', ')} WHERE payment_id = ?`, params);
      }
      if (delta !== 0) {
        const walletUpdate = await BalanceService.updateWalletBalance(connection, delta, `Payment update adjustment for payment ${id}`, `PAYMENT_UPDATE_${id}_${Date.now()}`, req.user?.email || req.user?.id || null, 'deposit', existing.loan_id);
        if (!walletUpdate.success) {
          await connection.query('ROLLBACK');
          return res.status(500).json({ success: false, message: 'Failed to update wallet during payment update' });
        }
      }
      await connection.query('COMMIT');
      res.json({ success: true, message: 'Payment updated successfully', timestamp: new Date().toISOString() });
    } catch (err) {
      await connection.query('ROLLBACK');
      throw err;
    }
  } catch (error) {
    logger.error('Update payment error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update payment',
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
      return res.status(400).json({ success: false, message: 'Valid payment ID required', timestamp: new Date().toISOString() });
    }

    connection = await pool.getConnection();
    const [existingRows] = await connection.execute('SELECT actual_amount, interest_amount, loan_id FROM payment WHERE payment_id = ?', [id]);
    if (!existingRows || existingRows.length === 0) {
      return res.status(404).json({ success: false, message: 'Payment not found', timestamp: new Date().toISOString() });
    }
    const existing = existingRows[0];
    const totalPayment = Number(existing.actual_amount || 0) + Number(existing.interest_amount || 0);
    await connection.query('START TRANSACTION');
    try {
      // Revert wallet balance by subtracting the amount that was previously added
      const revert = await BalanceService.updateWalletBalance(connection, -Math.abs(totalPayment), `Revert payment ${id} deletion`, `PAYMENT_DELETE_${id}_${Date.now()}`, req.user?.email || req.user?.id || null, null, existing.loan_id);
      if (!revert.success) {
        await connection.query('ROLLBACK');
        return res.status(500).json({ success: false, message: 'Failed to revert wallet balance' });
      }
      await connection.execute('DELETE FROM payment WHERE payment_id = ?', [id]);
      await connection.query('COMMIT');
    } catch (err) {
      await connection.query('ROLLBACK');
      throw err;
    }

    res.json({
      success: true,
      message: 'Payment deleted successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Delete payment error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete payment',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
