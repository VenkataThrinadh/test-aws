const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const auth = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');
const logger = require('../utils/logger');

// Debug route to test if blockConfig routes are working
router.get('/debug', (req, res) => {
  res.json({ 
    message: 'Block configuration routes are accessible!', 
    timestamp: new Date().toISOString(),
    serverRestarted: 'Latest code - Route order fixed!',
    routes: [
      'GET /debug',
      'GET /',
      'POST /',
      'PUT /:id',
      'DELETE /clear-all (BEFORE /:id) - FIXED!',
      'DELETE /:id',
      'POST /bulk'
    ]
  });
});

// Get all block configurations
router.get('/', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT id, name, floors, created_at, updated_at 
       FROM block_configurations 
       ORDER BY name ASC`
    );
    
    res.json(rows);
  } catch (error) {
    // Enhanced error logging for debugging
    logger.error('❌ Error fetching block configurations:', error.message);
    logger.error('Error code:', error.code);
    logger.error('SQL State:', error.sqlState);
    
    if (error.code === 'ER_NO_SUCH_TABLE') {
      logger.dev('⚠️  Block configurations table does not exist - returning empty array');
      return res.json([]); // Return empty array instead of error
    }
    
    res.status(500).json({ 
      error: 'Server error fetching block configurations',
      detail: error.message,
      code: error.code
    });
  }
});

// Add a new block configuration (admin only)
router.post('/', auth, adminAuth, async (req, res) => {
  try {
    const { name, floors } = req.body;
    
    if (!name || name.trim() === '') {
      return res.status(400).json({ error: 'Block name is required' });
    }
    
    const floorsCount = parseInt(floors);
    if (isNaN(floorsCount) || floorsCount < 0) {
      return res.status(400).json({ error: 'Floors must be a non-negative integer' });
    }
    
    // Check if block name already exists (case insensitive)
    const [existingBlock] = await pool.execute(
      'SELECT id FROM block_configurations WHERE LOWER(name) = LOWER(?)',
      [name.trim()]
    );
    
    if (existingBlock.length > 0) {
      return res.status(400).json({ error: 'A block with this name already exists' });
    }
    
    const [result] = await pool.execute(
      `INSERT INTO block_configurations (name, floors) 
       VALUES (?, ?)`,
      [name, floors]
    );
    
    // Get the inserted record
    const [newBlock] = await pool.execute(
      'SELECT * FROM block_configurations WHERE id = ?',
      [result.insertId]
    );
    
    res.status(201).json(newBlock[0]);
  } catch (error) {
    // Enhanced error logging for debugging
    logger.error('❌ Error adding block configuration:', error.message);
    logger.error('Error code:', error.code);
    logger.error('SQL State:', error.sqlState);
    logger.error('Request body:', JSON.stringify(req.body, null, 2));
    
    // Handle specific database errors
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ 
        error: 'A block with this name already exists',
        detail: 'Block names must be unique',
        code: error.code
      });
    }
    
    if (error.code === 'ER_BAD_NULL_ERROR') {
      return res.status(400).json({ 
        error: 'Missing required field', 
        detail: 'Block name is required',
        code: error.code
      });
    }
    
    if (error.code === 'ER_NO_SUCH_TABLE') {
      return res.status(500).json({ 
        error: 'Database schema error', 
        detail: 'Block configurations table does not exist',
        code: error.code
      });
    }
    
    // Force detailed error message for debugging
    res.status(500).json({ 
      error: 'Server error adding block configuration',
      detail: error.message,
      code: error.code,
      sqlState: error.sqlState
    });
  }
});

// Update a block configuration (admin only)
router.put('/:id', auth, adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, floors } = req.body;
    
    if (!name || name.trim() === '') {
      return res.status(400).json({ error: 'Block name is required' });
    }
    
    const floorsCount = parseInt(floors);
    if (isNaN(floorsCount) || floorsCount < 0) {
      return res.status(400).json({ error: 'Floors must be a non-negative integer' });
    }
    
    // Check if block exists
    const blockCheck = await pool.execute(
      'SELECT id FROM block_configurations WHERE id = ?',
      [id]
    );
    
    if (blockCheck.length === 0) {
      return res.status(404).json({ error: 'Block configuration not found' });
    }
    
    // Check if the new name already exists for a different block (case insensitive)
    const [existingBlock] = await pool.execute(
      'SELECT id FROM block_configurations WHERE LOWER(name) = LOWER(?) AND id != ?',
      [name.trim(), id]
    );
    
    if (existingBlock.length > 0) {
      return res.status(400).json({ error: 'A block with this name already exists' });
    }
    
    const [result] = await pool.execute(
      `UPDATE block_configurations 
       SET name = ?, floors = ?, updated_at = NOW() 
       WHERE id = ?`,
      [name, floors, id]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Block configuration not found' });
    }
    
    // Get the updated record
    const [updatedBlock] = await pool.execute(
      'SELECT * FROM block_configurations WHERE id = ?',
      [id]
    );
    
    res.json(updatedBlock[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Clear all block configurations (admin only) - MUST be before /:id route
router.delete('/clear-all', auth, adminAuth, async (req, res) => {
  logger.dev('🔥 CLEAR-ALL ROUTE HIT! This route is working!');
  try {
    // First check if table exists
    try {
      await pool.execute('SELECT 1 FROM block_configurations LIMIT 1');
    } catch (tableError) {
      if (tableError.code === 'ER_NO_SUCH_TABLE') {
        return res.status(500).json({ 
          error: 'Database schema error', 
          detail: 'Block configurations table does not exist. Please run the database schema update.',
          code: tableError.code
        });
      }
      throw tableError;
    }
    
    // Delete all block configurations
    const [result] = await pool.execute('DELETE FROM block_configurations');
    
    logger.dev(`✅ Cleared ${result.affectedRows} block configurations`);
    
    res.json({ 
      success: true, 
      message: `Cleared ${result.affectedRows} block configurations`,
      deletedCount: result.affectedRows
    });
  } catch (error) {
    logger.error('❌ Error clearing block configurations:', error.message);
    logger.error('Error code:', error.code);
    logger.error('SQL State:', error.sqlState);
    
    res.status(500).json({ 
      error: 'Server error clearing block configurations',
      detail: error.message,
      code: error.code,
      sqlState: error.sqlState
    });
  }
});

// Delete a block configuration (admin only)
router.delete('/:id', auth, adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if block exists
    const [blockCheck] = await pool.execute(
      'SELECT id FROM block_configurations WHERE id = ?',
      [id]
    );
    
    if (blockCheck.length === 0) {
      return res.status(404).json({ error: 'Block configuration not found' });
    }
    
    // Check if this block is referenced in any property plans
    const [planCheck] = await pool.execute(
      `SELECT id FROM property_plans 
       WHERE block = (SELECT name FROM block_configurations WHERE id = ?)
       OR related_block = (SELECT name FROM block_configurations WHERE id = ?)
       LIMIT 1`,
      [id, id]
    );
    
    if (planCheck.length > 0) {
      return res.status(400).json({ 
        error: 'Cannot delete this block as it is used in property plans',
        warning: true
      });
    }
    
    await pool.execute('DELETE FROM block_configurations WHERE id = ?', [id]);
    
    res.json({ success: true });
  } catch (error) {
    // Enhanced error logging for debugging
    logger.error('❌ Error deleting block configuration:', error.message);
    logger.error('Error code:', error.code);
    logger.error('SQL State:', error.sqlState);
    logger.error('Block ID:', id);
    
    // Handle specific database errors
    if (error.code === 'ER_NO_SUCH_TABLE') {
      return res.status(500).json({ 
        error: 'Database schema error', 
        detail: 'Block configurations table does not exist',
        code: error.code
      });
    }
    
    // Force detailed error message for debugging
    res.status(500).json({ 
      error: 'Server error deleting block configuration',
      detail: error.message,
      code: error.code,
      sqlState: error.sqlState
    });
  }
});

// Bulk update block configurations (admin only)
router.post('/bulk', auth, adminAuth, async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    const { blocks } = req.body;
    
    if (!Array.isArray(blocks)) {
      return res.status(400).json({ error: 'Blocks must be an array' });
    }
    
    await connection.beginTransaction();
    
    // Skip clearing existing blocks for now to avoid complex queries
    // Just process the new blocks without clearing existing ones
    
    const results = [];
    
    for (const block of blocks) {
      if (!block.name || block.name.trim() === '') {
        continue; // Skip blocks without names
      }
      
      const floorsCount = parseInt(block.floors);
      if (isNaN(floorsCount) || floorsCount < 0) {
        continue; // Skip blocks with invalid floor counts
      }
      
      // Check if block already exists
      const [existingBlock] = await connection.execute(
        'SELECT id FROM block_configurations WHERE LOWER(name) = LOWER(?)',
        [block.name.trim()]
      );
      
      let result;
      
      if (existingBlock.length > 0) {
        // Update existing block
        result = await connection.execute(
          `UPDATE block_configurations 
           SET floors = ?, updated_at = NOW() 
           WHERE id = ?`,
          [floorsCount, existingBlock[0].id]
        );
      } else {
        // Insert new block
        result = await connection.execute(
          `INSERT INTO block_configurations (name, floors) 
           VALUES (?, ?)`,
          [block.name.trim(), floorsCount]
        );
      }
      
      results.push({
        id: result.insertId || existingBlock[0]?.id,
        name: block.name.trim(),
        floors: floorsCount
      });
    }
    
    await connection.commit();
    
    res.status(200).json(results);
  } catch (error) {
    await connection.rollback();
    
    // Enhanced error logging for debugging
    logger.error('❌ Bulk block configuration error:', error.message);
    logger.error('Error code:', error.code);
    logger.error('SQL State:', error.sqlState);
    logger.error('Request body:', JSON.stringify(req.body, null, 2));
    
    // Handle specific database errors
    if (error.code === 'ER_NO_SUCH_TABLE') {
      return res.status(500).json({ 
        error: 'Database schema error', 
        detail: 'Block configurations table does not exist',
        code: error.code
      });
    }
    
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ 
        error: 'Duplicate block name', 
        detail: 'A block with this name already exists',
        code: error.code
      });
    }
    
    if (error.code === 'ER_BAD_NULL_ERROR') {
      return res.status(400).json({ 
        error: 'Missing required field', 
        detail: 'Block name is required',
        code: error.code
      });
    }
    
    // Force detailed error message for debugging
    res.status(500).json({ 
      error: 'Server error updating block configurations',
      detail: error.message,
      code: error.code,
      sqlState: error.sqlState
    });
  } finally {
    connection.release();
  }
});

module.exports = router;