const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { pool } = require('../db');
const auth = require('../middleware/auth');

// Configure multer for staff documents
const staffDocumentsDir = path.join(__dirname, '../public/uploads/staff_documents');
if (!fs.existsSync(staffDocumentsDir)) {
  fs.mkdirSync(staffDocumentsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, staffDocumentsDir);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}_${file.originalname}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB limit
  fileFilter: (req, file, cb) => {
    // Allow common document formats
    const allowedMimes = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'image/jpeg',
      'image/png',
      'image/gif',
      'text/plain',
      'application/zip',
    ];

    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`File type ${file.mimetype} not allowed`));
    }
  },
});

// Get all documents for a staff member
router.get('/staff/:staffId', auth, async (req, res) => {
  try {
    const { staffId } = req.params;

    const connection = await pool.getConnection();
    const [documents] = await connection.execute(
      'SELECT * FROM staff_documents WHERE staff_id = ? ORDER BY created_at DESC',
      [staffId]
    );
    connection.release();

    res.json(documents);
  } catch (error) {
    console.error('Error fetching staff documents:', error);
    res.status(500).json({ error: 'Failed to fetch documents' });
  }
});

// Get a single document
router.get('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;

    const connection = await pool.getConnection();
    const [documents] = await connection.execute(
      'SELECT * FROM staff_documents WHERE id = ?',
      [id]
    );
    connection.release();

    if (documents.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    res.json(documents[0]);
  } catch (error) {
    console.error('Error fetching staff document:', error);
    res.status(500).json({ error: 'Failed to fetch document' });
  }
});

// Upload a new staff document
router.post('/upload', auth, upload.single('file'), async (req, res) => {
  try {
    const { document_name, staff_id } = req.body;
    const userId = req.user?.id;

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    if (!document_name || !staff_id) {
      // Delete uploaded file if validation fails
      fs.unlink(req.file.path, (err) => {
        if (err) console.error('Error deleting file:', err);
      });
      return res.status(400).json({ error: 'Document name and staff_id are required' });
    }

    const connection = await pool.getConnection();
    const [result] = await connection.execute(
      `INSERT INTO staff_documents 
       (staff_id, document_name, file_name, file_path, file_size, file_type, uploaded_by) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        staff_id,
        document_name,
        req.file.originalname,
        req.file.path,
        req.file.size,
        req.file.mimetype,
        userId,
      ]
    );
    connection.release();

    res.status(201).json({
      id: result.insertId,
      message: 'Document uploaded successfully',
    });
  } catch (error) {
    console.error('Error uploading staff document:', error);
    // Delete uploaded file on error
    if (req.file) {
      fs.unlink(req.file.path, (err) => {
        if (err) console.error('Error deleting file:', err);
      });
    }
    res.status(500).json({ error: 'Failed to upload document' });
  }
});

// Update document details (document_name and optionally file)
router.put('/:id', auth, upload.single('file'), async (req, res) => {
  try {
    const { id } = req.params;
    const { document_name } = req.body;

    const connection = await pool.getConnection();

    // Get existing document
    const [existingDocs] = await connection.execute(
      'SELECT * FROM staff_documents WHERE id = ?',
      [id]
    );

    if (existingDocs.length === 0) {
      connection.release();
      return res.status(404).json({ error: 'Document not found' });
    }

    const existingDoc = existingDocs[0];

    // If new file uploaded, delete old file
    if (req.file && existingDoc.file_path) {
      fs.unlink(existingDoc.file_path, (err) => {
        if (err) console.error('Error deleting old file:', err);
      });
    }

    const newFileName = req.file ? req.file.originalname : existingDoc.file_name;
    const newFilePath = req.file ? req.file.path : existingDoc.file_path;
    const newFileSize = req.file ? req.file.size : existingDoc.file_size;
    const newFileType = req.file ? req.file.mimetype : existingDoc.file_type;

    await connection.execute(
      `UPDATE staff_documents 
       SET document_name = ?, file_name = ?, file_path = ?, file_size = ?, file_type = ?, updated_at = NOW()
       WHERE id = ?`,
      [document_name || existingDoc.document_name, newFileName, newFilePath, newFileSize, newFileType, id]
    );

    connection.release();

    res.json({ message: 'Document updated successfully' });
  } catch (error) {
    console.error('Error updating staff document:', error);
    // Delete uploaded file on error
    if (req.file) {
      fs.unlink(req.file.path, (err) => {
        if (err) console.error('Error deleting file:', err);
      });
    }
    res.status(500).json({ error: 'Failed to update document' });
  }
});

// Delete document
router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;

    const connection = await pool.getConnection();

    // Get document to get file path
    const [documents] = await connection.execute(
      'SELECT file_path FROM staff_documents WHERE id = ?',
      [id]
    );

    if (documents.length === 0) {
      connection.release();
      return res.status(404).json({ error: 'Document not found' });
    }

    const { file_path } = documents[0];

    // Delete from database
    await connection.execute(
      'DELETE FROM staff_documents WHERE id = ?',
      [id]
    );
    connection.release();

    // Delete file from disk
    if (file_path && fs.existsSync(file_path)) {
      fs.unlink(file_path, (err) => {
        if (err) console.error('Error deleting file:', err);
      });
    }

    res.json({ message: 'Document deleted successfully' });
  } catch (error) {
    console.error('Error deleting staff document:', error);
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

// Download document
router.get('/download/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;

    const connection = await pool.getConnection();
    const [documents] = await connection.execute(
      'SELECT * FROM staff_documents WHERE id = ?',
      [id]
    );
    connection.release();

    if (documents.length === 0) {
      return res.status(404).json({ error: 'Document not found' });
    }

    const { file_path, file_name } = documents[0];

    if (!fs.existsSync(file_path)) {
      return res.status(404).json({ error: 'File not found on server' });
    }

    res.download(file_path, file_name);
  } catch (error) {
    console.error('Error downloading document:', error);
    res.status(500).json({ error: 'Failed to download document' });
  }
});

module.exports = router;
