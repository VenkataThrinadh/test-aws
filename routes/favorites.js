const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const auth = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');
const logger = require('../utils/logger');

// Get user's favorites
router.get('/', auth, async (req, res) => {
  try {
    // Get favorites with complete property details
    const [rows] = await pool.execute(
      'SELECT f.id as favorite_id, f.property_id, f.created_at as favorited_at, ' +
      'p.id, p.title, p.price, p.city, p.status, p.area, ' +
      'p.location, p.description, p.property_type, p.address, p.state, p.zip_code, ' +
      'p.is_featured, p.is_for_rent, p.built_year, p.image_url as property_image_url ' +
      'FROM favorites f ' +
      'JOIN properties p ON f.property_id = p.id ' +
      'WHERE f.user_id = ? ' +
      'ORDER BY f.created_at DESC',
      [req.user.id]
    );
    
    // For each favorite, get all images (prioritizing primary image)
    const favoritesWithImages = await Promise.all(
      rows.map(async (favorite) => {
        try {
          // Get all images for this property, with primary image first
          const [imageResult] = await pool.execute(
            'SELECT image_url, is_primary FROM property_images WHERE property_id = ? ORDER BY is_primary DESC, created_at ASC',
            [favorite.property_id]
          );
          
          // Determine the best image to use
          let primaryImageUrl = null;
          let allImages = [];
          
          if (imageResult.length > 0) {
            // Use the first image (which should be primary due to our ORDER BY)
            primaryImageUrl = imageResult[0].image_url;
            allImages = imageResult.map(img => ({
              image_url: img.image_url,
              is_primary: img.is_primary
            }));
          } else if (favorite.property_image_url) {
            // Fallback to property's direct image_url if no images in property_images table
            primaryImageUrl = favorite.property_image_url;
            allImages = [{ image_url: favorite.property_image_url, is_primary: true }];
          }
          
          // Removed debug logging for property images
          
          return {
            id: favorite.favorite_id,
            property_id: favorite.property_id,
            created_at: favorite.favorited_at,
            // Property details directly on the favorite object
            title: favorite.title,
            price: favorite.price,
            city: favorite.city,
            location: favorite.location || favorite.city,
            status: favorite.status,
            area: favorite.area,
            description: favorite.description,
            property_type: favorite.property_type,
            address: favorite.address,
            state: favorite.state,
            zip_code: favorite.zip_code,
            is_featured: favorite.is_featured,
            is_for_rent: favorite.is_for_rent,
            built_year: favorite.built_year,
            // Image data
            image_url: primaryImageUrl,
            property_images: allImages,
            // Nested property object for backward compatibility
            properties: {
              id: favorite.property_id,
              title: favorite.title,
              price: favorite.price,
              city: favorite.city,
              location: favorite.location || favorite.city,
              status: favorite.status,
              area: favorite.area,
              description: favorite.description,
              property_type: favorite.property_type,
              address: favorite.address,
              state: favorite.state,
              zip_code: favorite.zip_code,
              is_featured: favorite.is_featured,
              is_for_rent: favorite.is_for_rent,
              built_year: favorite.built_year,
              image_url: primaryImageUrl,
              property_images: allImages
            }
          };
        } catch (imageError) {
          // Only log errors in development environment
          if (process.env.NODE_ENV === 'development') {
            logger.error(`Error fetching images for property ${favorite.property_id}:`, imageError);
          }
          
          // Return favorite with minimal image data on error
          return {
            id: favorite.favorite_id,
            property_id: favorite.property_id,
            created_at: favorite.favorited_at,
            title: favorite.title,
            price: favorite.price,
            city: favorite.city,
            location: favorite.location || favorite.city,
            status: favorite.status,
            bedrooms: favorite.bedrooms,
            bathrooms: favorite.bathrooms,
            area: favorite.area,
            description: favorite.description,
            property_type: favorite.property_type,
            image_url: favorite.property_image_url || null,
            property_images: favorite.property_image_url ? [{ image_url: favorite.property_image_url, is_primary: true }] : [],
            properties: {
              id: favorite.property_id,
              title: favorite.title,
              price: favorite.price,
              city: favorite.city,
              location: favorite.location || favorite.city,
              status: favorite.status,
              area: favorite.area,
              description: favorite.description,
              property_type: favorite.property_type,
              image_url: favorite.property_image_url || null,
              property_images: favorite.property_image_url ? [{ image_url: favorite.property_image_url, is_primary: true }] : []
            }
          };
        }
      })
    );
    
    res.json(favoritesWithImages);
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error fetching favorites:', error);
    }
    res.status(500).json({ error: 'Server error fetching favorites' });
  }
});

