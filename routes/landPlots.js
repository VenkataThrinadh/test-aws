const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const auth = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');
const logger = require('../utils/logger');

// Debug route to test if landPlots routes are working
router.get('/debug', (req, res) => {
  res.json({ 
    message: 'Land plots routes are accessible!', 
    timestamp: new Date().toISOString(),
    routes: [
      'GET /debug',
      'GET /property/:propertyId (GET ALL PLOTS)',
      'GET /property/:propertyId/blocks',
      'POST /blocks',
      'PUT /property/:propertyId/blocks/bulk (BULK UPDATE)',
      'GET /property/:propertyId/configuration',
      'POST /plots (CREATE PLOT)',
      'PUT /plots/:plotId (UPDATE PLOT)',
      'PUT /:plotId (UPDATE PLOT - ALTERNATIVE)',
      'DELETE /plots/:plotId (DELETE PLOT)',
      'DELETE /:plotId (DELETE PLOT - ALTERNATIVE)'
    ]
  });
});

// Test database connection for land plots
router.get('/debug/db', async (req, res) => {
  try {
    const [result] = await pool.execute('SELECT 1 as test');
    const [tablesCheck] = await pool.execute(`
      SELECT TABLE_NAME 
      FROM INFORMATION_SCHEMA.TABLES 
      WHERE TABLE_SCHEMA = DATABASE() 
      AND TABLE_NAME IN ('land_blocks', 'land_plots', 'property_land_configurations')
    `);
    
    // Check land_plots table structure
    const [plotsStructure] = await pool.execute(`
      SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
      AND TABLE_NAME = 'land_plots'
      ORDER BY ORDINAL_POSITION
    `);
    
    res.json({
      message: 'Database connection successful',
      test: result[0],
      tables: tablesCheck.map(t => t.TABLE_NAME),
      land_plots_structure: plotsStructure,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      error: 'Database connection failed',
      detail: error.message,
      code: error.code
    });
  }
});

