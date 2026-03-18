const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const auth = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

// Configure storage for plan images
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../public/uploads/plans');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueFilename = `plan_${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueFilename);
  }
});

// Custom file filter function
const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif|webp|pdf/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);
  
  if (extname && mimetype) {
    return cb(null, true);
  } else {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('File type rejected:', file.mimetype);
      logger.error('File extension:', path.extname(file.originalname).toLowerCase());
    }
    return cb(new Error(`Only image and PDF files are allowed. Received: ${file.mimetype}`));
  }
};

const upload = multer({ 
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter
});

// Error handling middleware for multer
const handleMulterError = (err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Multer error:', err.message);
    }
    return res.status(400).json({ error: 'File upload error', message: err.message });
  } else if (err) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Upload error:', err.message);
    }
    return res.status(500).json({ error: 'Server error', message: err.message });
  }
  next();
};

// Get plans for a property
router.get('/property/:propertyId', async (req, res) => {
  try {
    const { propertyId } = req.params;
    
    // First check if the property exists
    const [propertyCheck] = await pool.execute(
      'SELECT id FROM properties WHERE id = ?',
      [propertyId]
    );
    
    if (propertyCheck.length === 0) {
      return res.json([]);
    }
    
    const [rows] = await pool.execute(
      `SELECT * FROM property_plans 
       WHERE property_id = ? 
       ORDER BY 
         plan_type, 
         CASE WHEN block IS NULL THEN 1 ELSE 0 END, 
         block, 
         CASE WHEN floor IS NULL THEN 1 ELSE 0 END, 
         floor, 
         title`,
      [propertyId]
    );
    
    res.json(rows);
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error fetching property plans:', error);
    }
    // Return empty array instead of error
    res.json([]);
  }
});

// Add basic plan without file upload (admin only) - for simple plans
router.post('/basic', auth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not authorized' });
  }
  
  try {
    const { propertyId, name, area, price, description } = req.body;
    
    if (!propertyId || !name) {
      return res.status(400).json({ error: 'Property ID and name are required' });
    }
    
    const [result] = await pool.execute(
      `INSERT INTO property_plans 
       (property_id, title, description, plan_type, area, price) 
       VALUES (?, ?, ?, ?, ?, ?)`,
      [propertyId, name, description || '', 'floor_plan', area || null, price || null]
    );
    
    // Get the inserted record
    const [newPlan] = await pool.execute(
      'SELECT * FROM property_plans WHERE id = ?',
      [result.insertId]
    );
    
    res.status(201).json(newPlan[0]);
  } catch (error) {
    logger.error('Error adding basic property plan:', error);
    res.status(500).json({ error: 'Failed to add property plan' });
  }
});

// Add plan to a property (admin only)
router.post('/', auth, (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not authorized' });
  }
  
  upload.single('file')(req, res, (err) => {
    if (err) {
      // Only log errors in development environment
      if (process.env.NODE_ENV === 'development') {
        logger.error('Plan upload error:', err.message);
      }
      return res.status(400).json({ error: 'File upload error', message: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const { propertyId, title, description, planType, block, floor, relatedBlock } = req.body;
    const filePath = `/uploads/plans/${req.file.filename}`;
    
    const [result] = await pool.execute(
      `INSERT INTO property_plans 
       (property_id, title, description, image_url, plan_type, block, floor, related_block) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [propertyId, title, description, filePath, planType, block || null, floor || null, relatedBlock || null]
    );
    
    // Get the inserted record
    const [newPlan] = await pool.execute(
      'SELECT * FROM property_plans WHERE id = ?',
      [result.insertId]
    );
    
    const publicUrl = `${req.protocol}://${req.get('host')}${filePath}`;
    
    res.status(201).json({
      ...newPlan[0],
      publicUrl
    });
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error adding property plan:', error);
    }
    res.status(500).json({ error: 'Server error', message: error.message });
  }
});

// Set plan as primary (admin only)
router.put('/:id/primary', auth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not authorized' });
  }

  try {
    const { id } = req.params;
    
    // Get the plan to find the property_id
    const [planResult] = await pool.execute(
      'SELECT property_id, plan_type FROM property_plans WHERE id = ?',
      [id]
    );
    
    if (planResult.length === 0) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    
    const { property_id, plan_type } = planResult[0];
    
    // Reset primary status for all plans of the same type for this property
    await pool.execute(
      'UPDATE property_plans SET is_primary = false WHERE property_id = ? AND plan_type = ?',
      [property_id, plan_type]
    );
    
    // Set this plan as primary
    const [result] = await pool.execute(
      'UPDATE property_plans SET is_primary = true, updated_at = NOW() WHERE id = ?',
      [id]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Plan not found' });
    }
    
    // Get the updated plan
    const [updatedPlan] = await pool.execute(
      'SELECT * FROM property_plans WHERE id = ?',
      [id]
    );
    
    res.json(updatedPlan[0]);
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error setting primary plan:', error);
    }
    res.status(500).json({ error: 'Server error' });
  }
});

