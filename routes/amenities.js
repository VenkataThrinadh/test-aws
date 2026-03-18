const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const auth = require('../middleware/auth');
const logger = require('../utils/logger');

// Get amenities for a property
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
      'SELECT id, property_id, name, value, created_at FROM property_amenities WHERE property_id = ? ORDER BY name',
      [propertyId]
    );
    
    // Add icon field for frontend compatibility (icon = value)
    const amenitiesWithIcon = rows.map(amenity => ({
      ...amenity,
      icon: amenity.value || 'checkmark-circle-outline'
    }));
    
    res.json(amenitiesWithIcon);
  } catch (error) {
    // Return empty array instead of error
    res.json([]);
  }
});

// Add amenity to a property (admin only)
router.post('/', auth, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'sub-admin') {
    return res.status(403).json({ error: 'Not authorized' });
  }

  try {
    const { propertyId, name, icon, value } = req.body;
    // Use 'value' field if provided, otherwise use 'icon' for backward compatibility
    const amenityValue = value || icon || '';
    const [result] = await pool.execute(
      'INSERT INTO property_amenities (property_id, name, value) VALUES (?, ?, ?)',
      [propertyId, name, amenityValue]
    );
    
    // Get the inserted record
    const [newAmenity] = await pool.execute(
      'SELECT id, property_id, name, value, created_at FROM property_amenities WHERE id = ?',
      [result.insertId]
    );
    
    // Add icon field for frontend compatibility
    const amenityWithIcon = {
      ...newAmenity[0],
      icon: newAmenity[0].value || 'checkmark-circle-outline'
    };
    
    res.status(201).json(amenityWithIcon);
  } catch (error) {
    // Enhanced error logging for debugging
    logger.error('❌ Error adding amenity:', error.message);
    logger.error('Error code:', error.code);
    logger.error('SQL State:', error.sqlState);
    logger.error('Request body:', JSON.stringify(req.body, null, 2));
    
    // Handle specific database errors
    if (error.code === 'ER_NO_REFERENCED_ROW_2') {
      return res.status(400).json({ 
        error: 'Invalid property reference', 
        detail: 'The specified property does not exist',
        code: error.code
      });
    }
    
    if (error.code === 'ER_BAD_NULL_ERROR') {
      return res.status(400).json({ 
        error: 'Missing required field', 
        detail: 'Property ID and name are required',
        code: error.code
      });
    }
    
    if (error.code === 'ER_NO_SUCH_TABLE') {
      return res.status(500).json({ 
        error: 'Database schema error', 
        detail: 'Property amenities table does not exist',
        code: error.code
      });
    }
    
    // Force detailed error message for debugging
    res.status(500).json({ 
      error: 'Server error adding amenity',
      detail: error.message,
      code: error.code,
      sqlState: error.sqlState
    });
  }
});

// Update amenity (admin only)
router.put('/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'sub-admin') {
    return res.status(403).json({ error: 'Not authorized' });
  }

  try {
    const { id } = req.params;
    const { name, icon, value } = req.body;
    
    // Use 'value' field if provided, otherwise use 'icon' for backward compatibility
    const amenityValue = value || icon || '';
    
    // First check if the amenity exists
    const [existingAmenity] = await pool.execute(
      'SELECT * FROM property_amenities WHERE id = ?',
      [id]
    );
    
    if (existingAmenity.length === 0) {
      return res.status(404).json({ error: 'Amenity not found' });
    }
    
    // Update the amenity
    await pool.execute(
      'UPDATE property_amenities SET name = ?, value = ? WHERE id = ?',
      [name, amenityValue, id]
    );
    
    // Get the updated record
    const [updatedAmenity] = await pool.execute(
      'SELECT id, property_id, name, value, created_at FROM property_amenities WHERE id = ?',
      [id]
    );
    
    // Add icon field for frontend compatibility
    const amenityWithIcon = {
      ...updatedAmenity[0],
      icon: updatedAmenity[0].value || 'checkmark-circle-outline'
    };
    
    res.json(amenityWithIcon);
  } catch (error) {
    // Enhanced error logging for debugging
    logger.error('❌ Error updating amenity:', error.message);
    logger.error('Error code:', error.code);
    logger.error('SQL State:', error.sqlState);
    logger.error('Amenity ID:', req.params.id);
    logger.error('Request body:', JSON.stringify(req.body, null, 2));
    
    // Handle specific database errors
    if (error.code === 'ER_BAD_NULL_ERROR') {
      return res.status(400).json({ 
        error: 'Missing required field', 
        detail: 'Name is required',
        code: error.code
      });
    }
    
    if (error.code === 'ER_NO_SUCH_TABLE') {
      return res.status(500).json({ 
        error: 'Database schema error', 
        detail: 'Property amenities table does not exist',
        code: error.code
      });
    }
    
    // Force detailed error message for debugging
    res.status(500).json({ 
      error: 'Server error updating amenity',
      detail: error.message,
      code: error.code,
      sqlState: error.sqlState
    });
  }
});

// Delete amenity (admin only)
router.delete('/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin' && req.user.role !== 'sub-admin') {
    return res.status(403).json({ error: 'Not authorized' });
  }

  try {
    const { id } = req.params;
    await pool.execute('DELETE FROM property_amenities WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    // Enhanced error logging for debugging
    logger.error('❌ Error deleting amenity:', error.message);
    logger.error('Error code:', error.code);
    logger.error('Amenity ID:', id);
    
    res.status(500).json({ 
      error: 'Server error deleting amenity',
      detail: error.message,
      code: error.code
    });
  }
});

module.exports = router;