// Debug endpoint to test adding a plot (no auth required for testing)
router.post('/debug/add-plot', async (req, res) => {
  try {
    const { block_id, plot_number, area, price, status, description, dimensions, facing } = req.body;
    
    logger.dev('Debug add plot request:', { block_id, plot_number, area, price, status, description, dimensions, facing });
    
    // Test the exact same logic as the real add plot endpoint
    if (!block_id || !plot_number || !area || !price) {
      return res.status(400).json({ error: 'Block ID, plot number, area, and price are required' });
    }
    
    // Check if block exists
    const [blockCheck] = await pool.execute(
      'SELECT id, name FROM land_blocks WHERE id = ?',
      [block_id]
    );
    
    if (blockCheck.length === 0) {
      return res.status(404).json({ error: 'Block not found' });
    }
    
    // Check for duplicates
    const [existingPlotRows] = await pool.execute(
      'SELECT id FROM land_plots WHERE block_id = ? AND LOWER(plot_number) = LOWER(?)',
      [block_id, plot_number]
    );
    
    if (existingPlotRows.length > 0) {
      return res.status(400).json({ error: 'Plot number already exists in this block' });
    }
    
    // Try the insert
    const [resultRows] = await pool.execute(
      `INSERT INTO land_plots (block_id, plot_number, area, price, status, description, dimensions, facing) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [block_id, plot_number.toString().trim(), parseFloat(area), price.toString().trim(), status || 'available', description || null, dimensions || null, facing || null]
    );
    
    // Get the inserted record
    const [newPlot] = await pool.execute(
      'SELECT * FROM land_plots WHERE id = ?',
      [resultRows.insertId]
    );
    
    res.json({
      success: true,
      message: 'Debug plot added successfully',
      block: blockCheck[0],
      plot: newPlot[0],
      insertId: resultRows.insertId
    });
  } catch (error) {
    logger.error('Debug add plot error:', error);
    res.status(500).json({
      error: 'Debug add plot failed',
      detail: error.message,
      code: error.code,
      sqlState: error.sqlState,
      sql: error.sql
    });
  }
});

// Get all blocks for a property
router.get('/property/:propertyId/blocks', auth, async (req, res) => {
  try {
    const { propertyId } = req.params;
    
    const [rows] = await pool.execute(
      `SELECT * FROM land_blocks 
       WHERE property_id = ? 
       ORDER BY created_at ASC`,
      [propertyId]
    );
    
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch land blocks' });
  }
});

// Add a new block for a property
router.post('/blocks', auth, async (req, res) => {
  try {
    const { property_id, name, description } = req.body;
    
    if (!property_id || !name) {
      return res.status(400).json({ error: 'Property ID and name are required' });
    }
    
    // Check if block name already exists for this property
    const [existingBlockRows] = await pool.execute(
      'SELECT id FROM land_blocks WHERE property_id = ? AND LOWER(name) = LOWER(?)',
      [property_id, name]
    );
    
    if (existingBlockRows.length > 0) {
      return res.status(400).json({ error: 'Block name already exists for this property' });
    }
    
    const [resultRows] = await pool.execute(
      `INSERT INTO land_blocks (property_id, name, description) 
       VALUES (?, ?, ?)`,
      [property_id, name, description]
    );
    
    // Get the inserted record
    const [newBlock] = await pool.execute(
      'SELECT * FROM land_blocks WHERE id = ?',
      [resultRows.insertId]
    );
    
    res.status(201).json(newBlock[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to add land block' });
  }
});

// Update a block
router.put('/blocks/:blockId', auth, adminAuth, async (req, res) => {
  try {
    const { blockId } = req.params;
    const { name, description } = req.body;
    
    if (!name) {
      return res.status(400).json({ error: 'Name is required' });
    }
    
    const [resultRows] = await pool.execute(
      `UPDATE land_blocks 
       SET name = ?, description = ?, updated_at = NOW() 
       WHERE id = ?`,
      [name, description, blockId]
    );
    
    if (resultRows.affectedRows === 0) {
      return res.status(404).json({ error: 'Block not found' });
    }
    
    // Get the updated record
    const [updatedBlock] = await pool.execute(
      'SELECT * FROM land_blocks WHERE id = ?',
      [blockId]
    );
    
    res.json(updatedBlock[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to update land block' });
  }
});

// Delete a block (and all its plots)
router.delete('/blocks/:blockId', auth, adminAuth, async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { blockId } = req.params;
    
    // First delete all plots in this block
    await pool.execute('DELETE FROM land_plots WHERE block_id = ?', [blockId]);
    
    // Then delete the block
    const [resultRows] = await pool.execute(
      'DELETE FROM land_blocks WHERE id = ?',
      [blockId]
    );
    
    if (resultRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Block not found' });
    }
    
    await connection.commit();
    res.json({ success: true, deleted: resultRows[0] });
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ error: 'Failed to delete land block' });
  } finally {
    connection.release();
  }
});

// Get all plots for a block
router.get('/blocks/:blockId/plots', auth, async (req, res) => {
  try {
    const { blockId } = req.params;
    
    const [rows] = await pool.execute(
      `SELECT * FROM land_plots 
       WHERE block_id = ? 
       ORDER BY plot_number ASC`,
      [blockId]
    );
    
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch land plots' });
  }
});

// Get all plots for a property (public endpoint for users)
router.get('/property/:propertyId/plots/public', async (req, res) => {
  try {
    const { propertyId } = req.params;
    
    const [rows] = await pool.execute(
      `SELECT 
        lp.id,
        lp.plot_number,
        lp.area,
        lp.price,
        lp.status,
        lp.description,
        lp.created_at,
        lp.updated_at,
        lp.block_id,
        lb.name as block_name
      FROM land_plots lp
      JOIN land_blocks lb ON lp.block_id = lb.id
      WHERE lb.property_id = ?
      ORDER BY lb.name, lp.plot_number`,
      [propertyId]
    );
    
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch plots' });
  }
});

// Get all plots for a property (simplified route for frontend API)
router.get('/property/:propertyId', auth, async (req, res) => {
  try {
    const { propertyId } = req.params;
    
    const [rows] = await pool.execute(
      `SELECT lp.*, lb.name as block_name 
       FROM land_plots lp
       JOIN land_blocks lb ON lp.block_id = lb.id
       WHERE lb.property_id = ? 
       ORDER BY lb.name ASC, lp.plot_number ASC`,
      [propertyId]
    );
    
    res.json(rows);
  } catch (error) {
    logger.error('Failed to fetch property plots:', error);
    res.status(500).json({ error: 'Failed to fetch property plots' });
  }
});

// Get all plots for a property (across all blocks)
router.get('/property/:propertyId/plots', auth, adminAuth, async (req, res) => {
  try {
    const { propertyId } = req.params;
    
    const [rows] = await pool.execute(
      `SELECT lp.*, lb.name as block_name 
       FROM land_plots lp
       JOIN land_blocks lb ON lp.block_id = lb.id
       WHERE lb.property_id = ? 
       ORDER BY lb.name ASC, lp.plot_number ASC`,
      [propertyId]
    );
    
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch property land plots' });
  }
});

// Add a new plot to a block
router.post('/plots', auth, async (req, res) => {
  try {
    const { block_id, plot_number, area, price, status, description, dimensions, facing } = req.body;
    
    logger.dev('Add plot request:', { block_id, plot_number, area, price, status, description, dimensions, facing });
    
    // Validate required fields
    if (!block_id || !plot_number || !area || !price) {
      return res.status(400).json({ error: 'Block ID, plot number, area, and price are required' });
    }
    
    // Validate block_id is a number
    if (isNaN(parseInt(block_id))) {
      return res.status(400).json({ error: 'Valid block ID is required' });
    }
    
    // Validate numeric fields
    if (isNaN(parseFloat(area)) || parseFloat(area) <= 0) {
      return res.status(400).json({ error: 'Valid area is required (must be greater than 0)' });
    }
    
    if (isNaN(parseFloat(price)) || parseFloat(price) < 0) {
      return res.status(400).json({ error: 'Valid price is required (must be 0 or greater)' });
    }
    
    // Validate plot_number is not empty
    if (!plot_number.toString().trim()) {
      return res.status(400).json({ error: 'Plot number cannot be empty' });
    }
    
    // Check if block exists
    const [blockCheck] = await pool.execute(
      'SELECT id FROM land_blocks WHERE id = ?',
      [block_id]
    );
    
    if (blockCheck.length === 0) {
      return res.status(404).json({ error: 'Block not found' });
    }
    
    // Check if plot number already exists in this block
    const [existingPlotRows] = await pool.execute(
      'SELECT id FROM land_plots WHERE block_id = ? AND LOWER(plot_number) = LOWER(?)',
      [block_id, plot_number]
    );
    
    if (existingPlotRows.length > 0) {
      return res.status(400).json({ error: 'Plot number already exists in this block' });
    }
    
    const [resultRows] = await pool.execute(
      `INSERT INTO land_plots (block_id, plot_number, area, price, status, description, dimensions, facing) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        parseInt(block_id), 
        plot_number.toString().trim(), 
        parseFloat(area), 
        price.toString().trim(), // Store as string since DB column is VARCHAR for alphanumeric values
        status || 'available', 
        description || null,
        dimensions || null,
        facing || null
      ]
    );
    
    // Get the inserted record
    const [newPlot] = await pool.execute(
      'SELECT * FROM land_plots WHERE id = ?',
      [resultRows.insertId]
    );
    
    logger.dev('Plot added successfully:', newPlot[0]);
    res.status(201).json(newPlot[0]);
  } catch (error) {
    logger.error('Add plot error:', error);
    
    // Handle specific MySQL errors
    let errorMessage = 'Failed to add land plot';
    let statusCode = 500;
    
    if (error.code === 'ER_DUP_ENTRY') {
      errorMessage = 'Plot number already exists in this block';
      statusCode = 400;
    } else if (error.code === 'ER_NO_REFERENCED_ROW_2') {
      errorMessage = 'Block not found or invalid block ID';
      statusCode = 404;
    } else if (error.code === 'ER_BAD_NULL_ERROR') {
      errorMessage = 'Required field is missing or null';
      statusCode = 400;
    } else if (error.code === 'ER_DATA_TOO_LONG') {
      errorMessage = 'One or more field values are too long';
      statusCode = 400;
    } else if (error.code === 'ER_TRUNCATED_WRONG_VALUE') {
      errorMessage = 'Invalid data format for numeric fields';
      statusCode = 400;
    }
    
    res.status(statusCode).json({ 
      error: errorMessage,
      detail: error.message,
      code: error.code
    });
  }
});

