const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const auth = require('../middleware/auth');
const logger = require('../utils/logger');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Function to create documents tables
async function createDocumentsTables() {
  try {
    console.log('Creating documents tables...');

    // Create document_categories table
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS document_categories (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(100) NOT NULL UNIQUE,
        description TEXT,
        color VARCHAR(7) DEFAULT '#007bff',
        icon VARCHAR(50) DEFAULT 'folder',
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    // Create documents table
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS documents (
        id INT AUTO_INCREMENT PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        category_id INT,
        property_id INT,
        plot_id INT,
        plot_type ENUM('plot', 'land_plot', 'property_block') DEFAULT NULL,
        plot_number VARCHAR(100) DEFAULT NULL,
        original_filename VARCHAR(255) NOT NULL,
        file_path VARCHAR(500) NOT NULL,
        file_size BIGINT NOT NULL,
        mime_type VARCHAR(100) NOT NULL,
        tags TEXT,
        status ENUM('active', 'archived', 'deleted') DEFAULT 'active',
        uploaded_by INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (category_id) REFERENCES document_categories(id) ON DELETE SET NULL,
        FOREIGN KEY (property_id) REFERENCES properties(id) ON DELETE CASCADE,
        FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_property_id (property_id),
        INDEX idx_plot_id (plot_id),
        INDEX idx_plot_number (plot_number),
        INDEX idx_property_plot_number (property_id, plot_number),
        INDEX idx_category_id (category_id),
        INDEX idx_status (status),
        INDEX idx_created_at (created_at)
      )
    `);

    // Create document_versions table
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS document_versions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        document_id INT NOT NULL,
        version_number INT NOT NULL,
        file_path VARCHAR(500) NOT NULL,
        file_size BIGINT NOT NULL,
        change_description TEXT,
        uploaded_by INT NOT NULL,
        is_current BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
        FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE CASCADE,
        UNIQUE KEY unique_document_version (document_id, version_number),
        INDEX idx_document_id (document_id),
        INDEX idx_is_current (is_current)
      )
    `);

    // Create document_activity_logs table
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS document_activity_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        document_id INT NOT NULL,
        action ENUM('upload', 'update', 'delete', 'download', 'view') NOT NULL,
        performed_by INT NOT NULL,
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
        FOREIGN KEY (performed_by) REFERENCES users(id) ON DELETE CASCADE,
        INDEX idx_document_id (document_id),
        INDEX idx_action (action),
        INDEX idx_created_at (created_at)
      )
    `);

    // Insert default document categories
    await pool.execute(`
      INSERT IGNORE INTO document_categories (name, description, color, icon) VALUES
      ('Legal Documents', 'Legal contracts, agreements, and certificates', '#dc3545', 'gavel'),
      ('Property Papers', 'Property deeds, titles, and ownership documents', '#28a745', 'home'),
      ('Financial Records', 'Invoices, receipts, and financial statements', '#ffc107', 'attach_money'),
      ('Images', 'Property photos and visual documentation', '#17a2b8', 'photo'),
      ('Plans & Drawings', 'Architectural plans, blueprints, and technical drawings', '#6f42c1', 'architecture'),
      ('Certificates', 'Compliance certificates and approvals', '#fd7e14', 'verified'),
      ('Reports', 'Inspection reports, surveys, and assessments', '#20c997', 'assessment'),
      ('Correspondence', 'Emails, letters, and communication records', '#6c757d', 'mail'),
      ('Other', 'Miscellaneous documents', '#495057', 'description')
    `);

    console.log('Documents tables created successfully!');
  } catch (error) {
    console.error('Error creating documents tables:', error);
    throw error;
  }
}

// Create documents directory if it doesn't exist
const documentsDir = path.join(__dirname, '../public/uploads/documents');
if (!fs.existsSync(documentsDir)) {
  fs.mkdirSync(documentsDir, { recursive: true });
}

// Configure multer for document uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, documentsDir);
  },
  filename: (req, file, cb) => {
    // Generate unique filename with timestamp
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const extension = path.extname(file.originalname);
    const baseName = path.basename(file.originalname, extension);
    cb(null, `${baseName}-${uniqueSuffix}${extension}`);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    // Allow common document types
    const allowedTypes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'image/jpeg',
      'image/jpg',
      'image/png',
      'text/plain'
    ];
    
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only PDF, Word, Excel, images and text files are allowed.'));
    }
  }
});

// Health check endpoint
router.get('/health', async (req, res) => {
  try {
    const [result] = await pool.execute('SELECT COUNT(*) as document_count FROM documents');
    
    res.json({
      status: 'ok',
      message: 'Documents service is healthy',
      database: 'connected',
      documentCount: result[0].document_count,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Documents service health check failed',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Get all documents (allow staff and admin to view; uploads remain admin-only)
router.get('/', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'staff') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Check if documents table exists, if not create it
    try {
      await pool.execute('SELECT 1 FROM documents LIMIT 1');
    } catch (tableError) {
      console.log('Documents table does not exist, creating tables...');
      try {
        await createDocumentsTables();
        console.log('Documents tables created successfully');
      } catch (createError) {
        console.error('Failed to create documents tables:', createError);
        // Return empty result instead of error
        return res.json({
          documents: [],
          total: 0,
          page: parseInt(req.query.page, 10) || 1,
          limit: parseInt(req.query.limit, 10) || 12,
          message: 'Documents system is being initialized. Please try again in a moment.'
        });
      }
    }

    const { limit, sort, order, page, search, category, status, property_id, plot_id, plot_number } = req.query;
    
    let query = `SELECT d.*, 
                        p.title as property_title,
                        p.id as property_code,
                        dc.name as category_name,
                        u.full_name as uploaded_by_name
                 FROM documents d
                 LEFT JOIN properties p ON d.property_id = p.id
                 LEFT JOIN document_categories dc ON d.category_id = dc.id
                 LEFT JOIN users u ON d.uploaded_by = u.id
                 WHERE 1=1`;
    let params = [];
    
    // Add search filter
    if (search) {
      query += ` AND (d.title LIKE ? OR d.description LIKE ? OR d.original_filename LIKE ? OR p.title LIKE ?)`;
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }
    
    // Add category filter
    if (category) {
      query += ` AND d.category_id = ?`;
      params.push(category);
    }
    
    // Add status filter
    if (status) {
      query += ` AND d.status = ?`;
      params.push(status);
    }
    
    // Add property filter
    if (property_id) {
      query += ` AND d.property_id = ?`;
      params.push(property_id);
    }
    
    // Add plot filters: prefer plot_number when provided
    if (plot_number && property_id) {
      query += ` AND d.plot_number = ?`;
      params.push(plot_number);
    } else if (plot_id) {
      query += ` AND d.plot_id = ?`;
      params.push(plot_id);
    }

    // If plot filter is requested but schema may be missing, guard with fallback
    // This is a soft guard: if query fails due to unknown column, we return empty result with message
    
    
    // Add sorting
    const validSortFields = ['title', 'created_at', 'updated_at', 'status', 'category_name', 'property_title'];
    const sortField = validSortFields.includes(sort) ? sort : 'created_at';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
    query += ` ORDER BY ${sortField} ${sortOrder}`;
    
    // Add pagination
    if (limit) {
      const limitNum = parseInt(limit, 10) || 10;
      const pageNum = parseInt(page, 10) || 1;
      const offset = (pageNum - 1) * limitNum;
      query += ` LIMIT ${limitNum} OFFSET ${offset}`;
    }
    
    const [rows] = await pool.execute(query, params);
    
    // Get total count for pagination
    let countQuery = `SELECT COUNT(d.id) as total FROM documents d 
                      LEFT JOIN properties p ON d.property_id = p.id 
                      LEFT JOIN document_categories dc ON d.category_id = dc.id 
                      WHERE 1=1`;
    let countParams = [];
    
    if (search) {
      countQuery += ` AND (d.title LIKE ? OR d.description LIKE ? OR d.original_filename LIKE ? OR p.title LIKE ?)`;
      const searchTerm = `%${search}%`;
      countParams.push(searchTerm, searchTerm, searchTerm, searchTerm);
    }
    
    if (category) {
      countQuery += ` AND d.category_id = ?`;
      countParams.push(category);
    }
    
    if (status) {
      countQuery += ` AND d.status = ?`;
      countParams.push(status);
    }
    
    if (property_id) {
      countQuery += ` AND d.property_id = ?`;
      countParams.push(property_id);
    }
    
    if (plot_number && property_id) {
      countQuery += ` AND d.plot_number = ?`;
      countParams.push(plot_number);
    } else if (plot_id) {
      countQuery += ` AND d.plot_id = ?`;
      countParams.push(plot_id);
    }
    
    const [countResult] = await pool.execute(countQuery, countParams);
    const total = countResult[0].total;
    
    res.json({
      documents: rows,
      total: total,
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || total
    });
  } catch (error) {
    console.error('Error fetching documents:', error);
    logger.error('Error fetching documents:', error);
    
    // Return empty result instead of error to prevent frontend crashes
    res.json({
      documents: [],
      total: 0,
      page: parseInt(req.query.page, 10) || 1,
      limit: parseInt(req.query.limit, 10) || 12,
      error: 'Unable to fetch documents at this time',
      message: 'The documents system may be initializing. Please try again in a moment.'
    });
  }
});

// Get document by ID
router.get('/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin' && req.user.role !== 'staff') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { id } = req.params;
    
    const [rows] = await pool.execute(
      `SELECT d.*, 
              p.title as property_title,
              p.property_id as property_code,
              dc.name as category_name,
              u.full_name as uploaded_by_name,
              dv.version_number,
              dv.change_description,
              dv.created_at as version_created_at
       FROM documents d
       LEFT JOIN properties p ON d.property_id = p.id
       LEFT JOIN document_categories dc ON d.category_id = dc.id
       LEFT JOIN users u ON d.uploaded_by = u.id
       LEFT JOIN document_versions dv ON d.id = dv.document_id AND dv.is_current = 1
       WHERE d.id = ?`,
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }
    
    // Get document history/versions
    const [versions] = await pool.execute(
      `SELECT dv.*, u.full_name as uploaded_by_name
       FROM document_versions dv
       LEFT JOIN users u ON dv.uploaded_by = u.id
       WHERE dv.document_id = ?
       ORDER BY dv.version_number DESC`,
      [id]
    );
    
    res.json({ 
      document: rows[0],
      versions: versions
    });
  } catch (error) {
    logger.error('Error fetching document:', error);
    res.status(500).json({ error: 'Server error fetching document' });
  }
});

// Upload new document
router.post('/', auth, upload.single('document'), async (req, res) => {
  try {
    // Allow admin, sub-admin, or staff in sales department
    if (
      req.user.role !== 'admin' &&
      req.user.role !== 'sub-admin' &&
      !(req.user.role === 'staff' && req.user.department === 'sales')
    ) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const {
      title,
      description,
      category_id,
      property_id,
      tags,
      status = 'active'
    } = req.body;
    
    // Validate required fields
    if (!title || !category_id) {
      // Clean up uploaded file if validation fails
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: 'Title and category are required' });
    }
    
    logger.info('Uploading new document:', { title, category_id, property_id });
    
    // Normalize plot info from body (optional)
    let { plot_id: bodyPlotId, plot_type: bodyPlotType, plot_number } = req.body;
    const validPlotTypes = ['plot', 'land_plot', 'property_block'];
    let plotId = bodyPlotId ? parseInt(bodyPlotId, 10) : null;
    const plotType = validPlotTypes.includes(bodyPlotType) ? bodyPlotType : null;

    // If plot_number is provided and plotId is not, resolve plotId from property_plots OR land_plots
    if (!plotId && plot_number && property_id) {
      try {
        // Try to resolve from apartment/unit plots (property_plots)
        const [aptPlotRows] = await pool.execute(
          'SELECT id FROM property_plots WHERE property_id = ? AND plot_number = ? LIMIT 1',
          [property_id, plot_number]
        );
        if (aptPlotRows.length > 0) {
          plotId = aptPlotRows[0].id;
          if (!bodyPlotType) {
            // If not specified, default to 'plot' for apartment/unit plots
            // Keep existing plotType if provided
          }
          logger.info('Resolved plot_id from property_plots by plot_number', { property_id, plot_number, plot_id: plotId });
        } else {
          // Try to resolve from land plots via land_blocks
          const [landPlotRows] = await pool.execute(
            `SELECT lp.id 
             FROM land_plots lp 
             JOIN land_blocks lb ON lp.block_id = lb.id 
             WHERE lb.property_id = ? AND lp.plot_number = ? 
             LIMIT 1`,
            [property_id, plot_number]
          );
          if (landPlotRows.length > 0) {
            plotId = landPlotRows[0].id;
            if (!bodyPlotType && !plotType) {
              // If caller didn't provide plot_type, infer land_plot
              // Note: plotType variable used later in insert
            }
            // Set plotType to land_plot if not already set and we matched land_plots
            if (!plotType) {
              // eslint-disable-next-line no-var
              var inferredPlotType = 'land_plot';
            }
            logger.info('Resolved plot_id from land_plots by plot_number', { property_id, plot_number, plot_id: plotId });
          } else {
            logger.warn('No plot found for provided plot_number in either property_plots or land_plots', { property_id, plot_number });
          }
        }
      } catch (resolveErr) {
        logger.error('Error resolving plot_id from plot_number', resolveErr);
      }
    }

    // If we inferred plot type above, apply it
    const finalPlotType = plotType || (typeof inferredPlotType !== 'undefined' ? inferredPlotType : null);

    // Insert document record
    const [result] = await pool.execute(
      `INSERT INTO documents (title, description, category_id, property_id, plot_id, plot_type, plot_number, original_filename, 
                             file_path, file_size, mime_type, tags, status, uploaded_by, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [
        title,
        description || null,
        category_id,
        property_id || null,
        plotId,
        finalPlotType,
        plot_number || null,
        req.file.originalname,
        req.file.filename,
        req.file.size,
        req.file.mimetype,
        tags || null,
        status,
        req.user.id
      ]
    );
    
    const documentId = result.insertId;
    
    // Create initial version record
    await pool.execute(
      `INSERT INTO document_versions (document_id, version_number, file_path, file_size, 
                                     change_description, uploaded_by, is_current, created_at) 
       VALUES (?, 1, ?, ?, ?, ?, 1, NOW())`,
      [
        documentId,
        req.file.filename,
        req.file.size,
        'Initial upload',
        req.user.id
      ]
    );
    
    // Log the activity
    await pool.execute(
      `INSERT INTO document_activity_logs (document_id, action, performed_by, details, created_at) 
       VALUES (?, 'upload', ?, ?, NOW())`,
      [documentId, req.user.id, `Document "${title}" uploaded`]
    );
    
    res.status(201).json({
      message: 'Document uploaded successfully',
      document: {
        id: documentId,
        title,
        description,
        category_id,
        property_id,
        original_filename: req.file.originalname,
        file_path: req.file.filename,
        file_size: req.file.size,
        mime_type: req.file.mimetype,
        status,
        uploaded_by: req.user.id
      }
    });
  } catch (error) {
    // Clean up uploaded file if database operation fails
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    console.error('Error uploading document:', error);
    logger.error('Error uploading document:', error);
    res.status(500).json({ 
      error: 'Server error uploading document',
      details: error.message 
    });
  }
});

