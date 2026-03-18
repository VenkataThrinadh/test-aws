const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db');
const auth = require('../middleware/auth');
const logger = require('../utils/logger');

// Configure storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '../public/uploads');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const uniqueFilename = `${uuidv4()}${path.extname(file.originalname)}`;
    cb(null, uniqueFilename);
  }
});

// Custom file filter function
const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif|webp/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype);
  
  if (extname && mimetype) {
    return cb(null, true);
  } else {
    return cb(new Error(`Only image files are allowed. Received: ${file.mimetype}`));
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

// Generic upload endpoint for any folder
router.post('/:folder', auth, (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) {
      // Only log errors in development environment
      if (process.env.NODE_ENV === 'development') {
        logger.error(`Upload error for folder ${req.params.folder}:`, err.message);
      }
      return res.status(400).json({ error: 'File upload error', message: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    const { folder } = req.params;
    
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    // Create folder if it doesn't exist
    const folderPath = path.join(__dirname, `../public/uploads/${folder}`);
    if (!fs.existsSync(folderPath)) {
      fs.mkdirSync(folderPath, { recursive: true });
    }
    
    // Move file to the specific folder
    const oldPath = req.file.path;
    const newFileName = `${folder}_${req.file.filename}`;
    const newPath = path.join(folderPath, newFileName);
    
    fs.renameSync(oldPath, newPath);
    
    const filePath = `/uploads/${folder}/${newFileName}`;
    const publicUrl = `${req.protocol}://${req.get('host')}${filePath}`;
    
    res.json({ 
      success: true, 
      filePath,
      publicUrl
    });
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error(`File upload error to ${req.params.folder}:`, error);
    }
    res.status(500).json({ error: 'Server error during file upload', message: error.message });
  }
});

// Upload avatar
router.post('/avatar', auth, (req, res, next) => {
  upload.single('avatar')(req, res, (err) => {
    if (err) {
      // Only log errors in development environment
      if (process.env.NODE_ENV === 'development') {
        logger.error('Avatar upload error:', err.message);
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
    
    // Create avatars directory if it doesn't exist
    const avatarsDir = path.join(__dirname, '../public/uploads/avatars');
    if (!fs.existsSync(avatarsDir)) {
      fs.mkdirSync(avatarsDir, { recursive: true });
    }
    
    // Move file to avatars directory
    const oldPath = req.file.path;
    const newFileName = `avatar_${req.user.id}_${Date.now()}${path.extname(req.file.originalname)}`;
    const newPath = path.join(avatarsDir, newFileName);
    
    fs.renameSync(oldPath, newPath);
    
    const filePath = `/uploads/avatars/${newFileName}`;
    const publicUrl = `${req.protocol}://${req.get('host')}${filePath}`;
    
    // Update user profile with new avatar URL
    await pool.execute(
      'UPDATE profiles SET avatar_url = ?, updated_at = NOW() WHERE id = ?',
      [filePath, req.user.id]
    );
    
    res.json({ 
      success: true, 
      filePath,
      publicUrl
    });
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Avatar upload error:', error);
    }
    res.status(500).json({ error: 'Server error during file upload', message: error.message });
  }
});

// Upload property images
router.post('/property-images/:propertyId', auth, (req, res, next) => {
  upload.array('images', 10)(req, res, (err) => {
    if (err) {
      // Only log errors in development environment
      if (process.env.NODE_ENV === 'development') {
        logger.error(`Upload error for property ${req.params.propertyId}:`, err.message);
      }
      return res.status(400).json({ error: 'File upload error', message: err.message });
    }
    next();
  });
}, async (req, res) => {
  try {
    const { propertyId } = req.params;
    
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }
    
    // Check if user owns the property or is admin
    const [propertyCheck] = await pool.execute(
      `SELECT * FROM properties WHERE id = ? AND (owner_id = ? OR ? = 'admin')`,
      [propertyId, req.user.id, req.user.role]
    );
    
    if (propertyCheck.length === 0) {
      return res.status(403).json({ error: 'Not authorized to upload images for this property' });
    }
    
    // Create property images directory if it doesn't exist
    const propertyImagesDir = path.join(__dirname, '../public/uploads/properties', propertyId);
    if (!fs.existsSync(propertyImagesDir)) {
      fs.mkdirSync(propertyImagesDir, { recursive: true });
    }
    
    // Move files to property-specific directory and save to database
    const imageInsertPromises = req.files.map(async (file, index) => {
      // Move file to property-specific directory
      const oldPath = file.path;
      const newFileName = `property_${propertyId}_${index}_${Date.now()}${path.extname(file.originalname)}`;
      const newPath = path.join(propertyImagesDir, newFileName);
      fs.renameSync(oldPath, newPath);
      const filePath = `/uploads/properties/${propertyId}/${newFileName}`;
      const [result] = await pool.execute(
        'INSERT INTO property_images (property_id, image_url, is_primary) VALUES (?, ?, ?)',
        [propertyId, filePath, index === 0]
      );
      return { id: result.insertId, filePath };
    });
    
    const results = await Promise.all(imageInsertPromises);
    
    const responseImages = req.files.map((file, index) => {
      const imageUrl = `/uploads/properties/${propertyId}/${path.basename(file.path)}`;
      const fullUrl = `${req.protocol}://${req.get('host')}${imageUrl}`;
      return {
        id: results[index].id,
        image_url: imageUrl,
        url: imageUrl,
        publicUrl: fullUrl,
        isPrimary: index === 0
      };
    });
    
    res.json({
      success: true,
      images: responseImages
    });
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Property images upload error:', error);
    }
    res.status(500).json({ error: 'Server error during file upload', detail: error.message });
  }
});

// Delete property image
router.delete('/property-images/:imageId', auth, async (req, res) => {
  try {
    const { imageId } = req.params;
    
    // Get image details
    const [imageResult] = await pool.execute(
      'SELECT pi.*, p.owner_id FROM property_images pi JOIN properties p ON pi.property_id = p.id WHERE pi.id = ?',
      [imageId]
    );
    
    if (imageResult.length === 0) {
      return res.status(404).json({ error: 'Image not found' });
    }
    
    const image = imageResult[0];
    
    // Check if user owns the property or is admin
    if (image.owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to delete this image' });
    }
    
    // Delete file from filesystem
    const filePath = path.join(__dirname, '../public', image.image_url);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    
    // Delete from database
    await pool.execute('DELETE FROM property_images WHERE id = ?', [imageId]);
    
    res.json({ success: true, message: 'Image deleted successfully' });
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error deleting image:', error);
    }
    res.status(500).json({ error: 'Server error deleting image' });
  }
});

// Set primary image
router.put('/property-images/:imageId/primary', auth, async (req, res) => {
  try {
    const { imageId } = req.params;
    
    // Get image details
    const [imageResult] = await pool.execute(
      'SELECT pi.*, p.owner_id FROM property_images pi JOIN properties p ON pi.property_id = p.id WHERE pi.id = ?',
      [imageId]
    );
    
    if (imageResult.length === 0) {
      return res.status(404).json({ error: 'Image not found' });
    }
    
    const image = imageResult[0];
    
    // Check if user owns the property or is admin
    if (image.owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to update this image' });
    }
    
    // Reset all images for this property to not primary
    await pool.execute(
      'UPDATE property_images SET is_primary = false WHERE property_id = ?',
      [image.property_id]
    );
    
    // Set this image as primary
    await pool.execute(
      'UPDATE property_images SET is_primary = true WHERE id = ?',
      [imageId]
    );
    
    res.json({ success: true, message: 'Primary image updated successfully' });
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error updating primary image:', error);
    }
    res.status(500).json({ error: 'Server error updating primary image' });
  }
});

module.exports = router;