// Add property to favorites
router.post('/', auth, async (req, res) => {
  try {
    const { propertyId } = req.body;
    
    if (!propertyId) {
      return res.status(400).json({ error: 'Property ID is required' });
    }
    
    // Check if property exists
    const [propertyCheck] = await pool.execute('SELECT id FROM properties WHERE id = ?', [propertyId]);
    
    if (propertyCheck.length === 0) {
      return res.status(404).json({ error: 'Property not found' });
    }
    
    // Use INSERT IGNORE to handle duplicate entries gracefully
    const [result] = await pool.execute(
      'INSERT IGNORE INTO favorites (user_id, property_id, created_at) VALUES (?, ?, NOW())',
      [req.user.id, propertyId]
    );
    
    // Check if the insert was successful or if it already existed
    if (result.affectedRows === 0) {
      // Property was already in favorites, return success with indication
      return res.status(200).json({ 
        success: true, 
        alreadyFavorited: true, 
        message: 'Property already in favorites',
        propertyId: propertyId
      });
    }
    
    // Successfully added new favorite
    res.status(201).json({ 
      success: true, 
      id: result.insertId, 
      propertyId: propertyId,
      message: 'Property added to favorites'
    });
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error adding to favorites:', error);
    }
    res.status(500).json({ error: 'Server error adding to favorites' });
  }
});

// Remove property from favorites
router.delete('/:propertyId', auth, async (req, res) => {
  try {
    const { propertyId } = req.params;
    
    // Delete from favorites
    const [result] = await pool.execute(
      'DELETE FROM favorites WHERE user_id = ? AND property_id = ?',
      [req.user.id, propertyId]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Favorite not found' });
    }
    
    res.json({ success: true, message: 'Removed from favorites' });
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error removing from favorites:', error);
    }
    res.status(500).json({ error: 'Server error removing from favorites' });
  }
});