// Update document
router.put('/:id', auth, async (req, res) => {
  try {
    // Allow admin, sub-admin, or staff in sales department
    if (
      req.user.role !== 'admin' &&
      req.user.role !== 'sub-admin' &&
      !(req.user.role === 'staff' && req.user.department === 'sales')
    ) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { id } = req.params;
    const {
      title,
      description,
      category_id,
      property_id,
      tags,
      status
    } = req.body;
    
    // Check if document exists
    const [existing] = await pool.execute('SELECT * FROM documents WHERE id = ?', [id]);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }
    
    // Update document
    await pool.execute(
      `UPDATE documents SET 
       title = COALESCE(?, title),
       description = COALESCE(?, description),
       category_id = COALESCE(?, category_id),
       property_id = COALESCE(?, property_id),
       plot_id = COALESCE(?, plot_id),
       plot_type = COALESCE(?, plot_type),
       tags = COALESCE(?, tags),
       status = COALESCE(?, status),
       updated_at = NOW()
       WHERE id = ?`,
      [title, description, category_id, property_id, req.body.plot_id || null, req.body.plot_type || null, tags, status, id]
    );
    
    // Log the activity
    await pool.execute(
      `INSERT INTO document_activity_logs (document_id, action, performed_by, details, created_at) 
       VALUES (?, 'update', ?, ?, NOW())`,
      [id, req.user.id, `Document "${title || existing[0].title}" updated`]
    );
    
    res.json({ message: 'Document updated successfully' });
  } catch (error) {
    logger.error('Error updating document:', error);
    res.status(500).json({ error: 'Server error updating document' });
  }
});