// Debug endpoint to test plot update (remove after testing)
router.put('/debug/plots/:plotId', async (req, res) => {
  try {
    const { plotId } = req.params;
    const { plot_number, area, price, status, description } = req.body;
    
    logger.dev('🔧 Debug update land plot request:', { plotId, plot_number, area, price, status, description });
    
    // First, let's see what's currently in the database
    const [currentPlot] = await pool.execute(
      'SELECT * FROM land_plots WHERE id = ?',
      [plotId]
    );
    
    if (currentPlot.length === 0) {
      return res.status(404).json({ error: 'Plot not found' });
    }
    
    logger.dev('🔍 Current plot data:', currentPlot[0]);
    
    // Test the update with minimal validation
    const [resultRows] = await pool.execute(
      `UPDATE land_plots 
       SET plot_number = ?, area = ?, price = ?, status = ?, description = ?, dimensions = ?, facing = ?, updated_at = NOW() 
       WHERE id = ?`,
      [
        plot_number || currentPlot[0].plot_number,
        area ? parseFloat(area) : currentPlot[0].area,
        price || currentPlot[0].price,
        status || currentPlot[0].status,
        description || currentPlot[0].description,
        (typeof dimensions !== 'undefined') ? dimensions : currentPlot[0].dimensions,
        (typeof facing !== 'undefined') ? facing : currentPlot[0].facing,
        plotId
      ]
    );
    
    logger.dev('📊 Update result:', { affectedRows: resultRows.affectedRows });
    
    // Get the updated record
    const [updatedPlot] = await pool.execute(
      'SELECT * FROM land_plots WHERE id = ?',
      [plotId]
    );
    
    res.json({
      success: true,
      before: currentPlot[0],
      after: updatedPlot[0],
      updateResult: { affectedRows: resultRows.affectedRows }
    });
  } catch (error) {
    logger.error('❌ Debug update error:', error);
    res.status(500).json({
      error: 'Debug update failed',
      detail: error.message,
      code: error.code,
      sqlState: error.sqlState
    });
  }
});

