const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const auth = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');
const logger = require('../utils/logger');

// Debug route to test if propertyBlockConfig routes are working
router.get('/debug', (req, res) => {
  res.json({ 
    message: 'Property block configuration routes are accessible!', 
    timestamp: new Date().toISOString(),
    routes: [
      'GET /debug',
      'GET /:propertyId',
      'POST /:propertyId',
      'PUT /:propertyId/:id',
      'DELETE /:propertyId/:id',
      'DELETE /:propertyId/clear-all',
      'POST /:propertyId/bulk'
    ]
  });
});

// Get all block configurations for a specific property
router.get('/:propertyId', async (req, res) => {
  try {
    const { propertyId } = req.params;
    
    // Validate propertyId
    if (!propertyId || isNaN(propertyId)) {
      return res.status(400).json({ error: 'Valid property ID is required' });
    }
    
    // Check if property exists
    const [propertyCheck] = await pool.execute(
      'SELECT id FROM properties WHERE id = ?',
      [propertyId]
    );
    
    if (propertyCheck.length === 0) {
      return res.status(404).json({ error: 'Property not found' });
    }
    
    const [rows] = await pool.execute(
      `SELECT id, property_id, name, floors, created_at, updated_at 
       FROM property_block_configurations 
       WHERE property_id = ?
       ORDER BY name ASC`,
      [propertyId]
    );
    
    res.json(rows);
  } catch (error) {
    logger.error('❌ Error fetching property block configurations:', error.message);
    logger.error('Error code:', error.code);
    logger.error('SQL State:', error.sqlState);
    
    if (error.code === 'ER_NO_SUCH_TABLE') {
      logger.dev('⚠️  Property block configurations table does not exist - returning empty array');
      return res.json([]); // Return empty array instead of error
    }
    
    res.status(500).json({ 
      error: 'Server error fetching property block configurations',
      detail: error.message,
      code: error.code
    });
  }
});

// Add a new block configuration for a specific property (admin only)
router.post('/:propertyId', auth, adminAuth, async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { name, floors } = req.body;
    
    // Validate propertyId
    if (!propertyId || isNaN(propertyId)) {
      return res.status(400).json({ error: 'Valid property ID is required' });
    }
    
    if (!name || name.trim() === '') {
      return res.status(400).json({ error: 'Block name is required' });
    }
    
    const floorsCount = parseInt(floors);
    if (isNaN(floorsCount) || floorsCount < 0) {
      return res.status(400).json({ error: 'Floors must be a non-negative integer' });
    }
    
    // Check if property exists
    const [propertyCheck] = await pool.execute(
      'SELECT id FROM properties WHERE id = ?',
      [propertyId]
    );
    
    if (propertyCheck.length === 0) {
      return res.status(404).json({ error: 'Property not found' });
    }
    
    // Check if block name already exists for this property (case insensitive)
    const [existingBlock] = await pool.execute(
      'SELECT id FROM property_block_configurations WHERE property_id = ? AND LOWER(name) = LOWER(?)',
      [propertyId, name.trim()]
    );
    
    if (existingBlock.length > 0) {
      return res.status(400).json({ error: 'A block with this name already exists for this property' });
    }
    
    const [result] = await pool.execute(
      `INSERT INTO property_block_configurations (property_id, name, floors) 
       VALUES (?, ?, ?)`,
      [propertyId, name.trim(), floorsCount]
    );
    
    // Get the inserted record
    const [newBlock] = await pool.execute(
      'SELECT * FROM property_block_configurations WHERE id = ?',
      [result.insertId]
    );
    
    res.status(201).json(newBlock[0]);
  } catch (error) {
    logger.error('❌ Error adding property block configuration:', error.message);
    logger.error('Error code:', error.code);
    logger.error('SQL State:', error.sqlState);
    logger.error('Request body:', JSON.stringify(req.body, null, 2));
    
    // Handle specific database errors
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ 
        error: 'A block with this name already exists for this property',
        detail: 'Block names must be unique within each property',
        code: error.code
      });
    }
    
    if (error.code === 'ER_BAD_NULL_ERROR') {
      return res.status(400).json({ 
        error: 'Missing required field', 
        detail: 'Property ID and block name are required',
        code: error.code
      });
    }
    
    if (error.code === 'ER_NO_SUCH_TABLE') {
      return res.status(500).json({ 
        error: 'Database schema error', 
        detail: 'Property block configurations table does not exist',
        code: error.code
      });
    }
    
    res.status(500).json({ 
      error: 'Server error adding property block configuration',
      detail: error.message,
      code: error.code,
      sqlState: error.sqlState
    });
  }
});

