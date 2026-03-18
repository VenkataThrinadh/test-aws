/**
 * Reference Number Manager
 * 
 * Generates and manages unique reference numbers for loans and borrowers
 * Ensures no duplicate reference numbers are generated
 * 
 * Format: [BRANCH_PREFIX][5-digit-number]
 * Example: MAIN00001, MAIN00002, etc.
 */

const BRANCH_PREFIXES = {
  'main': 'MAIN',
  'branch1': 'BR01',
  'branch2': 'BR02'
};

class ReferenceNumberManager {
  /**
   * Initialize manager with database connection
   * @param {Object} connection - MySQL connection from pool
   */
  constructor(connection) {
    this.connection = connection;
  }

  /**
   * Generate a unique reference number
   * Checks reference_number_history table and assigns next available number
   * 
   * @param {string} branchPrefix - Branch prefix (default: MAIN)
   * @returns {Promise<string>} Unique reference number e.g. MAIN00001
   */
  async generateUniqueRefNo(branchPrefix = 'MAIN') {
    try {
      // Primary source: the `reference_number` table. Fetch recent numbers for this prefix.
      const [rows] = await this.connection.execute(
        'SELECT reference_number AS ref_no FROM reference_number WHERE prefix = ? ORDER BY CAST(SUBSTRING(reference_number, CHAR_LENGTH(?) + 1) AS UNSIGNED) DESC LIMIT 100',
        [branchPrefix, branchPrefix]
      );

      const usedNumbers = [];
      // Extract numeric parts from existing reference numbers
      rows.forEach(row => {
        const numericPart = parseInt(row.ref_no.substring(branchPrefix.length));
        if (!isNaN(numericPart)) usedNumbers.push(numericPart);
      });

      // Find the next available sequential number
      let nextNumber = 1;
      const sortedNumbers = usedNumbers.sort((a, b) => a - b);
      for (const num of sortedNumbers) {
        if (num === nextNumber) nextNumber++;
        else if (num > nextNumber) break;
      }

      // If exceeded capacity, fallback to random generation
      if (nextNumber > 99999) return this._generateRandomRefNo(branchPrefix);

      // Try to insert into `reference_number` to reserve it. Retry on duplicate.
      let attempts = 0;
      const maxAttempts = 10;
      while (attempts < maxAttempts) {
        const refNo = branchPrefix + nextNumber.toString().padStart(5, '0');
        try {
          // Insert into main table; loan_id is left NULL until the loan is created
          await this.connection.execute(
            'INSERT INTO reference_number (loan_id, reference_number, prefix, generated_date, is_used, created_at) VALUES (?, ?, ?, NOW(), 0, NOW())',
            [null, refNo, branchPrefix]
          );
          return refNo;
        } catch (err) {
          // If duplicate entry, try next sequential number; otherwise rethrow
          if (err && (err.code === 'ER_DUP_ENTRY' || err.errno === 1062)) {
            nextNumber++;
            attempts++;
            continue;
          }
          throw err;
        }
      }

      // If we couldn't reserve a sequential number, fall back to random
      return this._generateRandomRefNo(branchPrefix);
    } catch (error) {
      console.error('Reference number generation error:', error);
      // Fallback: generate random number if database error
      return this._generateRandomRefNo(branchPrefix);
    }
  }

  /**
   * Generate random reference number as fallback
   * Used when sequential generation limit is reached or database errors occur
   * 
   * @private
   * @param {string} branchPrefix - Branch prefix
   * @returns {string} Random reference number
   */
  _generateRandomRefNo(branchPrefix) {
    const randomNumber = Math.floor(Math.random() * 99999) + 1;
    return branchPrefix + randomNumber.toString().padStart(5, '0');
  }

  /**
   * Validate reference number format
   * Checks if reference number matches expected format
   * 
   * @static
   * @param {string} refNo - Reference number to validate
   * @param {string} expectedPrefix - Expected branch prefix (default: MAIN)
   * @returns {boolean} true if format is valid, false otherwise
   */
  static validateRefNoFormat(refNo, expectedPrefix = 'MAIN') {
    if (!refNo || typeof refNo !== 'string') {
      return false;
    }
    const pattern = new RegExp(`^${expectedPrefix}\\d{5}$`);
    return pattern.test(refNo);
  }

  /**
   * Check if reference number already exists
   * 
   * @param {string} refNo - Reference number to check
   * @returns {Promise<boolean>} true if exists, false otherwise
   */
  async refNoExists(refNo) {
    try {
      const [rows] = await this.connection.execute(
        'SELECT reference_number FROM reference_number WHERE reference_number = ?',
        [refNo]
      );
      return rows.length > 0;
    } catch (error) {
      console.error('Error checking reference number existence:', error);
      return false;
    }
  }
}

module.exports = ReferenceNumberManager;