// Debug endpoint to check user authentication and plot favorites
router.get('/debug', auth, async (req, res) => {
  try {
    const userInfo = {
      id: req.user.id,
      email: req.user.email,
      role: req.user.role
    };
    
    // Get user's plot favorites count
    const [plotFavoritesCount] = await pool.execute(
      'SELECT COUNT(*) as count FROM plot_favorites WHERE user_id = ?',
      [req.user.id]
    );
    
    // Get all plot favorites for this user
    const [plotFavorites] = await pool.execute(
      `SELECT pf.*, p.title as property_title, p.property_type, p.city as property_city, p.state as property_state, p.price as property_price,
        (SELECT pi.image_url FROM property_images pi WHERE pi.property_id = p.id ORDER BY pi.is_primary DESC LIMIT 1) as property_image_url
      FROM plot_favorites pf
      JOIN properties p ON pf.property_id = p.id
      WHERE pf.user_id = ?
      ORDER BY pf.created_at DESC`,
      [req.user.id]
    );
    
    res.json({
      user: userInfo,
      plotFavoritesCount: parseInt(plotFavoritesCount[0].count),
      plotFavorites: plotFavorites,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Debug endpoint error:', error);
    res.status(500).json({ error: 'Debug endpoint error', details: error.message });
  }
});

// Test endpoint to verify authentication
router.get('/test-auth', auth, async (req, res) => {
  res.json({
    message: 'Authentication working',
    user: {
      id: req.user.id,
      email: req.user.email,
      role: req.user.role
    },
    timestamp: new Date().toISOString()
  });
});

// Get favorites for a specific user (admin only)
router.get('/user/:userId', auth, async (req, res) => {
  try {
    const { userId } = req.params;
    
    // Debug logging
    console.log(`🔍 Fetching favorites for user ID: ${userId}`);
    console.log(`👤 Requesting user:`, { id: req.user.id, email: req.user.email, role: req.user.role });
    
    // Check if user is admin (temporary check while debugging)
    if (req.user.role !== 'admin') {
      console.log(`❌ Access denied - user role: ${req.user.role}`);
      return res.status(403).json({ error: 'Admin access required' });
    }
    
    // Get favorites with complete property details for the specified user
    const [rows] = await pool.execute(
      'SELECT f.id as favorite_id, f.property_id, f.created_at as favorited_at, ' +
      'p.id, p.title, p.price, p.city, p.status, p.area, ' +
      'p.location, p.description, p.property_type, p.address, p.state, p.zip_code, ' +
      'p.is_featured, p.built_year ' +
      'FROM favorites f ' +
      'JOIN properties p ON f.property_id = p.id ' +
      'WHERE f.user_id = ? ' +
      'ORDER BY f.created_at DESC',
      [userId]
    );
    
    // For each favorite, get all images (prioritizing primary image)
    const favoritesWithImages = await Promise.all(
      rows.map(async (favorite) => {
        try {
          // Get all images for this property, with primary image first
          const [imageResult] = await pool.execute(
            'SELECT image_url, is_primary FROM property_images WHERE property_id = ? ORDER BY is_primary DESC, created_at ASC',
            [favorite.property_id]
          );
          
          // Determine the best image to use
          let primaryImageUrl = null;
          let allImages = [];
          
          if (imageResult.length > 0) {
            // Use the first image (which should be primary due to our ORDER BY)
            primaryImageUrl = imageResult[0].image_url;
            allImages = imageResult.map(img => ({
              image_url: img.image_url,
              is_primary: img.is_primary
            }));
          }
          
          return {
            id: favorite.favorite_id,
            property_id: favorite.property_id,
            property_title: favorite.title,
            created_at: favorite.favorited_at,
            // Property details
            title: favorite.title,
            price: favorite.price,
            city: favorite.city,
            location: favorite.location || favorite.city,
            status: favorite.status,
            area: favorite.area,
            description: favorite.description,
            property_type: favorite.property_type,
            address: favorite.address,
            state: favorite.state,
            zip_code: favorite.zip_code,
            is_featured: favorite.is_featured,
            built_year: favorite.built_year,
            // Image data
            image_url: primaryImageUrl,
            property_images: allImages
          };
        } catch (imageError) {
          // Return favorite with minimal data on error
          return {
            id: favorite.favorite_id,
            property_id: favorite.property_id,
            property_title: favorite.title,
            created_at: favorite.favorited_at,
            title: favorite.title,
            price: favorite.price,
            city: favorite.city,
            location: favorite.location || favorite.city,
            status: favorite.status,
            area: favorite.area,
            description: favorite.description,
            property_type: favorite.property_type,
            image_url: null,
            property_images: []
          };
        }
      })
    );
    
    res.json({ favorites: favoritesWithImages });
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      console.error('Error fetching user favorites:', error);
    }
    res.status(500).json({ error: 'Server error fetching user favorites' });
  }
});

// Check if property is in user's favorites
router.get('/check/:propertyId', auth, async (req, res) => {
  try {
    const { propertyId } = req.params;
    
    const [result] = await pool.execute(
      'SELECT id FROM favorites WHERE user_id = ? AND property_id = ?',
      [req.user.id, propertyId]
    );
    
    res.json({ isFavorite: result.length > 0 });
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error checking favorite status:', error);
    }
    res.status(500).json({ error: 'Server error checking favorite status' });
  }
});

