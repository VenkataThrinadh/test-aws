/**
 * Customer Documents API Routes
 * 
 * Manages documents for loan customers (KYC, property deeds, etc.)
 * 
 * Routes:
 *   GET    /api/loans/customer-documents           - Get all documents
 *   POST   /api/loans/customer-documents           - Upload document (with multipart)
 *   POST   /api/loans/customer-documents/upload    - Upload Aadhaar and PAN
 *   GET    /api/loans/customer-documents/:id       - Get document details
 *   DELETE /api/loans/customer-documents/:id       - Delete document
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const logger = require('../utils/logger');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

// Configure multer for document uploads
const uploadDir = path.join(__dirname, '../public/uploads/documents');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const timestamp = Date.now();
    const random = Math.floor(Math.random() * 1000);
    const ext = path.extname(file.originalname);
    cb(null, `${timestamp}-${random}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'application/pdf'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  }
});

router.get('/', async (req, res) => {
  let connection = null;
  try {
    const { customer_id, doc_type = '', page = 1, limit = 10 } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    connection = await pool.getConnection();

    let whereClause = 'WHERE 1=1';
    const queryParams = [];

    if (customer_id) {
      whereClause += ' AND customer_id = ?';
      queryParams.push(customer_id);
    }
    if (doc_type) {
      whereClause += ' AND document_type = ?';
      queryParams.push(doc_type);
    }

    const countQuery = `SELECT COUNT(*) as total FROM customer_document_extended ${whereClause}`;
    const [countRows] = await connection.execute(countQuery, queryParams);
    const totalItems = countRows[0].total;

    const dataQuery = `
      SELECT 
        cd.doc_id, 
        cd.customer_id, 
        COALESCE(cl.full_name, 'N/A') as customer_name,
        cd.document_type, 
        cd.file_name, 
        cd.file_path, 
        cd.file_size, 
        cd.uploaded_by, 
        DATE_FORMAT(cd.uploaded_at, '%Y-%m-%d %H:%i:%s') as uploaded_at, 
        cd.remarks
      FROM customer_document_extended cd
      LEFT JOIN customer_loan cl ON cd.customer_id = cl.customer_id
      ${whereClause}
      ORDER BY cd.uploaded_at DESC
      LIMIT ? OFFSET ?
    `;

    const [rows] = await connection.execute(dataQuery, [...queryParams, Number(limit), offset]);
    const totalPages = Math.ceil(totalItems / Number(limit));

    // Transform response to group files by customer and document type
    const transformedRows = rows.reduce((acc, row) => {
      // Find if customer already exists in accumulated results
      let customerRow = acc.find(r => r.customer_id === row.customer_id);
      
      if (!customerRow) {
        // Create new customer row with properly formatted timestamp
        customerRow = {
          doc_id: row.doc_id,
          customer_id: row.customer_id,
          customer_name: row.customer_name,
          aadhaar_file: null,
          pan_file: null,
          file_size: row.file_size,
          uploaded_by: row.uploaded_by,
          uploaded_at: row.uploaded_at, // This is now formatted as YYYY-MM-DD HH:mm:ss string
          created_at: row.uploaded_at, // Same timestamp for both fields
          remarks: row.remarks
        };
        acc.push(customerRow);
      }
      
      // Assign file path based on document type
      if (row.document_type === 'aadhaar') {
        customerRow.aadhaar_file = row.file_path;
      } else if (row.document_type === 'pan') {
        customerRow.pan_file = row.file_path;
      }
      
      return acc;
    }, []);

    res.json({
      success: true,
      message: 'Documents retrieved successfully',
      data: {
        data: transformedRows,
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
    logger.error('Get documents error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch documents',
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
      return res.status(400).json({ success: false, message: 'Valid document ID required', timestamp: new Date().toISOString() });
    }

    connection = await pool.getConnection();
    const [rows] = await connection.execute(
      'SELECT * FROM customer_document_extended WHERE doc_id = ?',
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Document not found', timestamp: new Date().toISOString() });
    }

    res.json({
      success: true,
      message: 'Document retrieved successfully',
      data: rows[0],
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Get document error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch document',
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
    const { customer_id, document_type, file_name, file_path, file_size, uploaded_by, remarks } = req.body;

    if (!customer_id || !document_type || !file_name) {
      return res.status(400).json({
        success: false,
        message: 'Customer ID, document type, and file name are required',
        timestamp: new Date().toISOString()
      });
    }

    connection = await pool.getConnection();
    const [result] = await connection.execute(
      `INSERT INTO customer_document_extended (customer_id, document_type, file_name, file_path, file_size, uploaded_by, uploaded_at, remarks)
       VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)`,
      [customer_id, document_type, file_name, file_path || '', file_size || 0, uploaded_by || 'system', remarks || '']
    );

    res.status(201).json({
      success: true,
      message: 'Document uploaded successfully',
      data: { doc_id: result.insertId },
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

router.delete('/:customerId', async (req, res) => {
  let connection = null;
  try {
    const { customerId } = req.params;
    if (!customerId || isNaN(Number(customerId))) {
      return res.status(400).json({ success: false, message: 'Valid customer ID required', timestamp: new Date().toISOString() });
    }

    connection = await pool.getConnection();
    
    // Delete all documents for the customer
    const [result] = await connection.execute(
      'DELETE FROM customer_document_extended WHERE customer_id = ?', 
      [customerId]
    );

    res.json({
      success: true,
      message: 'Customer documents deleted successfully',
      data: { deletedCount: result.affectedRows },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Delete customer documents error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete customer documents',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

// Upload Aadhaar and PAN documents with multipart
router.post('/upload', upload.fields([{ name: 'aadhaar_file', maxCount: 1 }, { name: 'pan_file', maxCount: 1 }]), async (req, res) => {
  let connection = null;
  try {
    const { customer_id } = req.body;
    const aadhaarFile = req.files?.aadhaar_file?.[0];
    const panFile = req.files?.pan_file?.[0];

    if (!customer_id) {
      return res.status(400).json({
        success: false,
        message: 'Customer ID is required',
        timestamp: new Date().toISOString()
      });
    }

    if (!aadhaarFile && !panFile) {
      return res.status(400).json({
        success: false,
        message: 'At least one document (Aadhaar or PAN) is required',
        timestamp: new Date().toISOString()
      });
    }

    connection = await pool.getConnection();

    // Check if customer exists in customer_loan table
    const [customerExists] = await connection.execute(
      'SELECT customer_id FROM customer_loan WHERE customer_id = ?',
      [customer_id]
    );

    if (customerExists.length === 0) {
      // Clean up uploaded files if customer doesn't exist
      if (aadhaarFile) fs.unlinkSync(aadhaarFile.path);
      if (panFile) fs.unlinkSync(panFile.path);
      
      return res.status(404).json({
        success: false,
        message: 'Customer not found',
        timestamp: new Date().toISOString()
      });
    }

    const uploadedDocs = [];

    // Upload Aadhaar document
    if (aadhaarFile) {
      const [aadhaarResult] = await connection.execute(
        `INSERT INTO customer_document_extended (customer_id, document_type, file_name, file_path, file_size, uploaded_by, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        [customer_id, 'aadhaar', aadhaarFile.originalname, aadhaarFile.filename, aadhaarFile.size, 'system']
      );
      uploadedDocs.push({ type: 'aadhaar', doc_id: aadhaarResult.insertId, filename: aadhaarFile.filename });
    }

    // Upload PAN document
    if (panFile) {
      const [panResult] = await connection.execute(
        `INSERT INTO customer_document_extended (customer_id, document_type, file_name, file_path, file_size, uploaded_by, uploaded_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        [customer_id, 'pan', panFile.originalname, panFile.filename, panFile.size, 'system']
      );
      uploadedDocs.push({ type: 'pan', doc_id: panResult.insertId, filename: panFile.filename });
    }

    res.status(201).json({
      success: true,
      message: 'Documents uploaded successfully',
      data: {
        customer_id,
        uploaded_documents: uploadedDocs
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Upload documents error:', error);
    
    // Clean up uploaded files on error
    if (req.files?.aadhaar_file?.[0]) {
      try { fs.unlinkSync(req.files.aadhaar_file[0].path); } catch (e) {}
    }
    if (req.files?.pan_file?.[0]) {
      try { fs.unlinkSync(req.files.pan_file[0].path); } catch (e) {}
    }

    res.status(500).json({
      success: false,
      message: 'Failed to upload documents',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

// Route to serve document files with proper headers (PDF support)
router.get('/file/:filename', (req, res) => {
  try {
    const { filename } = req.params;
    
    logger.info(`File serving request: ${filename}`);
    
    // Security: Only allow alphanumeric, dash, and dot in filename
    if (!/^[\w\-\.]+$/.test(filename)) {
      logger.warn(`Invalid filename format: ${filename}`);
      return res.status(400).json({ success: false, message: 'Invalid filename' });
    }

    const filePath = path.join(uploadDir, filename);
    
    logger.info(`Full file path: ${filePath}`);
    logger.info(`Upload directory: ${uploadDir}`);
    
    // Prevent directory traversal
    if (!filePath.startsWith(uploadDir)) {
      logger.warn(`Directory traversal attempt: ${filePath}`);
      return res.status(403).json({ success: false, message: 'Access denied' });
    }

    // Check if file exists
    if (!fs.existsSync(filePath)) {
      logger.warn(`File not found: ${filePath}`);
      return res.status(404).json({ success: false, message: 'File not found' });
    }

    // Set proper MIME type and headers for PDFs
    const ext = path.extname(filename).toLowerCase();
    let mimeType = 'application/octet-stream';
    
    if (ext === '.pdf') {
      mimeType = 'application/pdf';
      res.setHeader('Content-Disposition', 'inline'); // Display in browser instead of download
    } else if (['.jpg', '.jpeg'].includes(ext)) {
      mimeType = 'image/jpeg';
    } else if (ext === '.png') {
      mimeType = 'image/png';
    }

    logger.info(`Serving file: ${filename} with mime type: ${mimeType}`);
    
    res.setHeader('Content-Type', mimeType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    // Send the file
    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
      logger.error(`Stream error for ${filename}:`, err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: 'Error reading file' });
      }
    });
    stream.pipe(res);
  } catch (error) {
    logger.error('Serve file error:', error);
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: 'Failed to serve file',
        error: process.env.NODE_ENV === 'development' ? error.message : undefined,
        timestamp: new Date().toISOString()
      });
    }
  }
});

module.exports = router;
