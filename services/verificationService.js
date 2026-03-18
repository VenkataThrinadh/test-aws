const { pool } = require('../db');
const crypto = require('crypto');
const logger = require('../utils/logger');

/**
 * Generate a random verification token
 * @returns {string} - Random token
 */
const generateToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

/**
 * Generate a random OTP (6 digits)
 * @returns {string} - Random 6-digit OTP
 */
const generateOTP = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

/**
 * Create a verification token for a user
 * @param {string} userId - User ID
 * @param {string} tokenType - Type of token (email_verification, password_reset)
 * @returns {Promise<string>} - Generated token
 */
const createVerificationToken = async (userId, tokenType = 'email_verification') => {
  try {
    // Generate a random token
    const token = generateToken();
    
    // Set expiration time (24 hours from now)
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);
    
    // Store the token in the database
    const [result] = await pool.execute(
      `INSERT INTO verification_tokens (user_id, token, expires_at, created_at)
       VALUES (?, ?, ?, NOW())`,
      [userId, token, expiresAt]
    );
    
    return token;
  } catch (error) {
    logger.error('Error creating verification token:', error.message);
    throw error;
  }
};

/**
 * Create a password reset OTP for a user
 * @param {string} userId - User ID
 * @param {string} hashedPassword - Hashed new password to store temporarily
 * @returns {Promise<string>} - Generated OTP
 */
const createPasswordResetOTP = async (userId, hashedPassword) => {
  try {
    // Generate a random OTP
    const otp = generateOTP();
    
    // Set expiration time (30 minutes from now - extended for better UX)
    const currentTime = new Date();
    const expiresAt = new Date(currentTime.getTime() + (30 * 60 * 1000)); // 30 minutes
    
    logger.dev('Creating OTP for user:', userId);
    logger.dev('OTP generated:', otp);
    logger.dev('Current time:', currentTime.toISOString());
    logger.dev('Expires at:', expiresAt.toISOString());
    
    // First, delete any existing password reset tokens for this user
    const [deleteResult] = await pool.execute(
      'DELETE FROM password_reset_tokens WHERE user_id = ?',
      [userId]
    );
    
    logger.dev('Deleted existing tokens:', deleteResult.affectedRows);
    
    // Store the OTP in the database
    const [insertResult] = await pool.execute(
      `INSERT INTO password_reset_tokens (user_id, token, expires_at, created_at)
       VALUES (?, ?, ?, ?)`,
      [userId, otp, expiresAt, currentTime]
    );
    
    logger.dev('OTP token inserted with ID:', insertResult.insertId);
    
    // Store the hashed password in a temporary field in the users table
    const [updateResult] = await pool.execute(
      'UPDATE users SET temp_password = ? WHERE id = ?',
      [hashedPassword, userId]
    );
    
    logger.dev('Temp password updated, affected rows:', updateResult.affectedRows);
    
    // Verify the OTP was stored correctly
    const [verifyResult] = await pool.execute(
      'SELECT token, expires_at FROM password_reset_tokens WHERE user_id = ? AND token = ?',
      [userId, otp]
    );
    
    if (verifyResult.length === 0) {
      throw new Error('Failed to store OTP in database');
    }
    
    logger.dev('OTP verification successful:', verifyResult[0]);
    
    return otp;
  } catch (error) {
    logger.error('Error creating password reset OTP:', error.message);
    logger.error('Stack trace:', error.stack);
    throw error;
  }
};

/**
 * Verify a token
 * @param {string} token - Token to verify
 * @param {string} userId - User ID
 * @returns {Promise<boolean>} - Whether the token is valid
 */
const verifyToken = async (token, userId) => {
  try {
    // Find the token in the database
    const [rows] = await pool.execute(
      `SELECT * FROM verification_tokens 
       WHERE token = ? AND user_id = ? AND expires_at > NOW()`,
      [token, userId]
    );
    
    // If token exists and is not expired
    if (rows.length > 0) {
      // Delete the token (one-time use)
      await pool.execute(
        'DELETE FROM verification_tokens WHERE token = ?',
        [token]
      );
      
      // Update user's email_confirmed status
      await pool.execute(
        'UPDATE users SET email_confirmed = TRUE WHERE id = ?',
        [userId]
      );
      
      return true;
    }
    
    return false;
  } catch (error) {
    logger.error('Error verifying token:', error.message);
    throw error;
  }
};

/**
 * Verify a password reset OTP
 * @param {string} otp - OTP to verify
 * @param {string} email - User's email
 * @returns {Promise<Object>} - Result object with success status and user ID if successful
 */
