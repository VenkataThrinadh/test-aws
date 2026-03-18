const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const auth = require('../middleware/auth');
const logger = require('../utils/logger');

// Get plots for a property
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
      'SELECT * FROM property_plots WHERE property_id = ? ORDER BY plot_number',
      [propertyId]
    );
    
    res.json(rows);
  } catch (error) {
    // Return empty array instead of error
    res.json([]);
  }
});

// Add plot to a property (admin only)
router.post('/', auth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not authorized' });
  }

  try {
    // Handle both camelCase and snake_case field names for compatibility
    const { 
      propertyId, 
      plotNumber, 
      plot_number, 
      area, 
      price, 
      status,
      description,
      dimensions,
      facing,
      block,
      floor,
      unit_type,
      amenities
    } = req.body;
    
    // Use plot_number if provided, otherwise use plotNumber
    const plotNum = plot_number || plotNumber;
    
    logger.dev('📝 Creating plot for apartment property:', {
      propertyId,
      plotNum,
      area,
      price,
      status,
      description,
      additionalFields: { dimensions, facing, block, floor, unit_type, amenities }
    });
    
    // Get property type to determine price handling
    const [propertyResult] = await pool.execute(
      'SELECT property_type FROM properties WHERE id = ?',
      [propertyId]
    );
    
    if (propertyResult.length === 0) {
      return res.status(404).json({ error: 'Property not found' });
    }
    
    const propertyType = propertyResult[0].property_type?.toLowerCase();
    const alphanumericPriceTypes = ['apartment', 'villa', 'commercial', 'house', 'land'];
    const isAlphanumericType = alphanumericPriceTypes.includes(propertyType);
    
    // Handle price based on property type
    const priceValue = isAlphanumericType ? price : (isNaN(parseFloat(price)) ? price : parseFloat(price));
    
    // Validate required fields
    if (!propertyId || !plotNum) {
      return res.status(400).json({ error: 'Property ID and plot number are required' });
    }
    
    const [result] = await pool.execute(
      'INSERT INTO property_plots (property_id, plot_number, area, price, status, description, dimensions, facing) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [propertyId, plotNum, area, priceValue, status || 'available', description || null, dimensions || null, facing || null]
    );
    
    // Get the inserted record
    const [newPlot] = await pool.execute(
      'SELECT * FROM property_plots WHERE id = ?',
      [result.insertId]
    );
    
    logger.dev('✅ Plot created successfully:', newPlot[0]);
    res.status(201).json(newPlot[0]);
  } catch (error) {
    logger.error('❌ Error creating plot:', error);
    
    // Handle specific MySQL errors
    let errorMessage = 'Failed to create plot';
    let statusCode = 500;
    
    if (error.code === 'ER_DUP_ENTRY') {
      errorMessage = 'Plot number already exists for this property';
      statusCode = 400;
    } else if (error.code === 'ER_NO_REFERENCED_ROW_2') {
      errorMessage = 'Property not found';
      statusCode = 404;
    } else if (error.code === 'ER_BAD_NULL_ERROR') {
      errorMessage = 'Required field is missing';
      statusCode = 400;
    }
    
    res.status(statusCode).json({ 
      error: errorMessage,
      detail: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
      code: error.code
    });
  }
});

// Update plot (admin only)
router.put('/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not authorized' });
  }

  try {
    const { id } = req.params;
    const { 
      plotNumber, 
      plot_number, 
      area, 
      price, 
      status, 
      description,
      dimensions,
      facing,
      block,
      floor,
      unit_type,
      amenities
    } = req.body;
    
    // Use plot_number if provided, otherwise use plotNumber
    const plotNum = plot_number || plotNumber;
    
    // Get property type to determine price handling
    const [propertyResult] = await pool.execute(
      'SELECT p.property_type FROM properties p JOIN property_plots pp ON p.id = pp.property_id WHERE pp.id = ?',
      [id]
    );
    
    if (propertyResult.length === 0) {
      return res.status(404).json({ error: 'Plot not found' });
    }
    
    const propertyType = propertyResult[0].property_type?.toLowerCase();
    const alphanumericPriceTypes = ['apartment', 'villa', 'commercial', 'house', 'land'];
    const isAlphanumericType = alphanumericPriceTypes.includes(propertyType);
    
    // Handle price based on property type
    const priceValue = isAlphanumericType ? price : (isNaN(parseFloat(price)) ? price : parseFloat(price));
    
    const [result] = await pool.execute(
      'UPDATE property_plots SET plot_number = ?, area = ?, price = ?, status = ?, description = ?, dimensions = ?, facing = ?, updated_at = NOW() WHERE id = ?',
      [plotNum, area, priceValue, status, description || null, dimensions || null, facing || null, id]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Plot not found' });
    }
    
    // Get the updated record
    const [updatedPlot] = await pool.execute(
      'SELECT * FROM property_plots WHERE id = ?',
      [id]
    );
    
    res.json(updatedPlot[0]);
  } catch (error) {
    logger.error('Error updating plot:', error);
    res.status(500).json({ 
      error: 'Server error', 
      detail: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error'
    });
  }
});

// Update plot status (admin only)
router.put('/:id/status', auth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not authorized' });
  }

  try {
    const { id } = req.params;
    const { status } = req.body;
    
    const [result] = await pool.execute(
      'UPDATE property_plots SET status = ?, updated_at = NOW() WHERE id = ?',
      [status, id]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Plot not found' });
    }
    
    res.json(result[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete plot (admin only)
router.delete('/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Not authorized' });
  }

  try {
    const { id } = req.params;
    
    // Check if the plot has any bookings
    const [bookingsResult] = await pool.execute(
      'SELECT COUNT(*) as count FROM property_bookings WHERE plot_id = ?',
      [id]
    );
    
    if (parseInt(bookingsResult[0].count) > 0) {
      return res.status(400).json({ error: 'Cannot delete plot with existing bookings' });
    }
    
    await pool.execute('DELETE FROM property_plots WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Book a plot (user)
router.post('/:id/book', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    
    // Check if plot is available
    const [plotResult] = await pool.execute(
      'SELECT * FROM property_plots WHERE id = ?',
      [id]
    );
    
    if (plotResult.length === 0) {
      return res.status(404).json({ error: 'Plot not found' });
    }
    
    const plot = plotResult[0];
    
    if (plot.status !== 'available') {
      return res.status(400).json({ error: 'Plot is not available for booking' });
    }
    
    // Create booking
    const [bookingResult] = await pool.execute(
      'INSERT INTO property_bookings (property_id, plot_id, user_id, total_amount) VALUES (?, ?, ?, ?)',
      [plot.property_id, id, userId, plot.price]
    );
    
    // Update plot status to 'booked'
    await pool.execute(
      'UPDATE property_plots SET status = ?, updated_at = NOW() WHERE id = ?',
      ['booked', id]
    );
    
    // Get the inserted booking record
    const [newBooking] = await pool.execute(
      'SELECT * FROM property_bookings WHERE id = ?',
      [bookingResult.insertId]
    );
    
    res.status(201).json(newBooking[0]);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get user's bookings
router.get('/bookings', auth, async (req, res) => {
  try {
    const userId = req.user.id;
    
    const [rows] = await pool.execute(
      `SELECT b.*, p.plot_number, p.area, p.price, pr.title as property_title, pr.address, pr.city
       FROM property_bookings b
       JOIN property_plots p ON b.plot_id = p.id
       JOIN properties pr ON b.property_id = pr.id
       WHERE b.user_id = ?
       ORDER BY b.created_at DESC`,
      [userId]
    );
    
    res.json(rows);
  } catch (error) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;