const logger = require('../utils/logger');

/**
 * BalanceService
 * Provides utility methods to get and update the system wallet balance
 * and to insert transaction records in the `transactions` table.
 */
class BalanceService {
  static async getCurrentBalance(connection) {
    try {
      const [rows] = await connection.execute("SELECT setting_value FROM settings WHERE setting_name = 'current_balance' LIMIT 1");
      if (!rows || rows.length === 0) return 0;
      return parseFloat(rows[0].setting_value) || 0;
    } catch (error) {
      logger.error('BalanceService.getCurrentBalance error:', error.message);
      return 0;
    }
  }

  /**
   * Update the wallet balance by adding the amount (positive for deposit, negative for withdrawal)
   */
  // transactionType: optional string; if provided, it will be used as transaction_type in the inserted record
  // loanId: optional integer: if provided, it will be saved to the transactions record
  static async updateWalletBalance(connection, amount, description = '', referenceId = null, username = null, transactionType = null, loanId = null, transactionDate = null) {
    // Declare control variables in scope so they are accessible in catch blocks
    let savepointName = null;
    let createdNewTransaction = false;
    let savepointUsed = false;
    try {
      // Use a savepoint if the caller already started a transaction, otherwise begin a transaction.
      savepointName = `sp_balance_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
      try {
        // Attempt to create a savepoint (works if there's an active transaction)
        await connection.query(`SAVEPOINT ${savepointName}`);
        savepointUsed = true;
      } catch (spErr) {
        // No active transaction, create our own
        await connection.beginTransaction();
        createdNewTransaction = true;
      }
      // Debug log the transaction state
      logger.dev('BalanceService.updateWalletBalance:', { savepointUsed, createdNewTransaction, savepointName });

      // Ensure settings table has current_balance and acquire a row lock for concurrency safety
      const [balanceRows] = await connection.execute("SELECT setting_value FROM settings WHERE setting_name = 'current_balance' LIMIT 1 FOR UPDATE");
      let currentBalance = 0;
      if (!balanceRows || balanceRows.length === 0) {
        await connection.execute("INSERT INTO settings (setting_name, setting_value) VALUES ('current_balance', '0.00')");
        // re-select to get locked row
        const [reRows] = await connection.execute("SELECT setting_value FROM settings WHERE setting_name = 'current_balance' LIMIT 1 FOR UPDATE");
        if (reRows && reRows.length > 0) currentBalance = parseFloat(reRows[0].setting_value) || 0;
      } else {
        currentBalance = parseFloat(balanceRows[0].setting_value) || 0;
      }

      // Decide sign for the amount based on provided transactionType. If transactionType is supplied, infer sign
      // deposit -> positive, others (loan, expense, withdrawal) -> negative
      let amountToApply = parseFloat(amount);
      if (transactionType && typeof transactionType === 'string') {
        if (transactionType.toLowerCase() === 'deposit') amountToApply = Math.abs(parseFloat(amount));
        else amountToApply = -Math.abs(parseFloat(amount));
      }
      const newBalance = currentBalance + amountToApply;

      // Update settings (atomic because we hold a FOR UPDATE lock)
      await connection.execute("UPDATE settings SET setting_value = ? WHERE setting_name = 'current_balance'", [newBalance.toString()]);

      // Ensure transactions table exists and proper columns
      await connection.execute(`
        CREATE TABLE IF NOT EXISTS transactions (
          transaction_id INT(11) NOT NULL AUTO_INCREMENT PRIMARY KEY,
          loan_id INT(11) DEFAULT NULL,
          transaction_date DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
          transaction_type ENUM('deposit','loan','expense','withdrawal') NOT NULL,
          amount DECIMAL(10,2) NOT NULL,
          description VARCHAR(255) NOT NULL,
          reference_id VARCHAR(50) DEFAULT NULL,
          reference_no VARCHAR(100) DEFAULT NULL,
          balance_before DECIMAL(10,2) NOT NULL,
          balance_after DECIMAL(10,2) NOT NULL,
          created_by VARCHAR(100) DEFAULT NULL,
          status ENUM('completed','pending','failed') DEFAULT 'pending'
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
      `);

      const date = transactionDate ? new Date(transactionDate) : new Date();
      const chosenType = transactionType || (amountToApply >= 0 ? 'deposit' : 'withdrawal');
      const reference = referenceId || `${(chosenType || 'txn').toString().toUpperCase()}-${Date.now()}`;

      const [insertRes] = await connection.execute(`
        INSERT INTO transactions (transaction_date, transaction_type, amount, description, reference_id, reference_no, balance_before, balance_after, created_by, status, loan_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `, [date, chosenType, Math.abs(parseFloat(amountToApply)), description, reference, reference, currentBalance, newBalance, username || null, 'completed', loanId || null]);
      const insertId = (insertRes && insertRes.insertId) ? insertRes.insertId : null;
      logger.dev('Inserted transaction:', { insertId, transactionType: chosenType, amount: amountToApply, description, reference, loanId, balance_before: currentBalance, balance_after: newBalance });
      // Release or commit
      try {
        if (savepointUsed) {
          // Releasing savepoint is a no-op for outer transaction, ignore errors on release
          try {
            await connection.query(`RELEASE SAVEPOINT ${savepointName}`);
          } catch (releaseErr) {
            logger.warn('Failed to release savepoint (non-fatal):', releaseErr.message || releaseErr);
          }
        } else if (createdNewTransaction) {
          await connection.commit();
        }
      } catch (commitErr) {
        // If commit fails, attempt rollback to savepoint/transaction, but don't mask previously successful insert
        logger.error('Commit/Release failed:', commitErr.message || commitErr);
        try {
          if (savepointUsed) {
            await connection.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
            await connection.query(`RELEASE SAVEPOINT ${savepointName}`);
          } else if (createdNewTransaction) {
            await connection.rollback();
          }
        } catch (rbErr) {
          logger.warn('Rollback after commit failure also failed (non-fatal):', rbErr.message || rbErr);
        }
        // Return failure but include meaningful message, caller can decide behavior
        return { success: false, message: commitErr.message || 'Failed to commit balance update' };
      }

      return { success: true, newBalance, transactionId: insertId };
    } catch (error) {
      // Log full error for easier debugging (sql errors will show sqlMessage and stack)
      logger.error('BalanceService.updateWalletBalance error:', error && error.stack ? error.stack : error);
      // Attempt rollback based on our control variables if an error occurs
      try {
        if (savepointUsed) {
          await connection.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);
          await connection.query(`RELEASE SAVEPOINT ${savepointName}`);
        } else if (createdNewTransaction) {
          await connection.rollback();
        }
      } catch (rb) {
        // ignore rollback failure
      }
      return { success: false, message: error.message || 'Failed to update balance' };
    }
  }
}

module.exports = { BalanceService };