const verifyPasswordResetOTP = async (otp, email) => {
  try {
    logger.dev('Verifying OTP for email:', email);
    logger.dev('OTP received:', otp);
    
    // Find the user by email
    const [rows] = await pool.execute(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );
    
    if (rows.length === 0) {
      logger.dev('User not found for email:', email);
      return { success: false, message: 'User not found' };
    }
    
    const userId = rows[0].id;
    logger.dev('User ID found:', userId);
    
    // Get current time for comparison
    const currentTime = new Date();
    logger.dev('Current time:', currentTime.toISOString());
    
    // Find all OTPs for this user (for debugging)
    const [allTokens] = await pool.execute(
      `SELECT token, expires_at, created_at FROM password_reset_tokens 
       WHERE user_id = ? ORDER BY created_at DESC`,
      [userId]
    );
    
    logger.dev('All tokens for user:', allTokens);
    
    // Find the OTP in the database with explicit time comparison
    const [resultRows] = await pool.execute(
      `SELECT * FROM password_reset_tokens 
       WHERE token = ? AND user_id = ? AND expires_at > ?`,
      [otp.toString().trim(), userId, currentTime]
    );
    
    logger.dev('Matching tokens found:', resultRows.length);
    
    // If OTP exists and is not expired
    if (resultRows.length > 0) {
      logger.dev('Valid OTP found, processing password reset');
      
      // Delete the OTP (one-time use)
      await pool.execute(
        'DELETE FROM password_reset_tokens WHERE token = ? AND user_id = ?',
        [otp.toString().trim(), userId]
      );
      
      // Check if user has temp_password
      const [userCheck] = await pool.execute(
        'SELECT temp_password FROM users WHERE id = ?',
        [userId]
      );
      
      if (userCheck.length === 0 || !userCheck[0].temp_password) {
        logger.error('No temporary password found for user:', userId);
        return { success: false, message: 'Password reset session expired. Please request a new OTP.' };
      }
      
      // Update user's password with the temporary password
      await pool.execute(
        'UPDATE users SET password = temp_password, temp_password = NULL, updated_at = ? WHERE id = ?',
        [currentTime, userId]
      );
      
      logger.dev('Password reset completed successfully for user:', userId);
      return { success: true, userId };
    }
    
    // Check if there are any tokens for this user (expired or not)
    const [expiredTokens] = await pool.execute(
      `SELECT * FROM password_reset_tokens 
       WHERE user_id = ? ORDER BY created_at DESC LIMIT 1`,
      [userId]
    );
    
    if (expiredTokens.length > 0) {
      const tokenData = expiredTokens[0];
      const isExpired = new Date(tokenData.expires_at) < currentTime;
      const isWrongOTP = tokenData.token !== otp.toString().trim();
      
      logger.dev('Token analysis:', {
        storedToken: tokenData.token,
        receivedToken: otp.toString().trim(),
        expiresAt: tokenData.expires_at,
        currentTime: currentTime,
        isExpired,
        isWrongOTP
      });
      
      if (isExpired) {
        // Clean up expired token
        await pool.execute(
          'DELETE FROM password_reset_tokens WHERE user_id = ?',
          [userId]
        );
        return { success: false, message: 'OTP has expired. Please request a new one.' };
      } else if (isWrongOTP) {
        return { success: false, message: 'Invalid OTP. Please check and try again.' };
      }
    }
    
    return { success: false, message: 'Invalid or expired OTP' };
  } catch (error) {
    logger.error('Error verifying password reset OTP:', error.message);
    logger.error('Stack trace:', error.stack);
    throw error;
  }
};

/**
 * Check if a user exists by email
 * @param {string} email - User's email
 * @returns {Promise<Object>} - User object if found, null otherwise
 */
const findUserByEmail = async (email) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, email, email_confirmed FROM users WHERE email = ?',
      [email]
    );
    
    if (rows.length > 0) {
      return rows[0];
    }
    
    return null;
  } catch (error) {
    logger.error('Error finding user by email:', error.message);
    throw error;
  }
};

/**
 * Check if a user's email is verified
 * @param {string} userId - User ID
 * @returns {Promise<boolean>} - Whether the email is verified
 */
const isEmailVerified = async (userId) => {
  try {
    const [rows] = await pool.execute(
      'SELECT email_confirmed FROM users WHERE id = ?',
      [userId]
    );
    
    if (rows.length > 0) {
      return rows[0].email_confirmed;
    }
    
    return false;
  } catch (error) {
    logger.error('Error checking email verification status:', error.message);
    throw error;
  }
};

module.exports = {
  createVerificationToken,
  createPasswordResetOTP,
  verifyToken,
  verifyPasswordResetOTP,
  findUserByEmail,
  isEmailVerified,
  generateOTP
};