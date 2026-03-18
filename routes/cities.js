const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const auth = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

// Configure storage for city images
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../public/uploads/cities');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueFilename = `city_${uuidv4()}${path.extname(file.originalname)}`;
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

// Get all cities
router.get('/', async (req, res) => {
  try {
    // Extract unique cities from properties table
    const [rows] = await pool.execute(`
      SELECT DISTINCT city as name, city as city_name, COUNT(*) as property_count
      FROM properties 
      WHERE city IS NOT NULL AND city != '' AND status != 'inactive'
      GROUP BY city 
      ORDER BY property_count DESC, city ASC
    `);
    
    res.json(rows);
  } catch (error) {
    logger.error('Error fetching cities:', error);
    res.status(500).json({ error: 'Server error fetching cities' });
  }
});

// Get popular cities
router.get('/popular', async (req, res) => {
  try {
    const { rows: cities } = await pool.execute(
      'SELECT * FROM popular_cities ORDER BY created_at DESC'
    );
    
    // For each city, get property count
    const citiesWithCount = await Promise.all(
      cities.map(async (city) => {
        const [rows] = await pool.execute(
          'SELECT COUNT(*) FROM properties WHERE city LIKE ? AND status = ?',
          [`%${city.city_name}%`, 'available']
        );
        
        return {
          ...city,
          properties_count: parseInt(rows[0].count)
        };
      })
    );
    
    res.json(citiesWithCount);
  } catch (error) {
    res.status(500).json({ error: 'Server error fetching popular cities' });
  }
});

// Get city by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const [rows] = await pool.execute(
      'SELECT * FROM popular_cities WHERE id = ?',
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'City not found' });
    }
    
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error fetching city' });
  }
});

// Create new city (admin only)
router.post('/', auth, upload.single('image'), async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { city_name, state, country } = req.body;
    
    if (!city_name) {
      return res.status(400).json({ error: 'City name is required' });
    }
    
    let image_url = null;
    
    if (req.file) {
      image_url = `/uploads/cities/${req.file.filename}`;
    }
    
    const [result] = await pool.execute(
      `INSERT INTO popular_cities (city_name, state, country, image_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, NOW(), NOW())`,
      [city_name, state || null, country || 'India', image_url]
    );
    
    // Get the inserted record
    const [newCity] = await pool.execute(
      'SELECT * FROM popular_cities WHERE id = ?',
      [result.insertId]
    );
    
    res.status(201).json(newCity[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error creating city' });
  }
});

// Update city (admin only)
router.put('/:id', auth, upload.single('image'), async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { city_name, state, country } = req.body;
    
    if (!city_name) {
      return res.status(400).json({ error: 'City name is required' });
    }
    
    // Get current city data
    const [rows] = await pool.execute(
      'SELECT * FROM popular_cities WHERE id = ?',
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'City not found' });
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
      
      image_url = `/uploads/cities/${req.file.filename}`;
    }
    
    const [result] = await pool.execute(
      `UPDATE popular_cities
       SET city_name = ?, state = ?, country = ?, image_url = ?, updated_at = NOW()
       WHERE id = ?`,
      [city_name, state, country, image_url, id]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'City not found' });
    }
    
    // Get the updated record
    const [updatedCity] = await pool.execute(
      'SELECT * FROM popular_cities WHERE id = ?',
      [id]
    );
    
    res.json(updatedCity[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error updating city' });
  }
});

// Delete city (admin only)
router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    // Get city data to delete image
    const [rows] = await pool.execute(
      'SELECT image_url FROM popular_cities WHERE id = ?',
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'City not found' });
    }
    
    // Delete image if exists
    if (rows[0].image_url) {
      const imagePath = path.join(__dirname, '../public', rows[0].image_url);
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    }
    
    // Delete city
    await pool.execute('DELETE FROM popular_cities WHERE id = ?', [id]);
    
    res.json({ success: true, message: 'City deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: 'Server error deleting city' });
  }
});

module.exports = router;