// Update a block configuration for a specific property (admin only)
router.put('/:propertyId/:id', auth, adminAuth, async (req, res) => {
  try {
    const { propertyId, id } = req.params;
    const { name, floors } = req.body;
    
    // Validate parameters
    if (!propertyId || isNaN(propertyId)) {
      return res.status(400).json({ error: 'Valid property ID is required' });
    }
    
    if (!id || isNaN(id)) {
      return res.status(400).json({ error: 'Valid block configuration ID is required' });
    }
    
    if (!name || name.trim() === '') {
      return res.status(400).json({ error: 'Block name is required' });
    }
    
    const floorsCount = parseInt(floors);
    if (isNaN(floorsCount) || floorsCount < 0) {
      return res.status(400).json({ error: 'Floors must be a non-negative integer' });
    }
    
    // Check if block exists for this property
    const [blockCheck] = await pool.execute(
      'SELECT id FROM property_block_configurations WHERE id = ? AND property_id = ?',
      [id, propertyId]
    );
    
    if (blockCheck.length === 0) {
      return res.status(404).json({ error: 'Block configuration not found for this property' });
    }
    
    // Check if the new name already exists for a different block in this property (case insensitive)
    const [existingBlock] = await pool.execute(
      'SELECT id FROM property_block_configurations WHERE property_id = ? AND LOWER(name) = LOWER(?) AND id != ?',
      [propertyId, name.trim(), id]
    );
    
    if (existingBlock.length > 0) {
      return res.status(400).json({ error: 'A block with this name already exists for this property' });
    }
    
    const [result] = await pool.execute(
      `UPDATE property_block_configurations 
       SET name = ?, floors = ?, updated_at = NOW() 
       WHERE id = ? AND property_id = ?`,
      [name.trim(), floorsCount, id, propertyId]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Block configuration not found for this property' });
    }
    
    // Get the updated record
    const [updatedBlock] = await pool.execute(
      'SELECT * FROM property_block_configurations WHERE id = ? AND property_id = ?',
      [id, propertyId]
    );
    
    res.json(updatedBlock[0]);
  } catch (error) {
    logger.error('❌ Error updating property block configuration:', error.message);
    res.status(500).json({ error: 'Server error updating property block configuration' });
  }
});

// Delete a block configuration for a specific property (admin only)
router.delete('/:propertyId/:id', auth, adminAuth, async (req, res) => {
  try {
    const { propertyId, id } = req.params;
    
    // Validate parameters
    if (!propertyId || isNaN(propertyId)) {
      return res.status(400).json({ error: 'Valid property ID is required' });
    }
    
    if (!id || isNaN(id)) {
      return res.status(400).json({ error: 'Valid block configuration ID is required' });
    }
    
    // Check if block exists for this property
    const [blockCheck] = await pool.execute(
      'SELECT id, name FROM property_block_configurations WHERE id = ? AND property_id = ?',
      [id, propertyId]
    );
    
    if (blockCheck.length === 0) {
      return res.status(404).json({ error: 'Block configuration not found for this property' });
    }
    
    // Check if this block is referenced in any property plans for this property
    const [planCheck] = await pool.execute(
      `SELECT id FROM property_plans 
       WHERE property_id = ? AND (block = ? OR related_block = ?)
       LIMIT 1`,
      [propertyId, blockCheck[0].name, blockCheck[0].name]
    );
    
    if (planCheck.length > 0) {
      return res.status(400).json({ 
        error: 'Cannot delete this block as it is used in property plans',
        warning: true
      });
    }
    
    await pool.execute(
      'DELETE FROM property_block_configurations WHERE id = ? AND property_id = ?', 
      [id, propertyId]
    );
    
    res.json({ success: true });
  } catch (error) {
    logger.error('❌ Error deleting property block configuration:', error.message);
    logger.error('Error code:', error.code);
    logger.error('SQL State:', error.sqlState);
    
    if (error.code === 'ER_NO_SUCH_TABLE') {
      return res.status(500).json({ 
        error: 'Database schema error', 
        detail: 'Property block configurations table does not exist',
        code: error.code
      });
    }
    
    res.status(500).json({ 
      error: 'Server error deleting property block configuration',
      detail: error.message,
      code: error.code,
      sqlState: error.sqlState
    });
  }
});

