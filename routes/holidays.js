const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const auth = require('../middleware/auth');
const logger = require('../utils/logger');

// GET /holidays?year=2025
router.get('/', auth, async (req, res) => {
  try {
    let { year } = req.query;
    year = parseInt(year, 10) || new Date().getFullYear();
    const [rows] = await pool.execute(
      `SELECT date, name, type FROM holidays WHERE YEAR(date) = ? ORDER BY date ASC`,
      [year]
    );
    res.json({ holidays: rows });
  } catch (error) {
    logger.error('Error fetching holidays:', error);
    res.status(500).json({ error: 'Server error fetching holidays' });
  }
});

module.exports = router;
