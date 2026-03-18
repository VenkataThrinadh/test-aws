
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const { pool } = require('../db');
const auth = require('../middleware/auth');
const logger = require('../utils/logger');

// --- Batch Recalculate Working Hours ---
// POST /staff/recalculate-working-hours (admin only)
// --- Batch Recalculate Working Hours (UTC logic) ---
router.post('/recalculate-working-hours', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    // Fetch all logs with both login_time and logout_time
    const [logs] = await pool.execute(
      `SELECT id, login_time, logout_time FROM attendance_logs WHERE login_time IS NOT NULL AND logout_time IS NOT NULL`
    );
    let updated = 0;
    for (const log of logs) {
      const loginTime = new Date(log.login_time);
      const logoutTime = new Date(log.logout_time);
      // Both times are stored in IST, so direct subtraction is correct
      let workingHours = (logoutTime - loginTime) / (1000 * 60 * 60);
      if (workingHours < 0) workingHours = 0;
      if (workingHours > 24) workingHours = 24;
      await pool.execute(
        `UPDATE attendance_logs SET working_hours = ? WHERE id = ?`,
        [workingHours.toFixed(2), log.id]
      );
      updated++;
    }
    res.json({ success: true, updated });
  } catch (error) {
    logger.error('Error recalculating working_hours:', error);
    res.status(500).json({ error: 'Server error recalculating working_hours' });
  }
});


