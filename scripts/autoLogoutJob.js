// Scheduled job to auto-logout employees after 12 hours
const { pool } = require('../db');
const logger = require('../utils/logger');

async function autoLogoutEmployees() {
  try {
    // Find all attendance logs where login_time is set, logout_time is NULL, and login_time is older than 12 hours
    const [rows] = await pool.execute(
      `SELECT * FROM attendance_logs WHERE login_time IS NOT NULL AND logout_time IS NULL AND TIMESTAMPDIFF(HOUR, login_time, NOW()) >= 12`
    );
    for (const log of rows) {
      const staffId = log.staff_id;
      const loginTime = new Date(log.login_time);
      // Set logout_time to login_time + 12 hours
      const logoutTime = new Date(loginTime.getTime() + 12 * 60 * 60 * 1000);
      // IST offset
      const offsetMs = 5.5 * 60 * 60 * 1000;
      const logoutTimeIST = new Date(logoutTime.getTime() + offsetMs)
        .toISOString().slice(0, 19).replace('T', ' ');
      const workingHours = 12.0;
      // Mark status as present
      await pool.execute(
        'UPDATE attendance_logs SET logout_time = ?, working_hours = ?, status = ?, updated_at = NOW() WHERE id = ?',
        [logoutTimeIST, workingHours.toFixed(2), 'present', log.id]
      );
      logger.info(`[AUTO-LOGOUT] Staff ${staffId} auto-logged out after 12 hours. Attendance marked present.`);
    }
    logger.info(`[AUTO-LOGOUT] Job completed. ${rows.length} employees auto-logged out.`);
  } catch (error) {
    logger.error('[AUTO-LOGOUT] Error during auto-logout job:', error.message);
  }
}

// Run the job every hour
if (require.main === module) {
  autoLogoutEmployees();
}

module.exports = autoLogoutEmployees;