// Sync plot favorite status - check multiple plots at once
router.post('/plots/sync', auth, async (req, res) => {
  try {
    const { plots } = req.body;
    
    if (!plots || !Array.isArray(plots) || plots.length === 0) {
      return res.status(400).json({ error: 'Plots array is required' });
    }
    
    // Limit to reasonable number of plots to check
    const limitedPlots = plots.slice(0, 100);
    
    // Build the query conditions for each plot
    const conditions = [];
    const params = [req.user.id];
    
    limitedPlots.forEach(plot => {
      conditions.push('(property_id = ? AND plot_id = ? AND plot_type = ?)');
      params.push(plot.propertyId, plot.plotId, plot.plotType);
    });
    
    const query = `SELECT property_id, plot_id, plot_type FROM plot_favorites 
                   WHERE user_id = ? AND (${conditions.join(' OR ')})`;
    
    const [result] = await pool.execute(query, params);
    
    // Create a map of favorited plots
    const favoritedPlots = {};
    result.forEach(row => {
      const key = `${row.property_id}_${row.plot_id}_${row.plot_type}`;
      favoritedPlots[key] = true;
    });
    
    // Return status for all requested plots
    const syncResult = {};
    limitedPlots.forEach(plot => {
      const key = `${plot.propertyId}_${plot.plotId}_${plot.plotType}`;
      syncResult[key] = !!favoritedPlots[key];
    });
    
    res.json({ plotFavorites: syncResult });
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error syncing plot favorite status:', error);
    }
    res.status(500).json({ error: 'Server error syncing plot favorite status' });
  }
});

// Sync favorite status - check multiple properties at once
router.post('/sync', auth, async (req, res) => {
  try {
    const { propertyIds } = req.body;
    
    if (!propertyIds || !Array.isArray(propertyIds) || propertyIds.length === 0) {
      return res.status(400).json({ error: 'Property IDs array is required' });
    }
    
    // Limit to reasonable number of properties to check
    const limitedPropertyIds = propertyIds.slice(0, 100);
    
    // Create placeholders for the IN clause
    const placeholders = limitedPropertyIds.map(() => '?').join(',');
    
    const [result] = await pool.execute(
      `SELECT property_id FROM favorites WHERE user_id = ? AND property_id IN (${placeholders})`,
      [req.user.id, ...limitedPropertyIds]
    );
    
    // Create a map of favorited properties
    const favoritedProperties = {};
    result.forEach(row => {
      favoritedProperties[row.property_id] = true;
    });
    
    // Return status for all requested properties
    const syncResult = {};
    limitedPropertyIds.forEach(propertyId => {
      syncResult[propertyId] = !!favoritedProperties[propertyId];
    });
    
    res.json({ favorites: syncResult });
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error syncing favorite status:', error);
    }
    res.status(500).json({ error: 'Server error syncing favorite status' });
  }
});

// Sync plot favorite status - check multiple plots at once
router.post('/plots/sync', auth, async (req, res) => {
  try {
    const { plots } = req.body;
    
    if (!plots || !Array.isArray(plots) || plots.length === 0) {
      return res.status(400).json({ error: 'Plots array is required' });
    }
    
    // Limit to reasonable number of plots to check
    const limitedPlots = plots.slice(0, 100);
    
    // Build the query conditions for each plot
    const conditions = [];
    const params = [req.user.id];
    
    limitedPlots.forEach(plot => {
      conditions.push('(property_id = ? AND plot_id = ? AND plot_type = ?)');
      params.push(plot.propertyId, plot.plotId, plot.plotType);
    });
    
    const query = `SELECT property_id, plot_id, plot_type FROM plot_favorites 
                   WHERE user_id = ? AND (${conditions.join(' OR ')})`;
    
    const [result] = await pool.execute(query, params);
    
    // Create a map of favorited plots
    const favoritedPlots = {};
    result.forEach(row => {
      const key = `${row.property_id}_${row.plot_id}_${row.plot_type}`;
      favoritedPlots[key] = true;
    });
    
    // Return status for all requested plots
    const syncResult = {};
    limitedPlots.forEach(plot => {
      const key = `${plot.propertyId}_${plot.plotId}_${plot.plotType}`;
      syncResult[key] = !!favoritedPlots[key];
    });
    
    res.json({ plotFavorites: syncResult });
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error syncing plot favorite status:', error);
    }
    res.status(500).json({ error: 'Server error syncing plot favorite status' });
  }
});