// Update a plot
router.put('/plots/:plotId', auth, async (req, res) => {
  // Temporarily remove adminAuth to test if that's causing the issue
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  
  try {
    const { plotId } = req.params;
    const { plot_number, area, price, status, description } = req.body;
    
    logger.dev('🔧 Update land plot request:', { 
      plotId, 
      plot_number, 
      area, 
      price, 
      status, 
      description,
      requestBody: req.body,
      userRole: req.user?.role 
    });
    
    // First check if plot exists
    const [existingPlot] = await pool.execute(
      'SELECT * FROM land_plots WHERE id = ?',
      [plotId]
    );
    
    if (existingPlot.length === 0) {
      logger.dev('❌ Plot not found:', plotId);
      return res.status(404).json({ error: 'Plot not found' });
    }
    
    logger.dev('📝 Current plot data:', existingPlot[0]);
    
    if (!plot_number || plot_number.trim() === '') {
      return res.status(400).json({ error: 'Plot number is required' });
    }
    
    if (!area || area === '') {
      return res.status(400).json({ error: 'Area is required' });
    }
    
    if (price === undefined || price === null || price === '') {
      return res.status(400).json({ error: 'Price is required' });
    }
    
    // Validate area as numeric
    let areaValue;
    try {
      areaValue = parseFloat(area);
      if (isNaN(areaValue) || areaValue <= 0) {
        logger.dev('❌ Invalid area value:', area, 'parsed as:', areaValue);
        return res.status(400).json({ error: 'Area must be a valid positive number' });
      }
    } catch (areaError) {
      logger.dev('❌ Error parsing area:', areaError);
      return res.status(400).json({ error: 'Area must be a valid number' });
    }
    
    // For land plots, price should be stored as string to support alphanumeric values like "18.5 Lakhs"
    let priceValue;
    try {
      priceValue = price ? price.toString().trim() : '';
      
      // Validate price is not empty
      if (!priceValue) {
        logger.dev('❌ Empty price value after trim:', price);
        return res.status(400).json({ error: 'Price cannot be empty' });
      }
      
      // Check if price is too long for database field (assuming VARCHAR(100))
      if (priceValue.length > 100) {
        logger.dev('❌ Price too long:', priceValue.length, 'characters');
        return res.status(400).json({ error: 'Price value is too long (max 100 characters)' });
      }
    } catch (priceError) {
      logger.dev('❌ Error processing price:', priceError);
      return res.status(400).json({ error: 'Invalid price format' });
    }
    
    // Prepare the final values for database update
    const finalValues = [
      plot_number.toString().trim(), 
      areaValue, 
      priceValue, 
      status || 'available', 
      description || null, 
      (typeof dimensions !== 'undefined') ? dimensions : null,
      (typeof facing !== 'undefined') ? facing : null,
      plotId
    ];
    
    logger.dev('📊 Final values for SQL update:', finalValues);
    
    const [resultRows] = await pool.execute(
      `UPDATE land_plots 
       SET plot_number = ?, area = ?, price = ?, status = ?, description = ?, dimensions = ?, facing = ?, updated_at = NOW() 
       WHERE id = ?`,
      finalValues
    );
    
    if (resultRows.affectedRows === 0) {
      return res.status(404).json({ error: 'Plot not found' });
    }
    
    // Get the updated record
    const [updatedPlot] = await pool.execute(
      'SELECT * FROM land_plots WHERE id = ?',
      [plotId]
    );
    
    logger.dev('✅ Land plot updated successfully:', updatedPlot[0]);
    res.json(updatedPlot[0]);
  } catch (error) {
    logger.error('❌ Error updating land plot:', error);
    
    // Handle specific MySQL errors
    let errorMessage = 'Failed to update land plot';
    let statusCode = 500;
    
    if (error.code === 'ER_DUP_ENTRY') {
      errorMessage = 'Plot number already exists in this block';
      statusCode = 400;
    } else if (error.code === 'ER_NO_REFERENCED_ROW_2') {
      errorMessage = 'Block not found or invalid block ID';
      statusCode = 404;
    } else if (error.code === 'ER_BAD_NULL_ERROR') {
      errorMessage = 'Required field is missing or null';
      statusCode = 400;
    } else if (error.code === 'ER_DATA_TOO_LONG') {
      errorMessage = 'One or more field values are too long';
      statusCode = 400;
    } else if (error.code === 'ER_TRUNCATED_WRONG_VALUE') {
      errorMessage = 'Invalid data format for numeric fields';
      statusCode = 400;
    }
    
    res.status(statusCode).json({ 
      error: errorMessage,
      detail: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
      code: error.code
    });
  }
});

// Delete a plot
router.delete('/plots/:plotId', auth, adminAuth, async (req, res) => {
  try {
    const { plotId } = req.params;
    
    const [resultRows] = await pool.execute(
      'DELETE FROM land_plots WHERE id = ?',
      [plotId]
    );
    
    if (resultRows.length === 0) {
      return res.status(404).json({ error: 'Plot not found' });
    }
    
    res.json({ success: true, deleted: resultRows[0] });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete land plot' });
  }
});