// Upload new version of document
router.post('/:id/versions', auth, upload.single('document'), async (req, res) => {
  try {
    // Allow admin, sub-admin, or staff in sales department
    if (
      req.user.role !== 'admin' &&
      req.user.role !== 'sub-admin' &&
      !(req.user.role === 'staff' && req.user.department === 'sales')
    ) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    const { id } = req.params;
    const { change_description } = req.body;
    
    // Check if document exists
    const [existing] = await pool.execute('SELECT * FROM documents WHERE id = ?', [id]);
    if (existing.length === 0) {
      // Clean up uploaded file
      fs.unlinkSync(req.file.path);
      return res.status(404).json({ error: 'Document not found' });
    }
    
    // Get current version number
    const [currentVersion] = await pool.execute(
      'SELECT MAX(version_number) as max_version FROM document_versions WHERE document_id = ?',
      [id]
    );
    
    const newVersionNumber = (currentVersion[0].max_version || 0) + 1;
    
    // Mark all previous versions as not current
    await pool.execute(
      'UPDATE document_versions SET is_current = 0 WHERE document_id = ?',
      [id]
    );
    
    // Insert new version
    await pool.execute(
      `INSERT INTO document_versions (document_id, version_number, file_path, file_size, 
                                     change_description, uploaded_by, is_current, created_at) 
       VALUES (?, ?, ?, ?, ?, ?, 1, NOW())`,
      [
        id,
        newVersionNumber,
        req.file.filename,
        req.file.size,
        change_description || `Version ${newVersionNumber}`,
        req.user.id
      ]
    );
    
    // Update main document record (keep plot info unchanged)
    await pool.execute(
      `UPDATE documents SET 
       file_path = ?, 
       file_size = ?, 
       mime_type = ?, 
       updated_at = NOW() 
       WHERE id = ?`,
      [req.file.filename, req.file.size, req.file.mimetype, id]
    );
    
    // Log the activity
    await pool.execute(
      `INSERT INTO document_activity_logs (document_id, action, performed_by, details, created_at) 
       VALUES (?, 'version_upload', ?, ?, NOW())`,
      [id, req.user.id, `New version ${newVersionNumber} uploaded: ${change_description || 'No description'}`]
    );
    
    res.status(201).json({
      message: 'New document version uploaded successfully',
      version_number: newVersionNumber
    });
  } catch (error) {
    // Clean up uploaded file if database operation fails
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    logger.error('Error uploading document version:', error);
    res.status(500).json({ error: 'Server error uploading document version' });
  }
});