// Update plan (admin only)
router.put('/:id', auth, (req, res, next) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not authorized' });
  }

  upload.single('file')(req, res, (err) => {
    if (err) {
      // Only log errors in development environment
      if (process.env.NODE_ENV === 'development') {
        logger.error('Plan update upload error:', err.message);
      }
      return res.status(400).json({ error: 'File upload error', message: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, description, block, floor, relatedBlock } = req.body;

    // Get the existing plan
    const [existingPlan] = await pool.execute(
      'SELECT * FROM property_plans WHERE id = ?',
      [id]
    );

    if (existingPlan.length === 0) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    let imagePath = existingPlan[0].image_url; // Keep existing image by default

    // If a new image is uploaded, handle it
    if (req.file) {
      const newImagePath = `/uploads/plans/${req.file.filename}`;

      // Delete the old image file if it exists
      if (existingPlan[0].image_url) {
        const oldImageFullPath = path.join(__dirname, '../public', existingPlan[0].image_url);
        if (fs.existsSync(oldImageFullPath)) {
          fs.unlinkSync(oldImageFullPath);
        }
      }

      imagePath = newImagePath;
    }

    // Update the plan in the database
    const [result] = await pool.execute(
      `UPDATE property_plans
       SET title = ?, description = ?, image_url = ?,
           block = ?, floor = ?, related_block = ?, updated_at = NOW()
       WHERE id = ?`,
      [
        title || existingPlan[0].title,
        description || existingPlan[0].description,
        imagePath,
        block || null,
        floor || null,
        relatedBlock || null,
        id
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Plan not found' });
    }

    // Get the updated record
    const [updatedPlan] = await pool.execute(
      'SELECT * FROM property_plans WHERE id = ?',
      [id]
    );

    const publicUrl = `${req.protocol}://${req.get('host')}${imagePath}`;

    res.json({
      ...updatedPlan[0],
      publicUrl
    });
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error updating property plan:', error);
    }
    res.status(500).json({ error: 'Server error', message: error.message });
  }
});

// Delete plan (admin only)
router.delete('/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not authorized' });
  }

  try {
    const { id } = req.params;
    
    // Get the plan to find the image path
    const [planResult] = await pool.execute('SELECT image_url FROM property_plans WHERE id = ?', [id]);
    
    if (planResult.length > 0) {
      const imagePath = planResult[0].image_url;
      
      // Delete the plan from the database
      await pool.execute('DELETE FROM property_plans WHERE id = ?', [id]);
      
      // Delete the image file
      const fullPath = path.join(__dirname, '../public', imagePath);
      if (fs.existsSync(fullPath)) {
        fs.unlinkSync(fullPath);
      }
      
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'Plan not found' });
    }
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error deleting property plan:', error);
    }
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;