// Test endpoint to check property images in database
router.get('/test-images', auth, async (req, res) => {
  try {
    
    // Get all properties with their images
    const [propertiesResult] = await pool.execute(
      'SELECT id, title, image_url FROM properties ORDER BY created_at DESC LIMIT 10'
    );
    
    const propertiesWithImages = await Promise.all(
      propertiesResult.rows.map(async (property) => {
        const [imagesResult] = await pool.execute(
          'SELECT image_url, is_primary FROM property_images WHERE property_id = ? ORDER BY is_primary DESC, created_at ASC',
          [property.id]
        );
        
        return {
          property_id: property.id,
          title: property.title,
          direct_image_url: property.image_url,
          property_images: imagesResult.rows
        };
      })
    );
    
    res.json({
      message: 'Property images test',
      properties: propertiesWithImages
    });
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error testing property images:', error);
    }
    res.status(500).json({ error: 'Server error testing images' });
  }
});

// =============================================================================
// PLOT-LEVEL FAVORITES ROUTES
// =============================================================================

// Get user's plot favorites
router.get('/plots', auth, async (req, res) => {
  try {
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }
    
    const [rows] = await pool.execute(
      `SELECT pf.*, p.title as property_title, p.property_type, p.city as property_city, p.state as property_state, p.price as property_price,
        (SELECT pi.image_url FROM property_images pi WHERE pi.property_id = p.id ORDER BY pi.is_primary DESC LIMIT 1) as property_image_url
      FROM plot_favorites pf
      JOIN properties p ON pf.property_id = p.id
      WHERE pf.user_id = ?
      ORDER BY pf.created_at DESC`,
      [req.user.id]
    );
    
    res.json(rows);
  } catch (error) {
    logger.error('Error fetching plot favorites:', error);
    res.status(500).json({ error: 'Server error fetching plot favorites' });
  }
});