// Update a plot (alternative route to match frontend API call pattern)
router.put('/:plotId', auth, async (req, res) => {
  try {
    const { plotId } = req.params;
    const { plot_number, area, price, status, description, dimensions, facing } = req.body;
    
    logger.dev('🔧 Update land plot request (alternative route):', { 
      plotId, 
      plot_number, 
      area, 
      price, 
      status, 
      description,
      dimensions, // Note: not stored in DB but logged for debugging
      facing, // Note: not stored in DB but logged for debugging
      requestBody: req.body,
      userRole: req.user?.role 
    });
    
    // First check if plot exists
    const [existingPlot] = await pool.execute(
      'SELECT * FROM land_plots WHERE id = ?',
      [plotId]
    );
    
    if (existingPlot.length === 0) {
      logger.dev('❌ Plot not found:', plotId);
      return res.status(404).json({ error: 'Plot not found' });
    }
    
    logger.dev('📝 Current plot data:', existingPlot[0]);
    
    if (!plot_number || plot_number.trim() === '') {
      return res.status(400).json({ error: 'Plot number is required' });
    }
    
    if (!area || area === '') {
      return res.status(400).json({ error: 'Area is required' });
    }
    
    if (price === undefined || price === null || price === '') {
      return res.status(400).json({ error: 'Price is required' });
    }
    
    // Check for duplicate plot numbers in the same block (excluding current plot)
    const [duplicateCheck] = await pool.execute(
      'SELECT id FROM land_plots WHERE block_id = ? AND LOWER(plot_number) = LOWER(?) AND id != ?',
      [existingPlot[0].block_id, plot_number, plotId]
    );
    
    if (duplicateCheck.length > 0) {
      return res.status(400).json({ error: 'Plot number already exists in this block' });
    }
    
    const [resultRows] = await pool.execute(
      `UPDATE land_plots 
       SET plot_number = ?, area = ?, price = ?, status = ?, description = ?, dimensions = ?, facing = ?, updated_at = NOW() 
       WHERE id = ?`,
      [plot_number, area, price, status || 'available', description, (typeof dimensions !== 'undefined') ? dimensions : null, (typeof facing !== 'undefined') ? facing : null, plotId]
    );
    
    if (resultRows.affectedRows === 0) {
      return res.status(404).json({ error: 'Plot not found or no changes made' });
    }
    
    // Get the updated record
    const [updatedPlot] = await pool.execute(
      'SELECT * FROM land_plots WHERE id = ?',
      [plotId]
    );
    
    logger.dev('✅ Plot updated successfully:', updatedPlot[0]);
    res.json(updatedPlot[0]);
  } catch (error) {
    logger.error('Update plot error:', error);
    
    // Handle specific MySQL errors
    let errorMessage = 'Failed to update land plot';
    let statusCode = 500;
    
    if (error.code === 'ER_DUP_ENTRY') {
      errorMessage = 'Plot number already exists in this block';
      statusCode = 400;
    } else if (error.code === 'ER_NO_REFERENCED_ROW_2') {
      errorMessage = 'Block not found or invalid block ID';
      statusCode = 404;
    } else if (error.code === 'ER_BAD_NULL_ERROR') {
      errorMessage = 'Required field is missing or null';
      statusCode = 400;
    } else if (error.code === 'ER_DATA_TOO_LONG') {
      errorMessage = 'One or more field values are too long';
      statusCode = 400;
    } else if (error.code === 'ER_TRUNCATED_WRONG_VALUE') {
      errorMessage = 'Invalid data format for numeric fields';
      statusCode = 400;
    }
    
    res.status(statusCode).json({ 
      error: errorMessage,
      detail: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
      code: error.code
    });
  }
});

// Delete a plot (alternative route to match frontend API call pattern)
router.delete('/:plotId', auth, adminAuth, async (req, res) => {
  try {
    const { plotId } = req.params;
    
    const [resultRows] = await pool.execute(
      'DELETE FROM land_plots WHERE id = ?',
      [plotId]
    );
    
    if (resultRows.affectedRows === 0) {
      return res.status(404).json({ error: 'Plot not found' });
    }
    
    res.json({ success: true, message: 'Plot deleted successfully' });
  } catch (error) {
    logger.error('Delete plot error:', error);
    res.status(500).json({ error: 'Failed to delete land plot' });
  }
});

