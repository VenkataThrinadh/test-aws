const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const auth = require('../middleware/auth');
const logger = require('../utils/logger');

// Get specifications for a property
router.get('/property/:propertyId', async (req, res) => {
  try {
    const { propertyId } = req.params;
    
    // First check if the property exists
    const [propertyCheck] = await pool.execute(
      'SELECT id FROM properties WHERE id = ?',
      [propertyId]
    );
    
    if (propertyCheck.length === 0) {
      logger.dev(`Property not found for ID: ${propertyId}`);
      return res.json([]);
    }
    
    const [rows] = await pool.execute(
      'SELECT * FROM property_specifications WHERE property_id = ? ORDER BY name',
      [propertyId]
    );
    
    res.json(rows);
  } catch (error) {
    logger.error('Error fetching property specifications:', error);
    // Return empty array instead of error
    res.json([]);
  }
});

// Add specification to a property (admin only)
router.post('/', auth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not authorized' });
  }

  try {
    const { propertyId, name, value } = req.body;
    const [result] = await pool.execute(
      'INSERT INTO property_specifications (property_id, name, value) VALUES (?, ?, ?)',
      [propertyId, name, value]
    );
    
    // Get the inserted record
    const [newSpec] = await pool.execute(
      'SELECT * FROM property_specifications WHERE id = ?',
      [result.insertId]
    );
    
    res.status(201).json(newSpec[0]);
  } catch (error) {
    logger.error('Error adding property specification:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update specification (admin only)
router.put('/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not authorized' });
  }

  try {
    const { id } = req.params;
    const { name, value } = req.body;
    
    const [result] = await pool.execute(
      'UPDATE property_specifications SET name = ?, value = ?, updated_at = NOW() WHERE id = ?',
      [name, value, id]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Specification not found' });
    }
    
    // Get the updated record
    const [updatedSpec] = await pool.execute(
      'SELECT * FROM property_specifications WHERE id = ?',
      [id]
    );
    
    res.json(updatedSpec[0]);
  } catch (error) {
    logger.error('Error updating property specification:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete specification (admin only)
router.delete('/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not authorized' });
  }

  try {
    const { id } = req.params;
    await pool.execute('DELETE FROM property_specifications WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting property specification:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;