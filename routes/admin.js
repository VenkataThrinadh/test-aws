const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const auth = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');
const { cleanupMissingImages } = require('../scripts/cleanupMissingImages');
const logger = require('../utils/logger');

// Get dashboard stats
router.get('/dashboard', auth, adminAuth, async (req, res) => {
  try {
    // Test database connection first
    let dbConnected = false;
    try {
      const connection = await pool.getConnection();
      await connection.query('SELECT 1');
      connection.release();
      dbConnected = true;
    } catch (dbError) {
      logger.error('Database connection failed:', dbError.message);
      // Return mock data if database is not available
      return res.json({
        totalProperties: 0,
        totalUsers: 1, // At least the admin user
        totalAdmins: 1,
        activeListings: 0,
        activeProperties: 0,
        totalEnquiries: 0,
        recentSales: 0,
        pendingApprovals: 0,
        recentProperties: [],
        recentUsers: [],
        dbStatus: 'disconnected',
        message: 'Database temporarily unavailable. Showing default values.',
        timestamp: new Date().toISOString()
      });
    }

    // Initialize with empty arrays in case tables don't exist
    let propertiesData = [];
    let usersData = [];
    let enquiries = [];
    
    try {
      // Get property stats with better error handling
      const propertiesResult = await pool.execute(
        'SELECT id, status FROM properties WHERE 1=1'
      );
      propertiesData = propertiesResult[0] || []; // Use first element of result array
    } catch (propError) {
      logger.error('Error fetching properties:', propError.message);
      // Continue with empty array
    }
    
    try {
      // Get users with better error handling
      const usersResult = await pool.execute(
        'SELECT id, email, full_name, role, created_at FROM users WHERE 1=1'
      );
      usersData = usersResult[0] || []; // Use first element of result array
    } catch (userError) {
      logger.error('Error fetching users:', userError.message);
      // Continue with empty array
    }
    
    try {
      // Get enquiries with better error handling
      const enquiriesResult = await pool.execute(
        'SELECT id, status FROM property_enquiries WHERE 1=1'
      );
      enquiries = enquiriesResult[0] || []; // Use first element of result array
    } catch (enquiryError) {
      logger.error('Error fetching enquiries:', enquiryError.message);
      // Continue with empty array
    }
    
    // Get recent properties
    let recentProps = [];
    try {
      const recentPropsResult = await pool.execute(
        'SELECT p.id, p.title, p.price, p.status, p.created_at, ' +
        '(SELECT image_url FROM property_images WHERE property_id = p.id LIMIT 1) as image_url ' +
        'FROM properties p ' +
        'ORDER BY p.created_at DESC ' +
        'LIMIT 5'
      );
      recentProps = recentPropsResult[0] || []; // Use first element of result array
    } catch (recentPropsError) {
      logger.error('Error fetching recent properties:', recentPropsError.message);
      // Continue with empty array
    }
    
    // Get recent users
    let recentUsers = [];
    try {
      const recentUsersResult = await pool.execute(
        'SELECT id, email, full_name, created_at ' +
        'FROM users ' +
        'ORDER BY created_at DESC ' +
        'LIMIT 5'
      );
      recentUsers = recentUsersResult[0] || []; // Use first element of result array
    } catch (recentUsersError) {
      logger.error('Error fetching recent users:', recentUsersError.message);
      // Continue with empty array
    }
    
    // Calculate stats
    const activeListings = propertiesData.filter(p => p.status === 'available' || p.status === 'active').length;
    const recentSales = propertiesData.filter(p => p.status === 'sold').length;
    const totalAdmins = usersData.filter(user => user.role === 'admin' || user.role === 'sub-admin').length;
    
    // Count pending enquiries
    const pendingApprovals = enquiries.filter(e => e.status === 'pending').length;
    
    res.json({
      totalProperties: propertiesData.length,
      totalUsers: usersData.length,
      totalAdmins,
      activeListings,
      activeProperties: activeListings, // Add this field to match what the frontend expects
      totalEnquiries: enquiries.length,
      recentSales,
      pendingApprovals,
      recentProperties: recentProps,
      recentUsers,
      dbStatus: 'connected',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error fetching dashboard data:', error.message);
    
    // Return a more detailed error response
    res.status(500).json({ 
      error: 'Server error fetching dashboard data',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
      timestamp: new Date().toISOString()
    });
  }
});

// Get monthly trends data
router.get('/dashboard/monthly-trends', auth, adminAuth, async (req, res) => {
  try {
    // Get data for the last 6 months
    const monthlyTrends = [];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    for (let i = 5; i >= 0; i--) {
      const date = new Date();
      date.setMonth(date.getMonth() - i);
      const year = date.getFullYear();
      const month = date.getMonth() + 1;
      const monthName = months[date.getMonth()];
      
      // Get properties count for this month
      let propertiesCount = 0;
      try {
        const [propertiesResult] = await pool.execute(
          'SELECT COUNT(*) as count FROM properties WHERE YEAR(created_at) = ? AND MONTH(created_at) = ?',
          [year, month]
        );
        propertiesCount = propertiesResult[0]?.count || 0;
      } catch (err) {
        console.log('Error fetching properties for month:', err.message);
      }
      
      // Get users count for this month
      let usersCount = 0;
      try {
        const [usersResult] = await pool.execute(
          'SELECT COUNT(*) as count FROM users WHERE YEAR(created_at) = ? AND MONTH(created_at) = ?',
          [year, month]
        );
        usersCount = usersResult[0]?.count || 0;
      } catch (err) {
        console.log('Error fetching users for month:', err.message);
      }
      
      // Get enquiries count for this month
      let enquiriesCount = 0;
      try {
        const [enquiriesResult] = await pool.execute(
          'SELECT COUNT(*) as count FROM property_enquiries WHERE YEAR(created_at) = ? AND MONTH(created_at) = ?',
          [year, month]
        );
        enquiriesCount = enquiriesResult[0]?.count || 0;
      } catch (err) {
        console.log('Error fetching enquiries for month:', err.message);
      }
      
      monthlyTrends.push({
        name: monthName,
        properties: propertiesCount,
        users: usersCount,
        enquiries: enquiriesCount
      });
    }
    
    res.json(monthlyTrends);
  } catch (error) {
    logger.error('Error fetching monthly trends:', error);
    res.status(500).json({ 
      error: 'Server error fetching monthly trends',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get property types distribution
router.get('/dashboard/property-types', auth, adminAuth, async (req, res) => {
  try {
    let propertyTypes = [];
    
    try {
      const [result] = await pool.execute(`
        SELECT 
          property_type,
          COUNT(*) as count,
          ROUND((COUNT(*) * 100.0 / (SELECT COUNT(*) FROM properties)), 1) as percentage
        FROM properties 
        WHERE property_type IS NOT NULL 
        GROUP BY property_type
        ORDER BY count DESC
      `);
      
      const colors = ['#1976d2', '#dc004e', '#2e7d32', '#ed6c02', '#9c27b0', '#f57c00'];
      
      propertyTypes = result.map((item, index) => ({
        name: item.property_type || 'Other',
        value: parseFloat(item.percentage) || 0,
        count: item.count || 0,
        color: colors[index % colors.length]
      }));
      
    } catch (err) {
      console.log('Error fetching property types:', err.message);
      // Return default data if query fails
      propertyTypes = [
        { name: 'No Data', value: 100, count: 0, color: '#1976d2' }
      ];
    }
    
    res.json(propertyTypes);
  } catch (error) {
    logger.error('Error fetching property types:', error);
    res.status(500).json({ 
      error: 'Server error fetching property types',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get dashboard statistics with percentage changes
router.get('/dashboard/stats-with-changes', auth, adminAuth, async (req, res) => {
  try {
    // Get current month data
    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const currentMonth = currentDate.getMonth() + 1;
    
    // Get previous month data
    const prevDate = new Date();
    prevDate.setMonth(prevDate.getMonth() - 1);
    const prevYear = prevDate.getFullYear();
    const prevMonth = prevDate.getMonth() + 1;
    
    // Get current month stats
    let currentStats = { properties: 0, users: 0, enquiries: 0, activeProperties: 0 };
    let prevStats = { properties: 0, users: 0, enquiries: 0, activeProperties: 0 };
    
    try {
      // Current month properties
      const [currentPropsResult] = await pool.execute(
        'SELECT COUNT(*) as count FROM properties WHERE YEAR(created_at) = ? AND MONTH(created_at) = ?',
        [currentYear, currentMonth]
      );
      currentStats.properties = currentPropsResult[0]?.count || 0;
      
      // Previous month properties
      const [prevPropsResult] = await pool.execute(
        'SELECT COUNT(*) as count FROM properties WHERE YEAR(created_at) = ? AND MONTH(created_at) = ?',
        [prevYear, prevMonth]
      );
      prevStats.properties = prevPropsResult[0]?.count || 0;
      
      // Current month users
      const [currentUsersResult] = await pool.execute(
        'SELECT COUNT(*) as count FROM users WHERE YEAR(created_at) = ? AND MONTH(created_at) = ?',
        [currentYear, currentMonth]
      );
      currentStats.users = currentUsersResult[0]?.count || 0;
      
      // Previous month users
      const [prevUsersResult] = await pool.execute(
        'SELECT COUNT(*) as count FROM users WHERE YEAR(created_at) = ? AND MONTH(created_at) = ?',
        [prevYear, prevMonth]
      );
      prevStats.users = prevUsersResult[0]?.count || 0;
      
      // Current month enquiries
      const [currentEnqResult] = await pool.execute(
        'SELECT COUNT(*) as count FROM property_enquiries WHERE YEAR(created_at) = ? AND MONTH(created_at) = ?',
        [currentYear, currentMonth]
      );
      currentStats.enquiries = currentEnqResult[0]?.count || 0;
      
      // Previous month enquiries
      const [prevEnqResult] = await pool.execute(
        'SELECT COUNT(*) as count FROM property_enquiries WHERE YEAR(created_at) = ? AND MONTH(created_at) = ?',
        [prevYear, prevMonth]
      );
      prevStats.enquiries = prevEnqResult[0]?.count || 0;
      
      // Active properties (current total)
      const [activePropsResult] = await pool.execute(
        'SELECT COUNT(*) as count FROM properties WHERE status IN ("active", "available")'
      );
      currentStats.activeProperties = activePropsResult[0]?.count || 0;
      
      // Previous month active properties (approximate)
      const [prevActivePropsResult] = await pool.execute(
        'SELECT COUNT(*) as count FROM properties WHERE status IN ("active", "available") AND created_at < ?',
        [`${prevYear}-${prevMonth.toString().padStart(2, '0')}-01`]
      );
      prevStats.activeProperties = prevActivePropsResult[0]?.count || 0;
      
    } catch (err) {
      console.log('Error fetching stats:', err.message);
    }
    
    // Calculate percentage changes
    const calculateChange = (current, previous) => {
      if (previous === 0) return current > 0 ? 100 : 0;
      return Math.round(((current - previous) / previous) * 100);
    };
    
    const changes = {
      properties: calculateChange(currentStats.properties, prevStats.properties),
      users: calculateChange(currentStats.users, prevStats.users),
      enquiries: calculateChange(currentStats.enquiries, prevStats.enquiries),
      activeProperties: calculateChange(currentStats.activeProperties, prevStats.activeProperties)
    };
    
    res.json({
      current: currentStats,
      previous: prevStats,
      changes: changes
    });
    
  } catch (error) {
    logger.error('Error fetching stats with changes:', error);
    res.status(500).json({ 
      error: 'Server error fetching stats with changes',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get all users (admin only)
router.get('/users', auth, adminAuth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      'SELECT id, email, full_name, role, created_at, updated_at FROM users ORDER BY created_at DESC'
    );
    
    res.json(rows);
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error fetching users:', error);
    }
    res.status(500).json({ error: 'Server error fetching users' });
  }
});

// Get user by ID (admin only)
router.get('/users/:id', auth, adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    const [rows] = await pool.execute(
      'SELECT id, email, full_name, role, created_at, updated_at FROM users WHERE id = ?',
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    res.json(rows[0]);
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error fetching user:', error);
    }
    res.status(500).json({ error: 'Server error fetching user' });
  }
});

// Update user role (admin only)
router.put('/users/:id/role', auth, adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;
    
    // Validate user ID
    if (!id || isNaN(parseInt(id))) {
      return res.status(400).json({ error: 'Valid user ID is required' });
    }
    
    if (!role || !['admin', 'sub-admin', 'user'].includes(role)) {
      return res.status(400).json({ error: 'Valid role is required' });
    }
    
    const [result] = await pool.execute(
      'UPDATE users SET role = ?, updated_at = NOW() WHERE id = ?',
      [role, id]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Return the updated user data
    const [updatedUser] = await pool.execute(
      'SELECT id, email, full_name, role, email_confirmed, created_at FROM users WHERE id = ?',
      [id]
    );
    
    res.json(updatedUser[0]);
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error updating user role:', error);
    }
    res.status(500).json({ error: 'Server error updating user role' });
  }
});

// Delete user (admin only)
router.delete('/users/:id', auth, adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if user exists
    const userCheck = await pool.execute('SELECT id FROM users WHERE id = ?', [id]);
    
    if (userCheck.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Delete user (cascade will delete related data)
    await pool.execute('DELETE FROM users WHERE id = ?', [id]);
    
    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error deleting user:', error);
    }
    res.status(500).json({ error: 'Server error deleting user' });
  }
});

// Cleanup missing images endpoint
router.post('/cleanup-images', auth, adminAuth, async (req, res) => {
  try {
    logger.dev('🧹 Admin requested image cleanup');
    
    // Run the cleanup function
    await cleanupMissingImages();
    
    res.json({
      success: true,
      message: 'Image cleanup completed successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Error during image cleanup:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to cleanup images',
      message: error.message
    });
  }
});

// Get revenue analytics (if you have price data)
router.get('/dashboard/revenue-analytics', auth, adminAuth, async (req, res) => {
  try {
    let revenueData = [];
    
    try {
      // Get revenue by month for the last 6 months
      for (let i = 5; i >= 0; i--) {
        const date = new Date();
        date.setMonth(date.getMonth() - i);
        const year = date.getFullYear();
        const month = date.getMonth() + 1;
        const monthName = date.toLocaleString('default', { month: 'short' });
        
        // Calculate total property value for properties created this month
        const [revenueResult] = await pool.execute(`
          SELECT 
            COUNT(*) as properties_count,
            COALESCE(SUM(CAST(REPLACE(REPLACE(price, '₹', ''), ',', '') AS DECIMAL(15,2))), 0) as total_value,
            COALESCE(AVG(CAST(REPLACE(REPLACE(price, '₹', ''), ',', '') AS DECIMAL(15,2))), 0) as avg_price
          FROM properties 
          WHERE YEAR(created_at) = ? AND MONTH(created_at) = ?
          AND price IS NOT NULL AND price != ''
        `, [year, month]);
        
        revenueData.push({
          month: monthName,
          totalValue: revenueResult[0]?.total_value || 0,
          averagePrice: revenueResult[0]?.avg_price || 0,
          propertiesCount: revenueResult[0]?.properties_count || 0
        });
      }
    } catch (err) {
      console.log('Error fetching revenue data:', err.message);
    }
    
    res.json(revenueData);
  } catch (error) {
    logger.error('Error fetching revenue analytics:', error);
    res.status(500).json({ 
      error: 'Server error fetching revenue analytics',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get location analytics
router.get('/dashboard/location-analytics', auth, adminAuth, async (req, res) => {
  try {
    let locationData = [];
    
    try {
      const [result] = await pool.execute(`
        SELECT 
          city,
          COUNT(*) as count,
          ROUND((COUNT(*) * 100.0 / (SELECT COUNT(*) FROM properties WHERE city IS NOT NULL)), 1) as percentage,
          COALESCE(AVG(CAST(REPLACE(REPLACE(price, '₹', ''), ',', '') AS DECIMAL(15,2))), 0) as avg_price
        FROM properties 
        WHERE city IS NOT NULL AND city != ''
        GROUP BY city
        ORDER BY count DESC
        LIMIT 10
      `);
      
      const colors = ['#1976d2', '#dc004e', '#2e7d32', '#ed6c02', '#9c27b0', '#f57c00', '#795548', '#607d8b', '#e91e63', '#3f51b5'];
      
      locationData = result.map((item, index) => ({
        name: item.city || 'Unknown',
        value: parseFloat(item.percentage) || 0,
        count: item.count || 0,
        avgPrice: item.avg_price || 0,
        color: colors[index % colors.length]
      }));
      
    } catch (err) {
      console.log('Error fetching location data:', err.message);
      locationData = [{ name: 'No Data', value: 100, count: 0, avgPrice: 0, color: '#1976d2' }];
    }
    
    res.json(locationData);
  } catch (error) {
    logger.error('Error fetching location analytics:', error);
    res.status(500).json({ 
      error: 'Server error fetching location analytics',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get user role distribution
router.get('/dashboard/user-roles', auth, adminAuth, async (req, res) => {
  try {
    let roleData = [];
    
    try {
      const [result] = await pool.execute(`
        SELECT 
          role,
          COUNT(*) as count,
          ROUND((COUNT(*) * 100.0 / (SELECT COUNT(*) FROM users)), 1) as percentage
        FROM users 
        WHERE role IS NOT NULL 
        GROUP BY role
        ORDER BY count DESC
      `);
      
      const colors = ['#1976d2', '#dc004e', '#2e7d32', '#ed6c02', '#9c27b0'];
      
      roleData = result.map((item, index) => ({
        name: item.role || 'Unknown',
        value: parseFloat(item.percentage) || 0,
        count: item.count || 0,
        color: colors[index % colors.length]
      }));
      
    } catch (err) {
      console.log('Error fetching user roles:', err.message);
      roleData = [{ name: 'No Data', value: 100, count: 0, color: '#1976d2' }];
    }
    
    res.json(roleData);
  } catch (error) {
    logger.error('Error fetching user roles:', error);
    res.status(500).json({ 
      error: 'Server error fetching user roles',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get enquiry status distribution
router.get('/dashboard/enquiry-status', auth, adminAuth, async (req, res) => {
  try {
    let statusData = [];
    
    try {
      const [result] = await pool.execute(`
        SELECT 
          status,
          COUNT(*) as count,
          ROUND((COUNT(*) * 100.0 / (SELECT COUNT(*) FROM property_enquiries)), 1) as percentage
        FROM property_enquiries 
        WHERE status IS NOT NULL 
        GROUP BY status
        ORDER BY count DESC
      `);
      
      const colors = ['#1976d2', '#dc004e', '#2e7d32', '#ed6c02', '#9c27b0'];
      
      statusData = result.map((item, index) => ({
        name: item.status || 'Unknown',
        value: parseFloat(item.percentage) || 0,
        count: item.count || 0,
        color: colors[index % colors.length]
      }));
      
    } catch (err) {
      console.log('Error fetching enquiry status:', err.message);
      statusData = [{ name: 'No Data', value: 100, count: 0, color: '#1976d2' }];
    }
    
    res.json(statusData);
  } catch (error) {
    logger.error('Error fetching enquiry status:', error);
    res.status(500).json({ 
      error: 'Server error fetching enquiry status',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get top performing properties (with view counts if available)
router.get('/dashboard/top-properties', auth, adminAuth, async (req, res) => {
  try {
    let topProperties = [];
    
    try {
      const [result] = await pool.execute(`
        SELECT 
          p.id,
          p.title,
          p.price,
          p.status,
          p.created_at,
          COUNT(pe.id) as enquiry_count,
          (SELECT image_url FROM property_images WHERE property_id = p.id LIMIT 1) as image_url
        FROM properties p
        LEFT JOIN property_enquiries pe ON p.id = pe.property_id
        WHERE p.status IN ('active', 'available')
        GROUP BY p.id, p.title, p.price, p.status, p.created_at
        ORDER BY enquiry_count DESC, p.created_at DESC
        LIMIT 10
      `);
      
      topProperties = result.map(item => ({
        id: item.id,
        title: item.title || 'Untitled Property',
        price: item.price || '0',
        enquiries: item.enquiry_count || 0,
        views: Math.floor(Math.random() * 1000) + 100, // TODO: Implement real view tracking
        status: item.status,
        image_url: item.image_url
      }));
      
    } catch (err) {
      console.log('Error fetching top properties:', err.message);
      topProperties = [];
    }
    
    res.json(topProperties);
  } catch (error) {
    logger.error('Error fetching top properties:', error);
    res.status(500).json({ 
      error: 'Server error fetching top properties',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get user activity by hour (simplified version)
router.get('/dashboard/user-activity', auth, adminAuth, async (req, res) => {
  try {
    let activityData = [];
    
    try {
      // Get user registrations by hour of day
      const [userResult] = await pool.execute(`
        SELECT 
          HOUR(created_at) as hour,
          COUNT(*) as user_count
        FROM users 
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        GROUP BY HOUR(created_at)
        ORDER BY hour
      `);
      
      // Get enquiries by hour of day
      const [enquiryResult] = await pool.execute(`
        SELECT 
          HOUR(created_at) as hour,
          COUNT(*) as enquiry_count
        FROM property_enquiries 
        WHERE created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
        GROUP BY HOUR(created_at)
        ORDER BY hour
      `);
      
      // Create activity data for all 24 hours
      for (let hour = 0; hour < 24; hour += 4) {
        const userActivity = userResult.find(u => u.hour >= hour && u.hour < hour + 4);
        const enquiryActivity = enquiryResult.find(e => e.hour >= hour && e.hour < hour + 4);
        
        activityData.push({
          hour: `${hour.toString().padStart(2, '0')}:00`,
          users: userActivity ? userActivity.user_count : 0,
          enquiries: enquiryActivity ? enquiryActivity.enquiry_count : 0
        });
      }
      
    } catch (err) {
      console.log('Error fetching user activity:', err.message);
      // Fallback to empty data
      for (let hour = 0; hour < 24; hour += 4) {
        activityData.push({
          hour: `${hour.toString().padStart(2, '0')}:00`,
          users: 0,
          enquiries: 0
        });
      }
    }
    
    res.json(activityData);
  } catch (error) {
    logger.error('Error fetching user activity:', error);
    res.status(500).json({ 
      error: 'Server error fetching user activity',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;