// Delete document
router.delete('/:id', auth, async (req, res) => {
  try {
    // Allow admin, sub-admin, or staff in sales department
    if (
      req.user.role !== 'admin' &&
      req.user.role !== 'sub-admin' &&
      !(req.user.role === 'staff' && req.user.department === 'sales')
    ) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { id } = req.params;
    
    // Get document info before deletion
    const [document] = await pool.execute('SELECT * FROM documents WHERE id = ?', [id]);
    if (document.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }
    
    // Get all versions to delete files
    const [versions] = await pool.execute(
      'SELECT file_path FROM document_versions WHERE document_id = ?',
      [id]
    );
    
    // Delete physical files
    versions.forEach(version => {
      const filePath = path.join(documentsDir, version.file_path);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    });
    
    // Delete from database (cascade will handle related records)
    await pool.execute('DELETE FROM documents WHERE id = ?', [id]);
    
    // Log the activity
    await pool.execute(
      `INSERT INTO document_activity_logs (document_id, action, performed_by, details, created_at) 
       VALUES (?, 'delete', ?, ?, NOW())`,
      [id, req.user.id, `Document "${document[0].title}" deleted`]
    );
    
    res.json({ message: 'Document deleted successfully' });
  } catch (error) {
    logger.error('Error deleting document:', error);
    res.status(500).json({ error: 'Server error deleting document' });
  }
});