// Get plot statistics for a property
router.get('/property/:propertyId/stats', auth, adminAuth, async (req, res) => {
  try {
    const { propertyId } = req.params;
    
    const [rows] = await pool.execute(
      `SELECT 
         COUNT(*) as total_plots,
         COUNT(CASE WHEN lp.status = 'available' THEN 1 END) as available_plots,
         COUNT(CASE WHEN lp.status = 'booked' THEN 1 END) as booked_plots,
         COUNT(CASE WHEN lp.status = 'sold' THEN 1 END) as sold_plots,
         SUM(lp.area) as total_area,
         COUNT(DISTINCT lb.id) as total_blocks
       FROM land_plots lp
       JOIN land_blocks lb ON lp.block_id = lb.id
       WHERE lb.property_id = ?`,
      [propertyId]
    );
    
    res.json(rows[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch land plot statistics' });
  }
});

// Bulk update blocks and plots for a property
router.put('/property/:propertyId/blocks/bulk', auth, async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { propertyId } = req.params;
    const { blocks, saveAsConfiguration, configurationName } = req.body;
    
    logger.dev('Bulk update request:', { 
      propertyId, 
      blocksCount: blocks?.length,
      requestBody: req.body,
      blocksType: typeof blocks,
      blocksIsArray: Array.isArray(blocks)
    });
    
    if (!blocks || !Array.isArray(blocks)) {
      return res.status(400).json({ error: 'Blocks array is required' });
    }
    
    // Validate propertyId
    if (!propertyId || isNaN(parseInt(propertyId))) {
      return res.status(400).json({ error: 'Valid property ID is required' });
    }
    
    // Check if property exists
    const [propertyCheck] = await connection.execute(
      'SELECT id FROM properties WHERE id = ?',
      [propertyId]
    );
    
    if (propertyCheck.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Property not found' });
    }
    
    const updatedBlocks = [];
    
    for (const block of blocks) {
      // Validate block data
      if (!block.name || block.name.trim() === '') {
        await connection.rollback();
        return res.status(400).json({ error: 'Block name is required' });
      }
      
      let savedBlock;
      let blockId;
      
      logger.dev('Processing block:', { id: block.id, name: block.name, plotsCount: block.plots?.length });
      
      if (block.id && !block.id.toString().startsWith('temp-') && !block.id.toString().startsWith('mock-')) {
        // Update existing block
        const [blockResult] = await connection.execute(
          `UPDATE land_blocks 
           SET name = ?, description = ?, updated_at = NOW() 
           WHERE id = ? AND property_id = ?`,
          [block.name, block.description || null, block.id, propertyId]
        );
        
        if (blockResult.affectedRows === 0) {
          await connection.rollback();
          return res.status(404).json({ error: `Block with ID ${block.id} not found` });
        }
        
        blockId = block.id;
        
        // Get the updated block data
        const [blockData] = await connection.execute(
          'SELECT * FROM land_blocks WHERE id = ?',
          [blockId]
        );
        
        savedBlock = blockData[0];
      } else {
        // Create new block
        const [blockResult] = await connection.execute(
          `INSERT INTO land_blocks (property_id, name, description) 
           VALUES (?, ?, ?)`,
          [propertyId, block.name, block.description || null]
        );
        
        blockId = blockResult.insertId;
        
        // Get the created block data
        const [blockData] = await connection.execute(
          'SELECT * FROM land_blocks WHERE id = ?',
          [blockId]
        );
        
        savedBlock = blockData[0];
      }
      
      // Handle plots for this block
      const savedPlots = [];
      
      if (block.plots && Array.isArray(block.plots)) {
        for (const plot of block.plots) {
          // Validate plot data
          if (!plot.plot_number || plot.plot_number.trim() === '') {
            await connection.rollback();
            return res.status(400).json({ error: 'Plot number is required' });
          }
          
          // Validate numeric fields
          if (plot.area && (isNaN(parseFloat(plot.area)) || parseFloat(plot.area) <= 0)) {
            await connection.rollback();
            return res.status(400).json({ error: 'Valid area is required' });
          }
          
          if (plot.price && (isNaN(parseFloat(plot.price)) || parseFloat(plot.price) < 0)) {
            await connection.rollback();
            return res.status(400).json({ error: 'Valid price is required' });
          }
          
          let savedPlot;
          let plotId;
          
          logger.dev('Processing plot:', { id: plot.id, plot_number: plot.plot_number, blockId });
          
          // Check for duplicate plot numbers in the same block (only for new plots or when plot number changes)
          if (!plot.id || plot.id.toString().startsWith('temp-') || plot.id.toString().startsWith('mock-')) {
            const [duplicateCheck] = await connection.execute(
              'SELECT id FROM land_plots WHERE block_id = ? AND LOWER(plot_number) = LOWER(?) AND id != ?',
              [blockId, plot.plot_number, plot.id || 0]
            );
            
            if (duplicateCheck.length > 0) {
              await connection.rollback();
              return res.status(400).json({ error: `Plot number '${plot.plot_number}' already exists in this block` });
            }
          }
          
          if (plot.id && !plot.id.toString().startsWith('temp-') && !plot.id.toString().startsWith('mock-')) {
            // Update existing plot
            const [plotResult] = await connection.execute(
              `UPDATE land_plots 
               SET plot_number = ?, area = ?, price = ?, status = ?, description = ?, dimensions = ?, facing = ?, updated_at = NOW() 
               WHERE id = ? AND block_id = ?`,
              [plot.plot_number, plot.area, plot.price, plot.status || 'available', plot.description || null, plot.dimensions || null, plot.facing || null, plot.id, blockId]
            );
            
            if (plotResult.affectedRows > 0) {
              plotId = plot.id;
              
              // Get the updated plot data
              const [plotData] = await connection.execute(
                'SELECT * FROM land_plots WHERE id = ?',
                [plotId]
              );
              
              savedPlot = plotData[0];
            }
          } else {
            // Create new plot
            const [plotResult] = await connection.execute(
              `INSERT INTO land_plots (block_id, plot_number, area, price, status, description, dimensions, facing) 
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              [blockId, plot.plot_number, plot.area, plot.price, plot.status || 'available', plot.description || null, plot.dimensions || null, plot.facing || null]
            );
            
            plotId = plotResult.insertId;
            
            // Get the created plot data
            const [plotData] = await connection.execute(
              'SELECT * FROM land_plots WHERE id = ?',
              [plotId]
            );
            
            savedPlot = plotData[0];
          }
          
          if (savedPlot) {
            savedPlots.push(savedPlot);
          }
        }
      }
      
      savedBlock.plots = savedPlots;
      updatedBlocks.push(savedBlock);
    }
    
    // Handle configuration saving if requested (before commit)
    let configurationResult = null;
    if (saveAsConfiguration && configurationName) {
      try {
        // Deactivate existing configurations
        await connection.execute(
          'UPDATE property_land_configurations SET is_active = false WHERE property_id = ?',
          [propertyId]
        );
        
        // Create new configuration
        const [configResult] = await connection.execute(
          `INSERT INTO property_land_configurations (property_id, configuration_name, blocks_data, is_active) 
           VALUES (?, ?, ?, true)`,
          [propertyId, configurationName || `Configuration ${Date.now()}`, JSON.stringify(updatedBlocks)]
        );
        
        configurationResult = {
          id: configResult.insertId,
          configuration_name: configurationName || `Configuration ${Date.now()}`,
          property_id: propertyId
        };
      } catch (configError) {
        logger.error('Configuration save error:', configError);
        await connection.rollback();
        return res.status(500).json({ 
          error: 'Failed to save configuration',
          detail: configError.message
        });
      }
    }
    
    await connection.commit();
    
    const response = {
      blocks: updatedBlocks,
      success: true,
      message: `Successfully updated ${updatedBlocks.length} blocks with ${updatedBlocks.reduce((sum, block) => sum + (block.plots?.length || 0), 0)} total plots`
    };
    
    if (configurationResult) {
      response.configuration = configurationResult;
    }
    
    logger.dev('Bulk update successful:', { blocksCount: updatedBlocks.length });
    res.json(response);
    
  } catch (error) {
    await connection.rollback();
    logger.error('Bulk update error:', error);
    
    // Handle specific MySQL errors
    let errorMessage = 'Failed to bulk update blocks';
    let statusCode = 500;
    
    if (error.code === 'ER_DUP_ENTRY') {
      errorMessage = 'Duplicate entry found. Please check for duplicate block names or plot numbers.';
      statusCode = 400;
    } else if (error.code === 'ER_NO_REFERENCED_ROW_2') {
      errorMessage = 'Referenced property not found.';
      statusCode = 404;
    } else if (error.code === 'ER_BAD_NULL_ERROR') {
      errorMessage = 'Required field is missing or null.';
      statusCode = 400;
    } else if (error.code === 'ER_NO_SUCH_TABLE') {
      errorMessage = 'Database table not found. Please check database schema.';
      statusCode = 500;
    }
    
    res.status(statusCode).json({ 
      error: errorMessage,
      detail: error.message,
      code: error.code,
      sqlState: error.sqlState
    });
  } finally {
    connection.release();
  }
});

// Get complete property configuration (blocks with plots)
router.get('/property/:propertyId/configuration', auth, async (req, res) => {
  try {
    const { propertyId } = req.params;
    
    // Get all blocks for the property
    const [blocksRows] = await pool.execute(
      `SELECT * FROM land_blocks 
       WHERE property_id = ? 
       ORDER BY created_at ASC`,
      [propertyId]
    );
    
    const blocks = [];
    
    // Get plots for each block
    for (const block of blocksRows) {
      const [plotsRows] = await pool.execute(
        `SELECT * FROM land_plots 
         WHERE block_id = ? 
         ORDER BY plot_number ASC`,
        [block.id]
      );
      
      blocks.push({
        ...block,
        plots: plotsRows
      });
    }
    
    res.json({
      property_id: propertyId,
      blocks: blocks,
      total_blocks: blocks.length,
      total_plots: blocks.reduce((sum, block) => sum + block.plots.length, 0)
    });
    
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch property configuration' });
  }
});

// Configuration management endpoints
// Get all saved configurations for a property
router.get('/property/:propertyId/configurations', auth, adminAuth, async (req, res) => {
  try {
    const { propertyId } = req.params;
    
    const [rows] = await pool.execute(
      `SELECT * FROM property_land_configurations 
       WHERE property_id = ? 
       ORDER BY created_at DESC`,
      [propertyId]
    );
    
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch configurations' });
  }
});

// Create a new configuration
router.post('/property/:propertyId/configurations', auth, adminAuth, async (req, res) => {
  try {
    const { propertyId } = req.params;
    const { configuration_name, blocks_data } = req.body;
    
    if (!configuration_name) {
      return res.status(400).json({ error: 'Configuration name is required' });
    }
    
    // Deactivate all existing configurations for this property
    await pool.execute(
      'UPDATE property_land_configurations SET is_active = false WHERE property_id = ?',
      [propertyId]
    );
    
    // Create new configuration
    const [resultRows] = await pool.execute(
      `INSERT INTO property_land_configurations (property_id, configuration_name, blocks_data, is_active) 
       VALUES (?, ?, ?, true)`,
      [propertyId, configurationName, JSON.stringify(blocks_data)]
    );
    
    // Get the inserted record
    const [newConfig] = await pool.execute(
      'SELECT * FROM property_land_configurations WHERE id = ?',
      [resultRows.insertId]
    );
    
    res.status(201).json(newConfig[0]);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create configuration' });
  }
});

// Apply a saved configuration
router.post('/configurations/:configId/apply', auth, adminAuth, async (req, res) => {
  const connection = await pool.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { configId } = req.params;
    
    // Get the configuration
    const [configRows] = await pool.execute(
      'SELECT * FROM property_land_configurations WHERE id = ?',
      [configId]
    );
    
    if (configRows.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Configuration not found' });
    }
    
    const config = configRows[0];
    const blocksData = config.blocks_data;
    
    // Delete existing blocks and plots for this property
    await pool.execute(
      `DELETE FROM land_plots WHERE block_id IN (
        SELECT id FROM land_blocks WHERE property_id = ?
      )`,
      [config.property_id]
    );
    
    await pool.execute(
      'DELETE FROM land_blocks WHERE property_id = ?',
      [config.property_id]
    );
    
    // Recreate blocks and plots from configuration
    const createdBlocks = [];
    
    for (const blockData of blocksData) {
      // Create block
      const [blockResultRows] = await pool.execute(
        `INSERT INTO land_blocks (property_id, name, description) 
         VALUES (?, ?, ?)`,
        [config.property_id, blockData.name, blockData.description || null]
      );
      
      const createdBlock = blockResultRows[0];
      const createdPlots = [];
      
      // Create plots for this block
      if (blockData.plots && Array.isArray(blockData.plots)) {
        for (const plotData of blockData.plots) {
          const [plotResultRows] = await pool.execute(
            `INSERT INTO land_plots (block_id, plot_number, area, price, status, description) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [createdBlock.id, plotData.plot_number, plotData.area, plotData.price, plotData.status || 'available', plotData.description || null]
          );
          
          createdPlots.push(plotResultRows[0]);
        }
      }
      
      createdBlock.plots = createdPlots;
      createdBlocks.push(createdBlock);
    }
    
    // Mark this configuration as active
    await pool.execute(
      'UPDATE property_land_configurations SET is_active = false WHERE property_id = ?',
      [config.property_id]
    );
    
    await pool.execute(
      'UPDATE property_land_configurations SET is_active = true WHERE id = ?',
      [configId]
    );
    
    await connection.commit();
    
    res.json({
      success: true,
      message: 'Configuration applied successfully',
      blocks: createdBlocks
    });
    
  } catch (error) {
    await connection.rollback();
    res.status(500).json({ error: 'Failed to apply configuration' });
  } finally {
    connection.release();
  }
});

// Simple test endpoint to verify plot updates work
router.post('/test-update/:plotId', async (req, res) => {
  try {
    const { plotId } = req.params;
    
    // Test data that should work
    const testData = {
      plot_number: 'Test-' + Date.now(),
      area: 100.5,
      price: '18.5 Lakhs',
      status: 'available',
      description: 'Test update from API'
    };
    
    logger.dev('🧪 Testing plot update with data:', testData);
    
    const [resultRows] = await pool.execute(
      `UPDATE land_plots 
       SET plot_number = ?, area = ?, price = ?, status = ?, description = ?, updated_at = NOW() 
       WHERE id = ?`,
      [testData.plot_number, testData.area, testData.price, testData.status, testData.description, plotId]
    );
    
    if (resultRows.affectedRows === 0) {
      return res.status(404).json({ error: 'Plot not found' });
    }
    
    // Get the updated record
    const [updatedPlot] = await pool.execute(
      'SELECT * FROM land_plots WHERE id = ?',
      [plotId]
    );
    
    res.json({
      success: true,
      message: 'Test update successful',
      testData,
      updatedPlot: updatedPlot[0]
    });
  } catch (error) {
    logger.error('❌ Test update failed:', error);
    res.status(500).json({
      error: 'Test update failed',
      detail: error.message,
      code: error.code
    });
  }
});

// Public endpoint to get all land plots (no authentication required)
router.get('/all/public', async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT 
        lp.id,
        lp.plot_number,
        lp.area,
        lp.price,
        lp.status,
        lp.description,
        lp.dimensions,
        lp.facing,
        lp.created_at,
        lp.updated_at,
        lp.block_id,
        lb.name as block_name
      FROM land_plots lp
      LEFT JOIN land_blocks lb ON lp.block_id = lb.id
      ORDER BY lp.plot_number ASC`
    );
    
    res.json(rows);
  } catch (error) {
    logger.error('Failed to fetch all plots (public):', error);
    res.status(500).json({ error: 'Failed to fetch plots' });
  }
});

// Public endpoint to get a specific plot by ID (no authentication required)
router.get('/plot/:plotId/public', async (req, res) => {
  try {
    const { plotId } = req.params;
    
    const [rows] = await pool.execute(
      `SELECT 
        lp.id,
        lp.plot_number,
        lp.area,
        lp.price,
        lp.status,
        lp.description,
        lp.dimensions,
        lp.facing,
        lp.created_at,
        lp.updated_at,
        lp.block_id,
        lb.name as block_name
      FROM land_plots lp
      LEFT JOIN land_blocks lb ON lp.block_id = lb.id
      WHERE lp.id = ?`,
      [plotId]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Plot not found' });
    }
    
    res.json(rows[0]);
  } catch (error) {
    logger.error('Failed to fetch plot by ID (public):', error);
    res.status(500).json({ error: 'Failed to fetch plot' });
  }
});

module.exports = router;