// Clear all block configurations for a specific property (admin only)
router.delete('/:propertyId/clear-all', auth, adminAuth, async (req, res) => {
  try {
    const { propertyId } = req.params;
    
    // Validate propertyId
    if (!propertyId || isNaN(propertyId)) {
      return res.status(400).json({ error: 'Valid property ID is required' });
    }
    
    // Check if property exists
    const [propertyCheck] = await pool.execute(
      'SELECT id FROM properties WHERE id = ?',
      [propertyId]
    );
    
    if (propertyCheck.length === 0) {
      return res.status(404).json({ error: 'Property not found' });
    }
    
    // First check if table exists
    try {
      await pool.execute('SELECT 1 FROM property_block_configurations LIMIT 1');
    } catch (tableError) {
      if (tableError.code === 'ER_NO_SUCH_TABLE') {
        return res.status(500).json({ 
          error: 'Database schema error', 
          detail: 'Property block configurations table does not exist. Please run the database schema update.',
          code: tableError.code
        });
      }
      throw tableError;
    }
    
    // Delete all block configurations for this property
    const [result] = await pool.execute(
      'DELETE FROM property_block_configurations WHERE property_id = ?',
      [propertyId]
    );
    
    logger.dev(`✅ Cleared ${result.affectedRows} block configurations for property ${propertyId}`);
    
    res.json({ 
      success: true, 
      message: `Cleared ${result.affectedRows} block configurations for this property`,
      deletedCount: result.affectedRows
    });
  } catch (error) {
    logger.error('❌ Error clearing property block configurations:', error.message);
    logger.error('Error code:', error.code);
    logger.error('SQL State:', error.sqlState);
    
    res.status(500).json({ 
      error: 'Server error clearing property block configurations',
      detail: error.message,
      code: error.code,
      sqlState: error.sqlState
    });
  }
});

// Bulk update block configurations for a specific property (admin only)
router.post('/:propertyId/bulk', auth, adminAuth, async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    const { propertyId } = req.params;
    const { blocks } = req.body;
    
    // Validate propertyId
    if (!propertyId || isNaN(propertyId)) {
      return res.status(400).json({ error: 'Valid property ID is required' });
    }
    
    if (!Array.isArray(blocks)) {
      return res.status(400).json({ error: 'Blocks must be an array' });
    }
    
    // Check if property exists
    const [propertyCheck] = await connection.execute(
      'SELECT id FROM properties WHERE id = ?',
      [propertyId]
    );
    
    if (propertyCheck.length === 0) {
      return res.status(404).json({ error: 'Property not found' });
    }
    
    await connection.beginTransaction();
    
    // Clear existing blocks for this property first
    await connection.execute(
      'DELETE FROM property_block_configurations WHERE property_id = ?',
      [propertyId]
    );
    
    const results = [];
    
    for (const block of blocks) {
      if (!block.name || block.name.trim() === '') {
        continue; // Skip blocks without names
      }
      
      const floorsCount = parseInt(block.floors);
      if (isNaN(floorsCount) || floorsCount < 0) {
        continue; // Skip blocks with invalid floor counts
      }
      
      // Insert new block for this property
      const result = await connection.execute(
        `INSERT INTO property_block_configurations (property_id, name, floors) 
         VALUES (?, ?, ?)`,
        [propertyId, block.name.trim(), floorsCount]
      );
      
      results.push({
        id: result.insertId,
        property_id: propertyId,
        name: block.name.trim(),
        floors: floorsCount
      });
    }
    
    await connection.commit();
    
    res.status(200).json(results);
  } catch (error) {
    await connection.rollback();
    
    logger.error('❌ Bulk property block configuration error:', error.message);
    logger.error('Error code:', error.code);
    logger.error('SQL State:', error.sqlState);
    logger.error('Request body:', JSON.stringify(req.body, null, 2));
    
    // Handle specific database errors
    if (error.code === 'ER_NO_SUCH_TABLE') {
      return res.status(500).json({ 
        error: 'Database schema error', 
        detail: 'Property block configurations table does not exist',
        code: error.code
      });
    }
    
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ 
        error: 'Duplicate block name', 
        detail: 'A block with this name already exists for this property',
        code: error.code
      });
    }
    
    if (error.code === 'ER_BAD_NULL_ERROR') {
      return res.status(400).json({ 
        error: 'Missing required field', 
        detail: 'Property ID and block name are required',
        code: error.code
      });
    }
    
    res.status(500).json({ 
      error: 'Server error updating property block configurations',
      detail: error.message,
      code: error.code,
      sqlState: error.sqlState
    });
  } finally {
    connection.release();
  }
});

module.exports = router;