// Add plot to favorites
router.post('/plots', auth, async (req, res) => {
  try {
    const { propertyId, plotId, plotType, plotNumber } = req.body;
    
    if (!propertyId || !plotId || !plotType) {
      return res.status(400).json({ 
        error: 'Property ID, plot ID, and plot type are required',
        received: { propertyId, plotId, plotType, plotNumber }
      });
    }
    
    // Validate plot type
    if (!['land_plot', 'property_plot'].includes(plotType)) {
      return res.status(400).json({ error: 'Invalid plot type. Must be land_plot or property_plot' });
    }
    
    // Check if property exists
    const [propertyCheck] = await pool.execute('SELECT id FROM properties WHERE id = ?', [propertyId]);
    if (propertyCheck.length === 0) {
      return res.status(404).json({ error: 'Property not found' });
    }
    
    // Check if plot exists based on plot type
    let plotCheck;
    let plotDetails = {};
    
    if (plotType === 'land_plot') {
      plotCheck = await pool.execute(
        'SELECT lp.*, lb.name as block_name FROM land_plots lp JOIN land_blocks lb ON lp.block_id = lb.id WHERE lp.id = ?',
        [plotId]
      );
      
      if (plotCheck.length > 0) {
        const plot = plotCheck[0];
        plotDetails = {
          area: plot.area,
          price: plot.price,
          status: plot.status,
          description: plot.description,
          block_name: plot.block_name
        };
      }
    } else if (plotType === 'property_plot') {
      plotCheck = await pool.execute('SELECT * FROM property_plots WHERE id = ?', [plotId]);
      
      if (plotCheck.length > 0) {
        const plot = plotCheck[0];
        plotDetails = {
          area: plot.area,
          price: plot.price,
          status: plot.status,
          description: plot.description,
          floor_number: plot.floor_number,
          facing: plot.facing,
          bedrooms: plot.bedrooms,
          bathrooms: plot.bathrooms
        };
      }
    }
    
    if (plotCheck.length === 0) {
      return res.status(404).json({ error: 'Plot not found' });
    }
    
    // Use INSERT IGNORE to handle duplicate entries gracefully
    const [result] = await pool.execute(
      `INSERT IGNORE INTO plot_favorites (user_id, property_id, plot_id, plot_type, plot_number, plot_details, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [req.user.id, propertyId, plotId, plotType, plotNumber || plotCheck[0].plot_number, JSON.stringify(plotDetails)]
    );
    
    // Check if the insert was successful or if it already existed
    if (result.affectedRows === 0) {
      // Plot was already in favorites, return success with indication
      return res.status(200).json({ 
        success: true, 
        alreadyFavorited: true, 
        message: 'Plot already in favorites',
        propertyId: propertyId,
        plotId: plotId,
        plotType: plotType
      });
    }
    
    // Successfully added new plot favorite
    res.status(201).json({ 
      success: true, 
      id: result.insertId, 
      propertyId: propertyId,
      plotId: plotId,
      plotType: plotType,
      message: 'Plot added to favorites'
    });
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error adding plot to favorites:', error);
    }
    res.status(500).json({ error: 'Server error adding plot to favorites' });
  }
});

// Remove plot from favorites
router.delete('/plots/:propertyId/:plotId/:plotType', auth, async (req, res) => {
  try {
    const { propertyId, plotId, plotType } = req.params;
    
    // Validate plot type
    if (!['land_plot', 'property_plot'].includes(plotType)) {
      return res.status(400).json({ error: 'Invalid plot type' });
    }
    
    // Delete from plot favorites
    const [result] = await pool.execute(
      'DELETE FROM plot_favorites WHERE user_id = ? AND property_id = ? AND plot_id = ? AND plot_type = ?',
      [req.user.id, propertyId, plotId, plotType]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Plot favorite not found' });
    }
    
    res.json({ success: true, message: 'Plot removed from favorites' });
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error removing plot from favorites:', error);
    }
    res.status(500).json({ error: 'Server error removing plot from favorites' });
  }
});

// Check if plot is in user's favorites
router.get('/plots/check/:propertyId/:plotId/:plotType', auth, async (req, res) => {
  try {
    const { propertyId, plotId, plotType } = req.params;
    
    // Validate plot type
    if (!['land_plot', 'property_plot'].includes(plotType)) {
      return res.status(400).json({ error: 'Invalid plot type' });
    }
    
    const [result] = await pool.execute(
      'SELECT EXISTS(SELECT 1 FROM plot_favorites WHERE user_id = ? AND property_id = ? AND plot_id = ? AND plot_type = ?) as is_favorite',
      [req.user.id, propertyId, plotId, plotType]
    );
    
    res.json({ isFavorite: result[0].is_favorite });
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error checking plot favorite status:', error);
    }
    res.status(500).json({ error: 'Server error checking plot favorite status' });
  }
});

// Get plot favorites for a specific property
router.get('/plots/property/:propertyId', auth, async (req, res) => {
  try {
    const { propertyId } = req.params;
    
    const [rows] = await pool.execute(
      `SELECT pf.*, p.title as property_title, p.property_type, p.city as property_city, p.state as property_state, p.price as property_price,
        (SELECT pi.image_url FROM property_images pi WHERE pi.property_id = p.id ORDER BY pi.is_primary DESC LIMIT 1) as property_image_url
      FROM plot_favorites pf
      JOIN properties p ON pf.property_id = p.id
      WHERE pf.user_id = ? AND pf.property_id = ?
      ORDER BY pf.created_at DESC`,
      [req.user.id, propertyId]
    );
    
    res.json(rows);
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error fetching property plot favorites:', error);
    }
    res.status(500).json({ error: 'Server error fetching property plot favorites' });
  }
});

module.exports = router;