// Download document
router.get('/:id/download', auth, async (req, res) => {
  try {
    // Allow admin, sub-admin, or staff in sales department
    if (
      req.user.role !== 'admin' &&
      req.user.role !== 'sub-admin' &&
      !(req.user.role === 'staff' && req.user.department === 'sales')
    ) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { id } = req.params;
    const { version } = req.query;
    
    let query, params;
    if (version) {
      // Download specific version
      query = `SELECT dv.file_path, d.original_filename, d.title
               FROM document_versions dv
               JOIN documents d ON dv.document_id = d.id
               WHERE d.id = ? AND dv.version_number = ?`;
      params = [id, version];
    } else {
      // Download current version
      query = `SELECT file_path, original_filename, title FROM documents WHERE id = ?`;
      params = [id];
    }
    
    const [rows] = await pool.execute(query, params);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }
    
    const filePath = path.join(documentsDir, rows[0].file_path);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found on server' });
    }
    
    // Log the download activity
    await pool.execute(
      `INSERT INTO document_activity_logs (document_id, action, performed_by, details, created_at) 
       VALUES (?, 'download', ?, ?, NOW())`,
      [id, req.user.id, `Document downloaded${version ? ` (version ${version})` : ''}`]
    );
    
    // Set appropriate headers for download
    res.setHeader('Content-Disposition', `attachment; filename="${rows[0].original_filename}"`);
    res.setHeader('Content-Type', 'application/octet-stream');
    
    // Stream the file
    const fileStream = fs.createReadStream(filePath);
    fileStream.pipe(res);
  } catch (error) {
    logger.error('Error downloading document:', error);
    res.status(500).json({ error: 'Server error downloading document' });
  }
});

