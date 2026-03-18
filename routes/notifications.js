const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const auth = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');
const logger = require('../utils/logger');

// Get all notifications for admin
router.get('/', auth, adminAuth, async (req, res) => {
  try {
    const { page = 1, limit = 20, unread_only = false } = req.query;
    const offset = (page - 1) * limit;
    
    let whereClause = '';
    let queryParams = [];
    // Staff/employee: only show notifications assigned to them
    if (req.user.role === 'staff' || req.user.role === 'employee' || req.user.department === 'sales') {
      whereClause = `WHERE CAST(JSON_UNQUOTE(JSON_EXTRACT(n.data, '$.assigned_staff_id')) AS CHAR) = ?`;
      queryParams.push(String(req.user.id));
      if (unread_only === 'true') {
        whereClause += ' AND n.is_read = FALSE';
      }
    } else {
      if (unread_only === 'true') {
        whereClause = 'WHERE n.is_read = FALSE';
      }
    }
    const query = `
      SELECT 
        n.id,
        n.type,
        n.title,
        n.message,
        n.data,
        n.is_read,
        n.created_at,
        u.full_name as user_name,
        u.email as user_email,
        p.title as property_title,
        s.full_name as assigned_staff_name,
        s.phone as assigned_staff_phone,
        s.email as assigned_staff_email,
        s.designation as assigned_staff_designation
      FROM notifications n
      LEFT JOIN users u ON JSON_EXTRACT(n.data, '$.user_id') = u.id
      LEFT JOIN properties p ON JSON_EXTRACT(n.data, '$.property_id') = p.id
      LEFT JOIN staff s ON JSON_EXTRACT(n.data, '$.assigned_staff_id') = s.id
      ${whereClause}
      ORDER BY n.created_at DESC
      LIMIT ? OFFSET ?
    `;
    queryParams.push(parseInt(limit), parseInt(offset));
    
    const [notifications] = await pool.execute(query, queryParams);
    
    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM notifications n ${whereClause}`;
    const [countResult] = await pool.execute(countQuery, queryParams);
    const total = countResult[0].total;
    
    // Get unread count
    const [unreadResult] = await pool.execute(
      'SELECT COUNT(*) as unread_count FROM notifications WHERE is_read = FALSE'
    );
    const unreadCount = unreadResult[0].unread_count;
    
    res.json({
      notifications: notifications.map(notification => {
        const parsedData = notification.data ? JSON.parse(notification.data) : null;
        // Add staff details from joined columns
        if (notification.assigned_staff_name) {
          parsedData.assigned_staff_name = notification.assigned_staff_name;
          parsedData.assigned_staff_phone = notification.assigned_staff_phone;
          parsedData.assigned_staff_email = notification.assigned_staff_email;
          parsedData.assigned_staff_designation = notification.assigned_staff_designation;
        }
        return {
          ...notification,
          data: parsedData
        };
      }),
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / limit)
      },
      unreadCount
    });
  } catch (error) {
    logger.error('Error fetching notifications:', error);
    res.status(500).json({ 
      error: 'Server error fetching notifications',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Mark notification as read
router.put('/:id/read', auth, adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    const [result] = await pool.execute(
      'UPDATE notifications SET is_read = TRUE, updated_at = NOW() WHERE id = ?',
      [id]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    
    res.json({ success: true, message: 'Notification marked as read' });
  } catch (error) {
    logger.error('Error marking notification as read:', error);
    res.status(500).json({ 
      error: 'Server error updating notification',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Mark all notifications as read
router.put('/mark-all-read', auth, adminAuth, async (req, res) => {
  try {
    const [result] = await pool.execute(
      'UPDATE notifications SET is_read = TRUE, updated_at = NOW() WHERE is_read = FALSE'
    );
    
    res.json({ 
      success: true, 
      message: `Marked ${result.affectedRows} notifications as read` 
    });
  } catch (error) {
    logger.error('Error marking all notifications as read:', error);
    res.status(500).json({ 
      error: 'Server error updating notifications',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Delete notification
router.delete('/:id', auth, adminAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    const [result] = await pool.execute(
      'DELETE FROM notifications WHERE id = ?',
      [id]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }
    
    res.json({ success: true, message: 'Notification deleted successfully' });
  } catch (error) {
    logger.error('Error deleting notification:', error);
    res.status(500).json({ 
      error: 'Server error deleting notification',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get unread notifications count
router.get('/unread-count', auth, adminAuth, async (req, res) => {
  try {
    // Test database connection first
    let connection;
    try {
      connection = await pool.getConnection();
    } catch (dbError) {
      logger.error('Database connection failed for unread count:', dbError.message);
      return res.json({ count: 0 }); // Return 0 count if database is unavailable
    }
    
    try {
      const [result] = await connection.execute(
        'SELECT COUNT(*) as count FROM notifications WHERE is_read = FALSE'
      );
      
      res.json({ count: result[0].count });
    } finally {
      if (connection) connection.release();
    }
    
  } catch (error) {
    logger.error('Error fetching unread count:', error);
    res.json({ count: 0 }); // Return 0 count on error instead of 500
  }
});

module.exports = router;