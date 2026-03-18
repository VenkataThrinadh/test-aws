const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const auth = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// Configure storage for banner images
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../public/uploads/banners');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueFilename = `banner_${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueFilename);
  }
});

const upload = multer({ 
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (extname && mimetype) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed'));
    }
  }
});

// Get all banners
router.get('/', async (req, res) => {
  try {
    const { active } = req.query;
    
    let query = 'SELECT * FROM banners';
    const params = [];
    
    if (active === 'true') {
      query += ' WHERE is_active = true';
    }
    
    query += ' ORDER BY created_at DESC';
    
    const [rows] = await pool.execute(query, params);
    
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Server error fetching banners' });
  }
});

// Get banner by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const [rows] = await pool.execute(
      'SELECT * FROM banners WHERE id = ?',
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Banner not found' });
    }
    
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error fetching banner' });
  }
});

// Create new banner (admin only)
router.post('/', auth, upload.single('image'), async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { title, description, link, is_active } = req.body;
    
    if (!req.file) {
      return res.status(400).json({ error: 'Banner image is required' });
    }
    
    const image_url = `/uploads/banners/${req.file.filename}`;
    
    const [result] = await pool.execute(
      `INSERT INTO banners (image_url, title, description, link, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
      [image_url, title, description, link, is_active === 'true']
    );
    
    // Get the inserted record
    const [newBanner] = await pool.execute(
      'SELECT * FROM banners WHERE id = ?',
      [result.insertId]
    );
    
    res.status(201).json(newBanner[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error creating banner' });
  }
});

// Update banner (admin only)
router.put('/:id', auth, upload.single('image'), async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { title, description, link, is_active } = req.body;
    
    // Get current banner data
    const [rows] = await pool.execute(
      'SELECT * FROM banners WHERE id = ?',
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Banner not found' });
    }
    
    let image_url = rows[0].image_url;
    
    // If new image uploaded, update image_url
    if (req.file) {
      // Delete old image if exists
      if (image_url) {
        const oldImagePath = path.join(__dirname, '../public', image_url);
        if (fs.existsSync(oldImagePath)) {
          fs.unlinkSync(oldImagePath);
        }
      }
      
      image_url = `/uploads/banners/${req.file.filename}`;
    }
    
    const [result] = await pool.execute(
      `UPDATE banners
       SET image_url = ?, title = ?, description = ?, link = ?, is_active = ?, updated_at = NOW()
       WHERE id = ?`,
      [image_url, title, description, link, is_active === 'true', id]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Banner not found' });
    }
    
    // Get the updated record
    const [updatedBanner] = await pool.execute(
      'SELECT * FROM banners WHERE id = ?',
      [id]
    );
    
    res.json(updatedBanner[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error updating banner' });
  }
});

// Delete banner (admin only)
router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    // Get banner data to delete image
    const [rows] = await pool.execute(
      'SELECT image_url FROM banners WHERE id = ?',
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Banner not found' });
    }
    
    // Delete image if exists
    if (rows[0].image_url) {
      const imagePath = path.join(__dirname, '../public', rows[0].image_url);
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    }
    
    // Delete banner
    await pool.execute('DELETE FROM banners WHERE id = ?', [id]);
    
    res.json({ success: true, message: 'Banner deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Server error deleting banner' });
  }
});

// Toggle banner active status (admin only)
router.put('/:id/toggle-active', auth, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    // Get current banner data
    const [rows] = await pool.execute(
      'SELECT is_active FROM banners WHERE id = ?',
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Banner not found' });
    }
    
    const is_active = !rows[0].is_active;
    
    const [result] = await pool.execute(
      'UPDATE banners SET is_active = ?, updated_at = NOW() WHERE id = ?',
      [is_active, id]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Banner not found' });
    }
    
    // Get the updated record
    const [updatedBanner] = await pool.execute(
      'SELECT * FROM banners WHERE id = ?',
      [id]
    );
    
    res.json(updatedBanner[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error toggling banner active status' });
  }
});

module.exports = router;