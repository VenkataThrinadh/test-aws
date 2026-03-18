const jwt = require('jsonwebtoken');
const { pool } = require('../db');

module.exports = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret');

    // Decide which table to check based on token claim. If missing, try users first then staff.
    let userRecord = null;
    let userType = decoded.userType || null;

    if (userType === 'staff') {
      const [rows] = await pool.execute('SELECT * FROM staff WHERE id = ?', [decoded.id]);
      if (rows.length === 0) return res.status(401).json({ error: 'User not found' });
      userRecord = rows[0];
    } else if (userType === 'user') {
      const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [decoded.id]);
      if (rows.length === 0) return res.status(401).json({ error: 'User not found' });
      userRecord = rows[0];
    } else {
      // Backwards-compatible: try users first, then staff
      const [urows] = await pool.execute('SELECT * FROM users WHERE id = ?', [decoded.id]);
      if (urows.length > 0) {
        userRecord = urows[0];
        userType = 'user';
      } else {
        const [srows] = await pool.execute('SELECT * FROM staff WHERE id = ?', [decoded.id]);
        if (srows.length > 0) {
          userRecord = srows[0];
          userType = 'staff';
        }
      }
      if (!userRecord) return res.status(401).json({ error: 'User not found' });
    }

    // Normalize role: treat 'sub-admin' as admin for access checks
    let role = userRecord.role || (userType === 'staff' ? 'staff' : 'user');
    const originalRole = role;
    if (role === 'sub-admin') {
      role = 'admin';
    }

    // Attach minimal user info for downstream handlers
    req.user = {
      id: decoded.id,
      email: decoded.email,
      role,
      originalRole,
      userType,
      department: userRecord.department || null // Add department for staff
    };

    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') return res.status(401).json({ error: 'Invalid token' });
    if (error.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired' });
    return res.status(500).json({ error: 'Server error' });
  }
};