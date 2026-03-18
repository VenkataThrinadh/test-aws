/**
 * Upload API Routes
 * 
 * Handles file uploads for loan documents, customer photos, etc.
 * 
 * Routes:
 *   POST   /api/loans/upload/document    - Upload document
 *   POST   /api/loans/upload/photo       - Upload photo
 *   DELETE /api/loans/upload/:file_id    - Delete uploaded file
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const logger = require('../utils/logger');
const fs = require('fs');
const path = require('path');

const UPLOAD_DIR = process.env.LOAN_UPLOAD_DIR || 'uploads/loans';
const MAX_FILE_SIZE = parseInt(process.env.LOAN_MAX_FILE_SIZE || 5242880); // 5MB default

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

router.post('/document', async (req, res) => {
  let connection = null;
  try {
    // This route assumes multipart/form-data middleware is configured
    // Implementation depends on your file upload middleware (multer, busboy, etc.)
    
    const { doc_id, file_name, file_path, file_size, uploaded_by } = req.body;

    if (!doc_id || !file_name) {
      return res.status(400).json({
        success: false,
        message: 'Document ID and file name are required',
        timestamp: new Date().toISOString()
      });
    }

    if (file_size && file_size > MAX_FILE_SIZE) {
      return res.status(413).json({
        success: false,
        message: `File size exceeds maximum limit of ${MAX_FILE_SIZE / 1024 / 1024}MB`,
        timestamp: new Date().toISOString()
      });
    }

    connection = await pool.getConnection();
    await connection.execute(
      `UPDATE customer_document SET file_path = ?, file_size = ?, uploaded_by = ?, uploaded_at = NOW()
       WHERE doc_id = ?`,
      [file_path || '', file_size || 0, uploaded_by || 'system', doc_id]
    );

    res.status(200).json({
      success: true,
      message: 'Document uploaded successfully',
      data: { doc_id, file_name },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Upload document error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload document',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

router.post('/photo', async (req, res) => {
  let connection = null;
  try {
    const { customer_id, file_name, file_path, file_size } = req.body;

    if (!customer_id || !file_name) {
      return res.status(400).json({
        success: false,
        message: 'Customer ID and file name are required',
        timestamp: new Date().toISOString()
      });
    }

    if (file_size && file_size > MAX_FILE_SIZE) {
      return res.status(413).json({
        success: false,
        message: `File size exceeds maximum limit of ${MAX_FILE_SIZE / 1024 / 1024}MB`,
        timestamp: new Date().toISOString()
      });
    }

    connection = await pool.getConnection();
    await connection.execute(
      'UPDATE customer_loan SET photo = ? WHERE customer_id = ?',
      [file_path || '', customer_id]
    );

    res.status(200).json({
      success: true,
      message: 'Photo uploaded successfully',
      data: { customer_id, file_name },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Upload photo error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to upload photo',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

router.delete('/:file_id', async (req, res) => {
  let connection = null;
  try {
    const { file_id } = req.params;

    if (!file_id) {
      return res.status(400).json({
        success: false,
        message: 'File ID is required',
        timestamp: new Date().toISOString()
      });
    }

    connection = await pool.getConnection();
    
    // Get file path from database
    const [rows] = await connection.execute(
      'SELECT file_path FROM customer_document WHERE doc_id = ?',
      [file_id]
    );

    if (rows.length > 0 && rows[0].file_path) {
      const filePath = path.join(UPLOAD_DIR, rows[0].file_path);
      // Delete physical file if it exists
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }

    // Delete database record
    await connection.execute('DELETE FROM customer_document WHERE doc_id = ?', [file_id]);

    res.json({
      success: true,
      message: 'File deleted successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Delete file error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete file',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
