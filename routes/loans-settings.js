/**
 * Settings API Routes
 * 
 * Manages loan system configuration and settings
 * 
 * Routes:
 *   GET    /api/loans/settings             - Get all settings
 *   GET    /api/loans/settings/:key        - Get specific setting
 *   PUT    /api/loans/settings/:key        - Update setting
 */

const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const logger = require('../utils/logger');

router.get('/', async (req, res) => {
  let connection = null;
  try {
    connection = await pool.getConnection();

    const [rows] = await connection.execute(
      'SELECT setting_key, setting_value, setting_type, description FROM loan_setting'
    );

    const settings = {};
    rows.forEach(row => {
      settings[row.setting_key] = {
        value: row.setting_value,
        type: row.setting_type,
        description: row.description
      };
    });

    res.json({
      success: true,
      message: 'Settings retrieved successfully',
      data: settings,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Get settings error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch settings',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

router.get('/:key', async (req, res) => {
  let connection = null;
  try {
    const { key } = req.params;

    if (!key) {
      return res.status(400).json({
        success: false,
        message: 'Setting key is required',
        timestamp: new Date().toISOString()
      });
    }

    connection = await pool.getConnection();
    const [rows] = await connection.execute(
      'SELECT setting_key, setting_value, setting_type, description FROM loan_setting WHERE setting_key = ?',
      [key]
    );

    if (rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'Setting not found',
        timestamp: new Date().toISOString()
      });
    }

    res.json({
      success: true,
      message: 'Setting retrieved successfully',
      data: rows[0],
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Get setting error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch setting',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

router.put('/:key', async (req, res) => {
  let connection = null;
  try {
    const { key } = req.params;
    const { setting_value, description } = req.body;

    if (!key || setting_value === undefined) {
      return res.status(400).json({
        success: false,
        message: 'Setting key and value are required',
        timestamp: new Date().toISOString()
      });
    }

    connection = await pool.getConnection();

    // Check if setting exists
    const [existing] = await connection.execute(
      'SELECT * FROM loan_setting WHERE setting_key = ?',
      [key]
    );

    if (existing.length === 0) {
      // Insert new setting
      await connection.execute(
        `INSERT INTO loan_setting (setting_key, setting_value, description, created_at, updated_at)
         VALUES (?, ?, ?, NOW(), NOW())`,
        [key, String(setting_value), description || '']
      );
    } else {
      // Update existing setting
      await connection.execute(
        `UPDATE loan_setting SET setting_value = ?, description = ?, updated_at = NOW() WHERE setting_key = ?`,
        [String(setting_value), description || existing[0].description, key]
      );
    }

    res.json({
      success: true,
      message: 'Setting updated successfully',
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('Update setting error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update setting',
      error: process.env.NODE_ENV === 'development' ? error.message : undefined,
      timestamp: new Date().toISOString()
    });
  } finally {
    if (connection) connection.release();
  }
});

module.exports = router;