// Get document categories
router.get('/categories/list', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    // Check if document_categories table exists, if not create it
    try {
      await pool.execute('SELECT 1 FROM document_categories LIMIT 1');
    } catch (tableError) {
      console.log('Document categories table does not exist, creating tables...');
      try {
        await createDocumentsTables();
        console.log('Document tables created successfully');
      } catch (createError) {
        console.error('Failed to create document tables:', createError);
        // Return empty categories instead of error
        return res.json({ categories: [] });
      }
    }
    
    const [categories] = await pool.execute(
      'SELECT * FROM document_categories WHERE is_active = 1 ORDER BY name'
    );
    
    res.json({ categories });
  } catch (error) {
    logger.error('Error fetching document categories:', error);
    res.json({ categories: [] }); // Return empty array instead of error
  }
});

// Create document category
router.post('/categories', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { name, description, color } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Category name is required' });
    }
    
    const [result] = await pool.execute(
      'INSERT INTO document_categories (name, description, color, created_at) VALUES (?, ?, ?, NOW())',
      [name, description || null, color || '#007bff']
    );
    
    res.status(201).json({
      message: 'Category created successfully',
      category: {
        id: result.insertId,
        name,
        description,
        color: color || '#007bff'
      }
    });
  } catch (error) {
    logger.error('Error creating document category:', error);
    res.status(500).json({ error: 'Server error creating category' });
  }
});

// Get document activity logs
router.get('/:id/activity', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { id } = req.params;
    
    const [activities] = await pool.execute(
      `SELECT dal.*, u.full_name as performed_by_name
       FROM document_activity_logs dal
       LEFT JOIN users u ON dal.performed_by = u.id
       WHERE dal.document_id = ?
       ORDER BY dal.created_at DESC`,
      [id]
    );
    
    res.json({ activities });
  } catch (error) {
    logger.error('Error fetching document activities:', error);
    res.status(500).json({ error: 'Server error fetching activities' });
  }
});

module.exports = router;