// --- Attendance Calendar Data ---
// GET /staff/attendance?staff_id=123&year=2025&month=12
router.get('/attendance', auth, async (req, res) => {
  try {
    let { staff_id } = req.query;
    if (!staff_id) return res.status(400).json({ error: 'Missing staff_id' });
    // Only admin can view all, staff can view their own
    if (req.user.role !== 'admin' && req.user.id != staff_id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    // Get employee creation date
    const [staffRows] = await pool.execute('SELECT created_at FROM staff WHERE id = ?', [staff_id]);
    if (!staffRows.length) return res.status(404).json({ error: 'Staff not found' });
    const createdAt = new Date(staffRows[0].created_at);
    const today = new Date();
    // Get weekly holiday assignment (only active)
    const [weeklyRows] = await pool.execute('SELECT day_of_week FROM staff_weekly_holidays WHERE staff_id = ? AND is_active = 1', [staff_id]);
    const weeklyOffDays = weeklyRows.map(r => r.day_of_week); // 0=Sunday, 1=Monday, ...
    // Get all attendance logs for staff
    const [attendanceRows] = await pool.execute('SELECT date, status, working_hours FROM attendance_logs WHERE staff_id = ? ORDER BY date ASC', [staff_id]);
    // Get all holidays
    const year = today.getFullYear();
    const [holidayRows] = await pool.execute('SELECT date, name FROM holidays WHERE YEAR(date) = ?', [year]);
    // Build calendar from createdAt to today
    let calendar = [];
    let current = new Date(createdAt);
    while (current <= today) {
      const dateStr = current.toISOString().slice(0, 10);
      // Check attendance log
      const log = attendanceRows.find(a => a.date.toISOString().slice(0, 10) === dateStr);
      // Check holiday
      const holiday = holidayRows.find(h => h.date.toISOString().slice(0, 10) === dateStr);
      // Check weekly-off
      const dayOfWeek = current.getDay();
      let status = 'absent';
        if (holiday) {
          status = 'holiday';
        } else if (weeklyOffDays.includes(dayOfWeek)) {
          status = 'weekly-off';
        } else if (log && log.working_hours >= 8) {
          status = 'present';
        } else if (log && log.status === 'present') {
          status = 'present';
        } else if (log && log.status === 'absent') {
          status = 'absent';
        }
      calendar.push({ date: dateStr, status, working_hours: log ? log.working_hours : 0 });
      current.setDate(current.getDate() + 1);
    }
    res.json({ attendance: calendar });
  } catch (error) {
    logger.error('Error fetching attendance for calendar:', error);
    res.status(500).json({ error: 'Server error fetching attendance' });
  }
});

// --- Attendance Summary Data ---
// GET /staff/attendance-summary?staff_id=123&year=2025
router.get('/attendance-summary', auth, async (req, res) => {
  try {
    let { staff_id, year } = req.query;
    if (!staff_id) return res.status(400).json({ error: 'Missing staff_id' });
    year = parseInt(year, 10) || new Date().getFullYear();
    // Only admin can view all, staff can view their own
    if (req.user.role !== 'admin' && req.user.id != staff_id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    // Monthly summary
    const [monthly] = await pool.execute(
      `SELECT MONTH(date) as month, COUNT(*) as daysPresent
         FROM attendance_logs
         WHERE staff_id = ? AND status = 'present' AND working_hours >= 8 AND YEAR(date) = ?
         GROUP BY MONTH(date)
         ORDER BY month ASC`,
      [staff_id, year]
    );
    // Yearly summary
    const [yearlyRows] = await pool.execute(
      `SELECT YEAR(date) as year, COUNT(*) as daysPresent
         FROM attendance_logs
         WHERE staff_id = ? AND status = 'present' AND working_hours >= 8 AND YEAR(date) = ?
         GROUP BY YEAR(date)`,
      [staff_id, year]
    );
    const yearly = yearlyRows[0] || null;
    res.json({ monthly, yearly });
  } catch (error) {
    logger.error('Error fetching attendance summary:', error);
    res.status(500).json({ error: 'Server error fetching attendance summary' });
  }
});

// --- Holidays API for Attendance Calendar ---
// GET /holidays?year=2025
router.get('/holidays', auth, async (req, res) => {
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

// Get attendance logs for staff (admin or self)
router.get('/attendance-logs', auth, async (req, res) => {
  try {
    let { staff_id, start_date, end_date, page, limit } = req.query;
    page = parseInt(page, 10) || 1;
    limit = parseInt(limit, 10) || 30;
    const offset = (page - 1) * limit;

    // Only admin can view all, staff can view their own
    if (req.user.role !== 'admin') {
      staff_id = req.user.id;
    }
    let where = 'WHERE 1=1';
    const params = [];
    if (staff_id) {
      where += ' AND staff_id = ?';
      params.push(staff_id);
    }
    if (start_date) {
      where += ' AND date >= ?';
      params.push(start_date);
    }
    if (end_date) {
      where += ' AND date <= ?';
      params.push(end_date);
    }
    const [logsRaw] = await pool.execute(
      `SELECT al.*, s.full_name, s.department, s.designation
       FROM attendance_logs al
       LEFT JOIN staff s ON al.staff_id = s.id
       ${where}
       ORDER BY date DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );
    // Ensure login_time and logout_time are returned as plain strings (no timezone conversion)
    const logs = logsRaw.map(row => ({
      ...row,
      login_time: row.login_time ? row.login_time.toISOString ? row.login_time.toISOString().replace('T', ' ').slice(0, 19) : String(row.login_time) : '',
      logout_time: row.logout_time ? row.logout_time.toISOString ? row.logout_time.toISOString().replace('T', ' ').slice(0, 19) : String(row.logout_time) : '',
    }));
    const [countRows] = await pool.execute(
      `SELECT COUNT(*) as total FROM attendance_logs ${where}`,
      params
    );
    res.json({ logs, total: countRows[0].total, page, limit });
  } catch (error) {
    logger.error('Error fetching attendance logs:', error);
    res.status(500).json({ error: 'Server error fetching attendance logs' });
  }
});

// --- Weekly Holiday & Fallback API ---
// Get all weekly holiday/fallback assignments
router.get('/weekly-holidays', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Not authorized' });
    const [rows] = await pool.execute(
      `SELECT swh.*, s.full_name as staff_name, f.full_name as fallback_name
       FROM staff_weekly_holidays swh
       LEFT JOIN staff s ON swh.staff_id = s.id
       LEFT JOIN staff f ON swh.fallback_staff_id = f.id`
    );
    res.json({ assignments: rows });
  } catch (error) {
    logger.error('Error fetching weekly holidays:', error);
    res.status(500).json({ error: 'Server error fetching weekly holidays' });
  }
});

// Set or update a weekly holiday/fallback assignment
router.post('/weekly-holidays', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Not authorized' });
    const { staff_id, day_of_week, is_active, fallback_staff_id } = req.body;
    if (!staff_id || !day_of_week) return res.status(400).json({ error: 'Missing staff_id or day_of_week' });
    // Upsert logic
    await pool.execute(
      `INSERT INTO staff_weekly_holidays (staff_id, day_of_week, is_active, fallback_staff_id)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE is_active=VALUES(is_active), fallback_staff_id=VALUES(fallback_staff_id), updated_at=NOW()`,
      [staff_id, day_of_week, is_active ? 1 : 0, fallback_staff_id || null]
    );
    res.json({ success: true });
  } catch (error) {
    logger.error('Error saving weekly holiday:', error);
    res.status(500).json({ error: 'Server error saving weekly holiday' });
  }
});

// Helper to generate 8-digit numeric password based on email and employee_id
function deriveNumericPassword(email, employeeId) {
  const base = `${(employeeId || '').toString()}|${(email || '').toLowerCase()}`;
  // Simple deterministic hash to 32-bit unsigned integer
  let hash = 2166136261; // FNV-1a offset basis
  for (let i = 0; i < base.length; i++) {
    hash ^= base.charCodeAt(i);
    hash = (hash >>> 0) * 16777619; // FNV-1a prime, keep unsigned
    hash >>>= 0;
  }
  // Convert to 8-digit numeric string
  const num = (hash % 100000000) >>> 0; // 0..99,999,999
  return num.toString().padStart(8, '0');
}

// Get all staff members
router.get('/', auth, async (req, res) => {
  try {
    // Allow access for admin or sales department
    if (req.user.role !== 'admin' && req.user.department !== 'sales') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const { limit, sort, order, page, search, department, status } = req.query;

    let query = `SELECT * FROM staff WHERE 1=1`;
    let params = [];

    // Add search filter
    if (search) {
      query += ` AND (full_name LIKE ? OR email LIKE ? OR employee_id LIKE ?)`;
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    // Add department filter
    if (department && department !== 'all') {
      query += ` AND department = ?`;
      params.push(department);
    }

    // Add status filter
    if (status && status !== 'all') {
      query += ` AND status = ?`;
      params.push(status);
    }

    // Add sorting
    const sortField = sort === 'created_at' ? 'created_at' : 'created_at';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
    query += ` ORDER BY ${sortField} ${sortOrder}`;

    // Add pagination
    if (limit) {
      const limitNum = parseInt(limit, 10) || 10;
      const pageNum = parseInt(page, 10) || 1;
      const offset = (pageNum - 1) * limitNum;
      query += ` LIMIT ? OFFSET ?`;
      params.push(limitNum, offset);
    }

    // Execute the main query
    const [rows] = await pool.execute(query, params);

    // Get total count for pagination
    let countQuery = `SELECT COUNT(*) as total FROM staff WHERE 1=1`;
    let countParams = [];

    if (search) {
      countQuery += ` AND (full_name LIKE ? OR email LIKE ? OR employee_id LIKE ?)`;
      countParams.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (department && department !== 'all') {
      countQuery += ` AND department = ?`;
      countParams.push(department);
    }

    if (status && status !== 'all') {
      countQuery += ` AND status = ?`;
      countParams.push(status);
    }

    const [countResult] = await pool.execute(countQuery, countParams);
    const total = countResult[0].total;

    res.json({
      staff: rows,
      total: total,
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || total
    });
  } catch (error) {
    logger.error('Error fetching staff:', error);
    res.status(500).json({
      error: 'Server error fetching staff',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get staff member by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;

    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const [rows] = await pool.execute(
      'SELECT s.*, p.title as project_name FROM staff s LEFT JOIN properties p ON s.project_id = p.id WHERE s.id = ?',
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    const staff = rows[0];
    // Compute plain password for admin view only, do not persist
    const derivedPlainPassword = deriveNumericPassword(staff.email, staff.employee_id);

    res.json({ staff: { ...staff, derived_plain_password: derivedPlainPassword } });
  } catch (error) {
    logger.error('Error fetching staff member:', error);
    res.status(500).json({ error: 'Server error fetching staff member' });
  }
});

// Create new staff member
router.post('/', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to create staff' });
    }

    const {
      employee_id,
      full_name,
      email,
      phone,
      department,
      designation,
      project_id,
      status = 'active',
      address,
      date_of_joining,
      qualification,
      experience_years,
      skills,
      performance_rating,
      emergency_contact_name,
      emergency_contact_phone,
      emergency_contact_relation,
      last_performance_review
    } = req.body;

    // Validate required fields
    if (!full_name || !full_name.trim()) {
      return res.status(400).json({ error: 'Full name is required' });
    }

    if (!email || !email.trim()) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    // Check if email already exists
    const [existingStaff] = await pool.execute(
      'SELECT id FROM staff WHERE email = ?',
      [email]
    );

    if (existingStaff.length > 0) {
      return res.status(409).json({ error: 'Email already exists' });
    }

    // Check if employee_id already exists (if provided)
    if (employee_id) {
      const [existingEmployeeId] = await pool.execute(
        'SELECT id FROM staff WHERE employee_id = ?',
        [employee_id]
      );

      if (existingEmployeeId.length > 0) {
        return res.status(409).json({ error: 'Employee ID already exists' });
      }
    }

    // Generate deterministic 8-digit numeric password based on email and employee_id
    const generatedPassword = deriveNumericPassword(email, employee_id);
    const hashedPassword = await bcrypt.hash(generatedPassword, 10);

    // Insert new staff member
    const [result] = await pool.execute(
      `INSERT INTO staff (
        employee_id, full_name, email, phone, department, designation, project_id, status, address,
        date_of_joining, qualification, experience_years, skills, performance_rating, password,
        emergency_contact_name, emergency_contact_phone, emergency_contact_relation, last_performance_review,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [employee_id, full_name, email, phone, department, designation, project_id, status, address,
       date_of_joining, qualification, experience_years, skills, performance_rating, hashedPassword,
       emergency_contact_name, emergency_contact_phone, emergency_contact_relation, last_performance_review]
    );

    const staffId = result.insertId;

    // Get the created staff member
    const [newStaff] = await pool.execute(
      'SELECT * FROM staff WHERE id = ?',
      [staffId]
    );

    logger.info('Staff member created successfully:', {
      id: staffId,
      email: email,
      department: department,
      generatedPassword: generatedPassword
    });

    // Return created staff with the generated password (plaintext, for one-time display)
    const responseData = { ...newStaff[0], generatedPassword };
    res.status(201).json(responseData);
  } catch (error) {
    logger.error('Error creating staff member:', error);
    res.status(500).json({
      error: 'Server error creating staff member',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Update staff member
router.put('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;

    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const {
      employee_id,
      full_name,
      email,
      phone,
      department,
      designation,
      project_id,
      status,
      address,
      date_of_joining,
      qualification,
      experience_years,
      skills,
      performance_rating,
      emergency_contact_name,
      emergency_contact_phone,
      emergency_contact_relation,
      last_performance_review
    } = req.body;

    // Check if staff member exists
    const [staffCheck] = await pool.execute('SELECT id FROM staff WHERE id = ?', [id]);
    if (staffCheck.length === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    // Check if email is already used by another staff member
    if (email) {
      const [existingEmail] = await pool.execute(
        'SELECT id FROM staff WHERE email = ? AND id != ?',
        [email, id]
      );

      if (existingEmail.length > 0) {
        return res.status(409).json({ error: 'Email already exists' });
      }
    }

    // Check if employee_id is already used by another staff member
    if (employee_id) {
      const [existingEmployeeId] = await pool.execute(
        'SELECT id FROM staff WHERE employee_id = ? AND id != ?',
        [employee_id, id]
      );

      if (existingEmployeeId.length > 0) {
        return res.status(409).json({ error: 'Employee ID already exists' });
      }
    }

    // Update staff member
    await pool.execute(
      `UPDATE staff SET
        employee_id = COALESCE(?, employee_id),
        full_name = COALESCE(?, full_name),
        email = COALESCE(?, email),
        phone = COALESCE(?, phone),
        department = COALESCE(?, department),
        designation = COALESCE(?, designation),
        project_id = COALESCE(?, project_id),
        status = COALESCE(?, status),
        address = COALESCE(?, address),
        date_of_joining = COALESCE(?, date_of_joining),
        qualification = COALESCE(?, qualification),
        experience_years = COALESCE(?, experience_years),
        skills = COALESCE(?, skills),
        performance_rating = COALESCE(?, performance_rating),
        emergency_contact_name = COALESCE(?, emergency_contact_name),
        emergency_contact_phone = COALESCE(?, emergency_contact_phone),
        emergency_contact_relation = COALESCE(?, emergency_contact_relation),
        last_performance_review = COALESCE(?, last_performance_review),
        updated_at = NOW()
      WHERE id = ?`,
      [employee_id, full_name, email, phone, department, designation, project_id, status, address,
       date_of_joining, qualification, experience_years, skills, performance_rating,
       emergency_contact_name, emergency_contact_phone, emergency_contact_relation, last_performance_review, id]
    );

    // Get updated staff member
    const [updatedStaff] = await pool.execute(
      'SELECT * FROM staff WHERE id = ?',
      [id]
    );

    res.json(updatedStaff[0]);
  } catch (error) {
    logger.error('Error updating staff member:', error);
    // Log the full error for debugging
    console.error('Staff update error details:', {
      message: error.message,
      code: error.code,
      sqlState: error.sqlState,
      sql: error.sql,
      errno: error.errno
    });
    res.status(500).json({ 
      error: 'Server error updating staff member',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Update staff member status
router.put('/:id/status', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (!status || !['active', 'inactive', 'on_leave'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const [result] = await pool.execute(
      'UPDATE staff SET status = ?, updated_at = NOW() WHERE id = ?',
      [status, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    res.json({ id, status });
  } catch (error) {
    logger.error('Error updating staff status:', error);
    res.status(500).json({ error: 'Server error updating staff status' });
  }
});

// Update staff member department
router.put('/:id/department', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { department } = req.body;

    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (!department) {
      return res.status(400).json({ error: 'Department is required' });
    }

    const [result] = await pool.execute(
      'UPDATE staff SET department = ?, updated_at = NOW() WHERE id = ?',
      [department, id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    res.json({ id, department });
  } catch (error) {
    logger.error('Error updating staff department:', error);
    res.status(500).json({ error: 'Server error updating staff department' });
  }
});



// Delete staff member
router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;

    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Check if staff member exists
    const [staffCheck] = await pool.execute('SELECT id, full_name, email FROM staff WHERE id = ?', [id]);
    if (staffCheck.length === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    const staffToDelete = staffCheck[0];

    // Delete staff member
    const [result] = await pool.execute('DELETE FROM staff WHERE id = ?', [id]);

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    logger.info('Staff member deleted successfully:', {
      id: id,
      email: staffToDelete.email,
      full_name: staffToDelete.full_name
    });

    res.json({
      message: 'Staff member deleted successfully',
      deletedStaff: {
        id: parseInt(id),
        email: staffToDelete.email,
        full_name: staffToDelete.full_name
      }
    });
  } catch (error) {
    logger.error('Error deleting staff member:', error);
    res.status(500).json({ error: 'Server error deleting staff member' });
  }
});

// Bulk operations for staff
router.delete('/bulk', auth, async (req, res) => {
  try {
    const { ids } = req.body;

    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Valid array of staff IDs is required' });
    }

    const validIds = ids.filter(id => !isNaN(parseInt(id))).map(id => parseInt(id));
    if (validIds.length === 0) {
      return res.status(400).json({ error: 'No valid staff IDs provided' });
    }

    // Check which staff members exist
    const placeholders = validIds.map(() => '?').join(',');
    const [existingStaff] = await pool.execute(
      `SELECT id, email, full_name FROM staff WHERE id IN (${placeholders})`,
      validIds
    );

    if (existingStaff.length === 0) {
      return res.status(404).json({ error: 'No staff members found with provided IDs' });
    }

    const existingIds = existingStaff.map(staff => staff.id);

    // Delete staff members
    const deletePlaceholders = existingIds.map(() => '?').join(',');
    const [deleteResult] = await pool.execute(
      `DELETE FROM staff WHERE id IN (${deletePlaceholders})`,
      existingIds
    );

    const response = {
      message: `Bulk deletion completed`,
      summary: {
        requested: validIds.length,
        successful: deleteResult.affectedRows,
        failed: validIds.length - deleteResult.affectedRows
      },
      deletedStaff: existingStaff
    };

    logger.info('Bulk staff deletion completed:', response.summary);

    res.json(response);
  } catch (error) {
    logger.error('Error in bulk delete staff:', error);
    res.status(500).json({
      error: 'Server error during bulk deletion',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get staff statistics
router.get('/statistics/overview', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Get total staff count
    const [totalResult] = await pool.execute('SELECT COUNT(*) as total FROM staff');
    const total = totalResult[0].total;

    // Get staff by department
    const [departmentResult] = await pool.execute(`
      SELECT department, COUNT(*) as count
      FROM staff
      WHERE department IS NOT NULL AND department != ''
      GROUP BY department
      ORDER BY count DESC
    `);

    // Get staff by status
    const [statusResult] = await pool.execute(`
      SELECT status, COUNT(*) as count
      FROM staff
      GROUP BY status
      ORDER BY count DESC
    `);

    // Get recent additions (last 30 days)
    const [recentResult] = await pool.execute(`
      SELECT COUNT(*) as recent
      FROM staff
      WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
    `);

    res.json({
      total: total,
      byDepartment: departmentResult,
      byStatus: statusResult,
      recentAdditions: recentResult[0].recent
    });
  } catch (error) {
    logger.error('Error fetching staff statistics:', error);
    res.status(500).json({ error: 'Server error fetching staff statistics' });
  }
});


// --- Attendance Calendar Data ---
// GET /staff/attendance?staff_id=123&year=2025&month=12
router.get('/attendance', auth, async (req, res) => {
  try {
    let { staff_id, year, month } = req.query;
    if (!staff_id) return res.status(400).json({ error: 'Missing staff_id' });
    year = parseInt(year, 10) || new Date().getFullYear();
    month = parseInt(month, 10) || (new Date().getMonth() + 1);
    // Only admin can view all, staff can view their own
    if (req.user.role !== 'admin' && req.user.id != staff_id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    const [rows] = await pool.execute(
      `SELECT date, status, working_hours
       FROM attendance_logs
       WHERE staff_id = ? AND YEAR(date) = ? AND MONTH(date) = ?
       ORDER BY date ASC`,
      [staff_id, year, month]
    );
    res.json({ attendance: rows });
  } catch (error) {
    logger.error('Error fetching attendance for calendar:', error);
    res.status(500).json({ error: 'Server error fetching attendance' });
  }
});

// --- Attendance Summary Data ---
// GET /staff/attendance-summary?staff_id=123&year=2025
router.get('/attendance-summary', auth, async (req, res) => {
  try {
    let { staff_id, year } = req.query;
    if (!staff_id) return res.status(400).json({ error: 'Missing staff_id' });
    year = parseInt(year, 10) || new Date().getFullYear();
    // Only admin can view all, staff can view their own
    if (req.user.role !== 'admin' && req.user.id != staff_id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    // Monthly summary
    const [monthly] = await pool.execute(
      `SELECT MONTH(date) as month, COUNT(*) as daysPresent
         FROM attendance_logs
         WHERE staff_id = ? AND status = 'present' AND working_hours >= 8 AND YEAR(date) = ?
         GROUP BY MONTH(date)
         ORDER BY month ASC`,
      [staff_id, year]
    );
    // Yearly summary
    const [yearlyRows] = await pool.execute(
      `SELECT YEAR(date) as year, COUNT(*) as daysPresent
         FROM attendance_logs
         WHERE staff_id = ? AND status = 'present' AND working_hours >= 8 AND YEAR(date) = ?
         GROUP BY YEAR(date)`,
      [staff_id, year]
    );
    const yearly = yearlyRows[0] || null;
    res.json({ monthly, yearly });
  } catch (error) {
    logger.error('Error fetching attendance summary:', error);
    res.status(500).json({ error: 'Server error fetching attendance summary' });
  }
});

module.exports = router;