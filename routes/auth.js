
const express = require('express');
const router = express.Router();
// Refresh token endpoint
router.post('/refresh-token', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(401).json({ error: 'Refresh token required' });
  try {
    const decoded = jwt.verify(refreshToken, process.env.JWT_SECRET || 'your_jwt_secret');
    if (!decoded.refresh) throw new Error('Invalid refresh token');
    // Issue new access token (24h)
    const accessToken = jwt.sign(
      { id: decoded.id, email: decoded.email, role: decoded.role, userType: decoded.userType },
      process.env.JWT_SECRET || 'your_jwt_secret',
      { expiresIn: '24h' }
    );
    res.json({ token: accessToken });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { pool } = require('../db');
const auth = require('../middleware/auth');
const { sendVerificationEmail, sendPasswordResetOTPEmail, sendPasswordResetSuccessEmail } = require('../services/emailService');
const { 
  createVerificationToken, 
  verifyToken, 
  isEmailVerified, 
  findUserByEmail, 
  createPasswordResetOTP, 
  verifyPasswordResetOTP 
} = require('../services/verificationService');
const logger = require('../utils/logger');

// Helper to generate 8-digit numeric password based on email and employee_id
function deriveNumericPassword(email, employeeId) {
  const base = `${(employeeId || '').toString()}|${(email || '').toLowerCase()}`;
  let hash = 2166136261; // FNV-1a offset basis
  for (let i = 0; i < base.length; i++) {
    hash ^= base.charCodeAt(i);
    hash = (hash >>> 0) * 16777619;
    hash >>>= 0;
  }
  const num = (hash % 100000000) >>> 0;
  return num.toString().padStart(8, '0');
}

// Helper function to get device name from user agent
function getUserDeviceName(userAgent = '') {
  if (!userAgent) return 'Unknown Device';
  
  // Extract device info from user agent
  let deviceName = 'Unknown Device';
  
  if (userAgent.includes('Windows')) {
    deviceName = 'Windows PC';
  } else if (userAgent.includes('Macintosh')) {
    deviceName = 'Mac/Apple';
  } else if (userAgent.includes('Linux')) {
    deviceName = 'Linux Device';
  } else if (userAgent.includes('Android')) {
    deviceName = 'Android Phone';
  } else if (userAgent.includes('iPhone') || userAgent.includes('iPad')) {
    deviceName = 'iPhone/iPad';
  }
  
  // Try to extract browser info
  if (userAgent.includes('Chrome')) {
    deviceName += ' (Chrome)';
  } else if (userAgent.includes('Firefox')) {
    deviceName += ' (Firefox)';
  } else if (userAgent.includes('Safari')) {
    deviceName += ' (Safari)';
  } else if (userAgent.includes('Edge')) {
    deviceName += ' (Edge)';
  }
  
  return deviceName;
}

// Helper function to get device type from user agent
function getDeviceType(userAgent = '') {
  if (userAgent.includes('Mobile') || userAgent.includes('Android') || userAgent.includes('iPhone') || userAgent.includes('iPad')) {
    return 'mobile';
  } else if (userAgent.includes('Tablet')) {
    return 'tablet';
  }
  return 'desktop';
}


// Staff logout: record logout time and working hours

router.post('/logout', auth, async (req, res) => {
  // Add JWT grace period for logout (accept expired tokens up to 25h)
  try {
    let user = req.user;
    const authHeader = req.headers.authorization;
    let token = null;
    
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.split(' ')[1];
    }
    
    if (!user) {
      // Try to decode expired token with ignoreExpiration
      if (authHeader && authHeader.startsWith('Bearer ')) {
        try {
          user = jwt.verify(token, process.env.JWT_SECRET || 'your_jwt_secret', { ignoreExpiration: true });
        } catch (e) {
          return res.status(401).json({ error: 'Invalid token' });
        }
      }
    }

    if (!user) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const userId = user.id;
    const userType = user.userType || 'user';

    // Clear active session from user_sessions table
    try {
      // Method 1: Clear by user_id, user_type and the specific token
      if (token) {
        const [result1] = await pool.execute(
          `UPDATE user_sessions 
           SET is_active = FALSE, logout_time = NOW() 
           WHERE user_id = ? AND user_type = ? AND session_token = ?`,
          [userId, userType, token]
        );
        
        if (result1.affectedRows > 0) {
          logger.info(`[SESSION] Session cleared by token for ${userType} ${userId}`);
        } else {
          // Fallback: Clear all active sessions for this user (in case token doesn't match)
          const [result2] = await pool.execute(
            `UPDATE user_sessions 
             SET is_active = FALSE, logout_time = NOW() 
             WHERE user_id = ? AND user_type = ? AND is_active = TRUE`,
            [userId, userType]
          );
          
          if (result2.affectedRows > 0) {
            logger.info(`[SESSION] Session cleared by user+type for ${userType} ${userId} (${result2.affectedRows} records)`);
          } else {
            logger.warn(`[SESSION] No active sessions found to clear for ${userType} ${userId}`);
          }
        }
      } else {
        // No token available, clear by user_id and user_type
        const [result] = await pool.execute(
          `UPDATE user_sessions 
           SET is_active = FALSE, logout_time = NOW() 
           WHERE user_id = ? AND user_type = ? AND is_active = TRUE`,
          [userId, userType]
        );
        
        if (result.affectedRows > 0) {
          logger.info(`[SESSION] Session cleared by user+type for ${userType} ${userId} (${result.affectedRows} records)`);
        }
      }
    } catch (sessionErr) {
      logger.error('Failed to clear session record:', sessionErr.message);
      // Continue with logout even if session clearing fails
    }

    // Handle staff attendance logging
    if (userType === 'staff') {
      // Check if token is expired for more than 25 hours
      const nowEpoch = Math.floor(Date.now() / 1000);
      if (user.exp && nowEpoch - user.exp > 60 * 60) {
        return res.status(401).json({ error: 'Token expired too long ago' });
      }
      
      const staffId = userId;
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');
      const dateStr = `${yyyy}-${mm}-${dd}`;
      
      // Store logout_time as MySQL DATETIME string in IST
      function toMySQLDateTimeIST(date) {
        // IST is UTC+5:30
        const offsetMs = 5.5 * 60 * 60 * 1000;
        const istDate = new Date(date.getTime() + offsetMs);
        return istDate.toISOString().slice(0, 19).replace('T', ' ');
      }
      
      const now = new Date();
      const logoutTimeIST = toMySQLDateTimeIST(now);
      logger.info(`[LOGOUT] Staff ${staffId} requested logout at ${now.toISOString()} for date ${dateStr}`);
      
      // Find the most recent attendance log with login_time set and logout_time NULL
      let [rows] = await pool.execute(
        'SELECT * FROM attendance_logs WHERE staff_id = ? AND login_time IS NOT NULL AND logout_time IS NULL ORDER BY date DESC, login_time DESC LIMIT 1',
        [staffId]
      );
      let log = rows[0];
      
      if (!log) {
        // If not found, fallback to today as before (for legacy cases)
        [rows] = await pool.execute(
          'SELECT * FROM attendance_logs WHERE staff_id = ? AND date = ?',
          [staffId, dateStr]
        );
        log = rows[0];
        if (!log) {
          // If still not found, create a new attendance log with login_time = null
          await pool.execute(
            'INSERT INTO attendance_logs (staff_id, date, login_time, logout_time, working_hours, status, created_at, updated_at) VALUES (?, ?, NULL, ?, ?, ?, NOW(), NOW())',
            [staffId, dateStr, logoutTimeIST, 0.0, 'present']
          );
          // Fetch the new log
          [rows] = await pool.execute(
            'SELECT * FROM attendance_logs WHERE staff_id = ? AND date = ?',
            [staffId, dateStr]
          );
          log = rows[0];
          logger.info(`[LOGOUT] Created new attendance log for staff ${staffId} on ${dateStr} during logout.`);
        }
      }
      
      // Always update logout_time and working_hours
      let workingHours = 0.0;
      let loginTimeStr = log.login_time ? new Date(log.login_time).toISOString() : null;
      if (log.login_time) {
        // Both login_time and logout_time are stored in IST, so direct subtraction is correct
        const loginTime = new Date(log.login_time);
        const logoutTime = new Date(logoutTimeIST.replace(' ', 'T'));
        workingHours = (logoutTime - loginTime) / (1000 * 60 * 60);
        if (workingHours < 0) workingHours = 0;
        if (workingHours > 24) workingHours = 24;
      }
      
      // Enforce 8-hour minimum for present status
      let status = log.status;
      if (workingHours < 8) {
        status = 'absent';
      } else {
        status = 'present';
      }
      
      await pool.execute(
        'UPDATE attendance_logs SET logout_time = ?, working_hours = ?, status = ?, updated_at = NOW() WHERE id = ?',
        [logoutTimeIST, workingHours.toFixed(2), status, log.id]
      );
      logger.info(`[LOGOUT] Updated attendance log for staff ${staffId} on ${dateStr}: login_time=${loginTimeStr}, logout_time=${logoutTimeIST}, working_hours=${workingHours.toFixed(2)}, status=${status}`);
      
      return res.json({ success: true, workingHours: workingHours.toFixed(2), status });
    }

    // For non-staff users, just return success after clearing session
    res.json({ success: true, message: 'Logged out successfully' });
  } catch (error) {
    logger.error(`[LOGOUT] Error during logout for user ${req.user?.id}:`, error.message);
    res.status(500).json({ error: 'Server error during logout' });
  }
});

router.post('/register', async (req, res) => {
  try {
    const { email, password, fullName, phone, address } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    
    // Check if user exists
    const [userCheck] = await pool.execute('SELECT * FROM users WHERE email = ?', [email]);
    if (userCheck.length > 0) {
      return res.status(400).json({ error: 'User with this email is already registered' });
    }
    
    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    
    // Create user with role and full_name, email_confirmed set to false
    const [result] = await pool.execute(
      'INSERT INTO users (email, password, full_name, role, email_confirmed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, NOW(), NOW())',
      [email, hashedPassword, fullName || email.split('@')[0], 'user', false]
    );
    
    // Get the created user ID
    const userId = result.insertId;
    
    // Get the created user details
    const [newUser] = await pool.execute('SELECT * FROM users WHERE id = ?', [userId]);
    
    // Insert into profiles table with phone number and address
    try {
      await pool.execute(
        'INSERT INTO profiles (id, phone_number, address, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
        [userId, phone || '', address || '']
      );
    } catch (profileError) {
      // Try to create profile with UPSERT to handle conflicts
      try {
        await pool.execute(
          'INSERT INTO profiles (id, phone_number, address, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW()) ON DUPLICATE KEY UPDATE phone_number = ?, address = ?, updated_at = NOW()',
          [userId, phone || '', address || '', phone || '', address || '']
        );
      } catch (secondProfileError) {
        // Continue with registration - profile creation failure shouldn't stop the process
        logger.dev('Profile creation failed:', secondProfileError.message);
      }
    }
    
    // Generate verification token and send verification email
    let verificationToken;
    let emailSent = false;
    let emailError = null;
    
    try {
      // Create verification token
      verificationToken = await createVerificationToken(userId);
      logger.dev('✅ Verification token created for user:', userId);
      
      // Send verification email
      const emailResult = await sendVerificationEmail(email, verificationToken, userId);
      emailSent = true;
      logger.dev('✅ Verification email sent successfully to:', email);
      
    } catch (error) {
      emailError = error;
      
      // Enhanced error logging for better debugging
      logger.error('❌ Failed to send verification email:', error.message);
      logger.dev('Email error details:', {
        code: error.code,
        command: error.command,
        response: error.response,
        email: email,
        userId: userId
      });
      
      // Log specific error types for troubleshooting
      if (error.message.includes('authentication')) {
        logger.error('🔐 Email authentication issue - check EMAIL_USER and EMAIL_PASSWORD');
      } else if (error.message.includes('connection')) {
        logger.error('🌐 Email connection issue - check EMAIL_HOST and EMAIL_PORT');
      } else if (error.message.includes('timeout')) {
        logger.error('⏰ Email timeout issue - server may be slow');
      }
    }
    
    // Verification token logging removed for security
    
    // Don't generate JWT until email is verified
    // Instead, just return the user info without a token
    
    // Send a clear success response
    res.status(201).json({
      success: true,
      user: {
        id: userId,
        email: newUser[0].email,
        role: newUser[0].role,
        full_name: newUser[0].full_name,
        email_confirmed: newUser[0].email_confirmed,
        created_at: newUser[0].created_at,
        phone_number: phone,
        address: address
      },
      needsVerification: true,
      message: "Please check your email and verify.",
      emailSent: emailSent,
      emailError: emailError ? emailError.message : null,
      // Additional helpful information
      // emailDeliveryInfo: {
      //   expectedDeliveryTime: '2-3 minutes',
      //   senderEmail: 'ceteam.web@gmail.com',
      //   senderName: 'Real Estate App',
      //   subjectLine: '🏡 Complete Your Real Estate App Registration',
      //   searchTerms: ['Complete Your Real Estate App Registration', 'ceteam.web@gmail.com', 'Real Estate App'],
      //   checkLocations: ['Primary inbox', 'Spam/Junk folder', 'Promotions tab (Gmail)', 'Updates tab (Gmail)'],
      //   troubleshootingSteps: [
      //     'Add ceteam.web@gmail.com to contacts',
      //     'Mark as "Not Spam" if found in spam',
      //     'Check email filters and rules',
      //     'Wait 5 minutes then use resend option',
      //     'Try test email delivery feature'
      //   ]
      // },
      // Include the token in development environment for testing
      ...(process.env.NODE_ENV === 'development' && { verificationToken })
    });
    
    
  } catch (error) {
    // Only log detailed error information in development
    logger.error('Registration process failed:', error.message);
    
    // Check specific error types
    if (error.message.includes('duplicate key value violates unique constraint')) {
      return res.status(400).json({ 
        error: 'A user with this email already exists',
        details: 'Please use a different email address or try logging in'
      });
    } else if (error.message.includes('foreign key constraint')) {
      return res.status(500).json({ 
        error: 'Database integrity error',
        details: 'Please contact support if this issue persists'
      });
    }
    
    res.status(500).json({ 
      error: 'Server error during registration',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Please try again later'
    });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    // Test database connection first
    let connection;
    try {
      connection = await pool.getConnection();
    } catch (dbError) {
      logger.error('Database connection failed during login:', dbError.message);
      return res.status(503).json({
        error: 'Database service temporarily unavailable',
        message: 'Please try again in a few moments'
      });
    }

    try {
      // First try users table (existing behavior)
      const [result] = await connection.execute(
        `SELECT u.id, u.email, u.password, u.full_name, u.role, u.email_confirmed, u.created_at,
                p.phone_number, p.address, p.avatar_url
         FROM users u
         LEFT JOIN profiles p ON u.id = p.id
         WHERE u.email = ?`,
        [email]
      );

      if (result.length > 0) {
        const user = result[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
          return res.status(401).json({ error: 'Please enter correct email and password.' });
        }

        if (!user.email_confirmed) {
          return res.status(403).json({
            error: 'Please verify your email and try again.',
            needsVerification: true,
            userId: user.id,
            email: email
          });
        }

        // Restrict multiple device logins for all users (including staff)
        const [activeSessions] = await connection.execute(
          'SELECT * FROM user_sessions WHERE user_id = ? AND user_type = ? AND is_active = TRUE',
          [user.id, 'user']
        );
        if (activeSessions.length > 0) {
          const activeSession = activeSessions[0];
          logger.warn(`[MULTILOGIN] User ${user.id} (${email}) attempted login while already logged in from device: ${activeSession.device_name || 'Unknown'}`);
          return res.status(409).json({
            error: 'please logout from recently login device then try to login in this device',
            code: 'ALREADY_LOGGED_IN',
            existingSession: {
              device_name: activeSession.device_name || 'Unknown Device',
              login_time: activeSession.login_time,
              ip_address: activeSession.ip_address
            }
          });
        }

        const token = jwt.sign(
          { id: user.id, email: user.email, role: user.role || 'user', userType: 'user' },
          process.env.JWT_SECRET || 'your_jwt_secret',
          { expiresIn: '7d' }
        );

        // Get IP address and user agent
        const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.connection.remoteAddress || 'Unknown';
        const userAgent = req.headers['user-agent'] || '';

        // Create session record
        const deviceUuid = 'dev_' + require('crypto').randomBytes(16).toString('hex');
        const deviceName = getUserDeviceName(userAgent);
        try {
          await connection.execute(
            `INSERT INTO user_sessions (user_id, user_type, session_token, device_uuid, device_name, device_type, ip_address, user_agent, is_active)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [user.id, 'user', token, deviceUuid, deviceName, getDeviceType(userAgent), clientIp, userAgent, true]
          );
          logger.info(`[LOGIN] New session created for user ${user.id} from device: ${deviceName}`);
        } catch (sessionErr) {
          logger.error('Failed to create session record:', sessionErr.message);
          // Continue with login even if session recording fails
        }

        return res.json({
          user: {
            id: user.id,
            email: user.email,
            role: user.role || 'user',
            full_name: user.full_name,
            email_confirmed: user.email_confirmed,
            created_at: user.created_at,
            phone_number: user.phone_number,
            address: user.address,
            avatar_url: user.avatar_url
          },
          token,
          refreshToken: token // Will be replaced with actual refresh token if available
        });
      }

      // If not found in users, try staff table
      const [srows] = await connection.execute('SELECT * FROM staff WHERE email = ?', [email]);
      if (srows.length === 0) {
        return res.status(401).json({ error: 'Please enter correct email and password.' });
      }

      const staff = srows[0];
      
      // Debug: Log password check details
      logger.dev('Staff login attempt:', {
        email: email,
        staffId: staff.id,
        hasPassword: !!staff.password,
        passwordLength: staff.password ? staff.password.length : 0,
        providedPassword: password,
        staffStatus: staff.status
      });
      
      // If password is not set in DB, attempt to validate against the deterministic
      // generated password (legacy behavior). If it matches, initialize the
      // hashed password in DB so future logins use bcrypt compare.
      if (!staff.password) {
        const derived = deriveNumericPassword(staff.email, staff.employee_id);
        if (password === derived) {
          try {
            const newHash = await bcrypt.hash(derived, 10);
            await connection.execute('UPDATE staff SET password = ? WHERE id = ?', [newHash, staff.id]);
            logger.info('Initialized password hash for legacy staff account:', staff.email);
            // update local staff.password so subsequent checks treat it as set
            staff.password = newHash;
          } catch (err) {
            logger.error('Failed to initialize staff password hash:', err.message);
            return res.status(500).json({ error: 'Server error during login' });
          }
        } else {
          logger.warn('Staff account not initialized and provided password did not match derived password:', email);
          return res.status(401).json({ error: 'Staff account has not been initialized. Please contact administration.' });
        }
      }

      const staffMatch = await bcrypt.compare(password, staff.password);
      if (!staffMatch) {
        logger.warn('Staff password mismatch for:', email);
        return res.status(401).json({ error: 'Please enter correct email and password.' });
      }


      // Optional: require staff to be active
      if (staff.status && staff.status !== 'active') {
        return res.status(403).json({ error: 'Staff account is not active' });
      }

      // Block login if staff is marked as off in Attendance & Availability (attendance_logs)
      try {
        const today = new Date();
        const yyyy = today.getFullYear();
        const mm = String(today.getMonth() + 1).padStart(2, '0');
        const dd = String(today.getDate()).padStart(2, '0');
        const dateStr = `${yyyy}-${mm}-${dd}`;

        // Check if today is a weekly holiday for this staff
        const [holidays] = await connection.execute(
          'SELECT * FROM staff_weekly_holidays WHERE staff_id = ? AND day_of_week = ? AND is_active = 0',
          [staff.id, today.toLocaleString('en-US', { weekday: 'long' })]
        );
        if (holidays.length > 0) {
          // Block login if today is a holiday for this staff
          return res.status(403).json({ error: 'Unable to login today, due to week-off' });
        }

        // Check if staff is marked as off in attendance_logs for today (status = 'holiday' or 'off')
        const [attendanceRows] = await connection.execute(
          "SELECT status FROM attendance_logs WHERE staff_id = ? AND date = ? LIMIT 1",
          [staff.id, dateStr]
        );
        if (attendanceRows.length > 0 && (attendanceRows[0].status === 'holiday' || attendanceRows[0].status === 'off')) {
          return res.status(403).json({ error: 'You are marked as off today and cannot login.' });
        }

        // Upsert attendance log for today
        // Store login_time as MySQL DATETIME string in IST
        function toMySQLDateTimeIST(date) {
          // IST is UTC+5:30
          const offsetMs = 5.5 * 60 * 60 * 1000;
          const istDate = new Date(date.getTime() + offsetMs);
          return istDate.toISOString().slice(0, 19).replace('T', ' ');
        }
        const loginTime = toMySQLDateTimeIST(new Date());
        await connection.execute(
          `INSERT INTO attendance_logs (staff_id, date, login_time, status)
           VALUES (?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE login_time = IFNULL(login_time, VALUES(login_time)), status = VALUES(status), updated_at = NOW()`,
          [staff.id, dateStr, loginTime, 'present']
        );
      } catch (err) {
        logger.error('Attendance log error (login):', err.message);
      }

      // Check for active sessions (prevent multiple device logins)
      // Restrict multiple device logins for staff
      const [activeStaffSessions] = await connection.execute(
        'SELECT * FROM user_sessions WHERE user_id = ? AND user_type = ? AND is_active = TRUE',
        [staff.id, 'staff']
      );
      if (activeStaffSessions.length > 0) {
        const activeSession = activeStaffSessions[0];
        logger.warn(`[MULTILOGIN] Staff ${staff.id} (${email}) attempted login while already logged in from device: ${activeSession.device_name || 'Unknown'}`);
        return res.status(409).json({
          error: 'please logout from recently login device then try to login in this device',
          code: 'ALREADY_LOGGED_IN',
          existingSession: {
            device_name: activeSession.device_name || 'Unknown Device',
            login_time: activeSession.login_time,
            ip_address: activeSession.ip_address
          }
        });
      }

      // Issue access token (24h) and refresh token (7d)
      const accessToken = jwt.sign(
        { id: staff.id, email: staff.email, role: staff.role || 'staff', userType: 'staff' },
        process.env.JWT_SECRET || 'your_jwt_secret',
        { expiresIn: '24h' }
      );
      const refreshToken = jwt.sign(
        { id: staff.id, email: staff.email, role: staff.role || 'staff', userType: 'staff', refresh: true },
        process.env.JWT_SECRET || 'your_jwt_secret',
        { expiresIn: '7d' }
      );

      // Get IP address and user agent
      const clientIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.connection.remoteAddress || 'Unknown';
      const userAgent = req.headers['user-agent'] || '';

      // Create session record
      const deviceUuid = 'dev_' + require('crypto').randomBytes(16).toString('hex');
      const deviceName = getUserDeviceName(userAgent);
      try {
        await connection.execute(
          `INSERT INTO user_sessions (user_id, user_type, session_token, device_uuid, device_name, device_type, ip_address, user_agent, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [staff.id, 'staff', accessToken, deviceUuid, deviceName, getDeviceType(userAgent), clientIp, userAgent, true]
        );
        logger.info(`[LOGIN] New session created for staff ${staff.id} from device: ${deviceName}`);
      } catch (sessionErr) {
        logger.error('Failed to create session record:', sessionErr.message);
        logger.error('Session creation values:', {
          user_id: staff.id,
          user_type: 'staff',
          session_token: accessToken,
          device_uuid: deviceUuid,
          device_name: deviceName,
          device_type: getDeviceType(userAgent),
          ip_address: clientIp,
          user_agent: userAgent,
          is_active: true
        });
        // Continue with login even if session recording fails
      }

      // Optionally store refreshToken in DB or httpOnly cookie for security
      return res.json({
        user: {
          id: staff.id,
          email: staff.email,
          role: staff.role || 'staff',
          full_name: staff.full_name,
          status: staff.status,
          department: staff.department,
          designation: staff.designation,
          phone: staff.phone,
          created_at: staff.created_at
        },
        token: accessToken,
        refreshToken
      });
    } finally {
      if (connection) connection.release();
    }

  } catch (error) {
    logger.error('Login error:', error.message);
    res.status(500).json({
      error: 'Server error during login',
      message: 'Please try again or contact support if the problem persists'
    });
  }
});

router.get('/me', auth, async (req, res) => {
  try {
    if (req.user && req.user.userType === 'staff') {
      // Explicitly select all required fields for frontend
      try {
        const [rows] = await pool.execute(
          `SELECT id, employee_id, email, full_name, phone, department, designation, status, created_at, updated_at
           FROM staff WHERE id = ?`,
          [req.user.id]
        );
        if (rows.length === 0) return res.status(404).json({ error: 'User not found' });
        return res.json({ success: true, user: rows[0] });
      } catch (sqlError) {
        logger.error('SQL error in /me (staff):', sqlError);
        return res.status(500).json({ error: 'Server error', details: sqlError.message });
      }
    }

    try {
      const [rows] = await pool.execute(
        `SELECT u.id, u.email, u.full_name, u.role, u.email_confirmed, u.created_at, 
                p.avatar_url, p.phone_number, p.address, p.bio
         FROM users u
         LEFT JOIN profiles p ON u.id = p.id
         WHERE u.id = ?`,
        [req.user.id]
      );

      if (rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      res.json({ success: true, user: rows[0] });
    } catch (sqlError) {
      logger.error('SQL error in /me (user):', sqlError);
      return res.status(500).json({ error: 'Server error', details: sqlError.message });
    }
  } catch (error) {
    logger.error('Get current user error:', error);
    res.status(500).json({ error: 'Server error', details: error.message });
  }
});

// Verify email
router.get('/verify-email', async (req, res) => {
  try {
    const { token, userId } = req.query;
    
    if (!token || !userId) {
      return res.status(400).json({ error: 'Token and userId are required' });
    }
    
    const isValid = await verifyToken(token, userId);
    
    if (isValid) {
      
      // Update the email_confirmed status in users table
      await pool.execute(
        'UPDATE users SET email_confirmed = TRUE WHERE id = ?',
        [userId]
      );
      
      // Get configuration values from environment
      const autoRedirect = process.env.VERIFICATION_AUTO_REDIRECT === 'true';
      const redirectDelay = parseInt(process.env.VERIFICATION_SUCCESS_DELAY) || 5000;
      const redirectUrl = process.env.VERIFICATION_REDIRECT_URL || process.env.FRONTEND_URL + '/login' || 'http://cewealthzen.com/login';
      
      // For API requests, return HTML with success message and optional redirect script
      const successHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Email Verified Successfully</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
              font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
              background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 20px;
            }
            .success-container { 
              background: white;
              max-width: 500px; 
              margin: 0 auto;
              padding: 40px 30px;
              border-radius: 16px;
              box-shadow: 0 20px 40px rgba(0,0,0,0.1);
              text-align: center;
              position: relative;
              overflow: hidden;
            }
            .success-container::before {
              content: '';
              position: absolute;
              top: 0;
              left: 0;
              right: 0;
              height: 4px;
              background: linear-gradient(90deg, #4CAF50, #45a049);
            }
            .success-icon { 
              font-size: 72px; 
              color: #4CAF50; 
              margin-bottom: 20px;
              animation: checkmark 0.6s ease-in-out;
            }
            .success-icon::before {
              content: '✓';
              display: inline-block;
              border: 3px solid #4CAF50;
              border-radius: 50%;
              width: 120px;
              height: 120px;
              line-height: 114px;
              background: #f8fff8;
            }
            h1 { 
              color: #333; 
              font-size: 28px;
              font-weight: 600;
              margin-bottom: 16px;
            }
            .subtitle {
              color: #666; 
              font-size: 18px;
              line-height: 1.6;
              margin-bottom: 24px;
            }
            .message {
              color: #888;
              font-size: 14px;
              margin-bottom: 30px;
              padding: 16px;
              background: #f8f9fa;
              border-radius: 8px;
              border-left: 4px solid #4CAF50;
            }
            .btn { 
              display: inline-block; 
              background: linear-gradient(135deg, #007AFF, #0056d3);
              color: white; 
              padding: 14px 28px; 
              text-decoration: none; 
              border-radius: 8px; 
              font-weight: 500;
              font-size: 16px;
              margin: 8px;
              transition: all 0.3s ease;
              box-shadow: 0 4px 12px rgba(0,122,255,0.3);
            }
            .btn:hover {
              transform: translateY(-2px);
              box-shadow: 0 6px 16px rgba(0,122,255,0.4);
            }
            .btn-secondary {
              background: linear-gradient(135deg, #6c757d, #5a6268);
              box-shadow: 0 4px 12px rgba(108,117,125,0.3);
            }
            .btn-secondary:hover {
              box-shadow: 0 6px 16px rgba(108,117,125,0.4);
            }
            .countdown {
              font-size: 14px;
              color: #666;
              margin-top: 20px;
              padding: 12px;
              background: #e3f2fd;
              border-radius: 6px;
              ${autoRedirect ? '' : 'display: none;'}
            }
            .manual-options {
              margin-top: 20px;
              ${autoRedirect ? 'display: none;' : ''}
            }
            @keyframes checkmark {
              0% { transform: scale(0); }
              50% { transform: scale(1.1); }
              100% { transform: scale(1); }
            }
            @media (max-width: 600px) {
              .success-container { padding: 30px 20px; }
              h1 { font-size: 24px; }
              .subtitle { font-size: 16px; }
            }
          </style>
        </head>
        <body>
          <div class="success-container">
            <div class="success-icon"></div>
            <h1>🎉 Email Verified Successfully!</h1>
            <p class="subtitle">Your email has been verified and your account is now active.</p>
            <div class="message">
              <strong>✅ Account Status:</strong> Fully activated<br>
              <strong>📧 Email:</strong> Verified and confirmed<br>
              <strong>🚀 Next Step:</strong> You can now access all features
            </div>
            
            ${autoRedirect ? `
              <div class="countdown">
                <span id="countdown-text">Redirecting automatically in <span id="countdown">${Math.ceil(redirectDelay/1000)}</span> seconds...</span>
              </div>
              <div style="margin-top: 16px;">
                <a href="${redirectUrl}" class="btn">Continue to App</a>
                <button onclick="cancelRedirect()" class="btn btn-secondary">Stay Here</button>
              </div>
            ` : `
              <div class="manual-options">
                <a href="${redirectUrl}" class="btn">Continue to App</a>
                <button onclick="window.close()" class="btn btn-secondary">Close Window</button>
              </div>
            `}
          </div>
          
          <script>
            let countdownActive = ${autoRedirect};
            let redirectTimeout;
            let countdownInterval;
            
            function startCountdown() {
              if (!countdownActive) return;
              
              let timeLeft = ${Math.ceil(redirectDelay/1000)};
              const countdownElement = document.getElementById('countdown');
              
              countdownInterval = setInterval(() => {
                timeLeft--;
                if (countdownElement) {
                  countdownElement.textContent = timeLeft;
                }
                
                if (timeLeft <= 0) {
                  clearInterval(countdownInterval);
                  window.location.href = '${redirectUrl}';
                }
              }, 1000);
              
              redirectTimeout = setTimeout(() => {
                if (countdownActive) {
                  window.location.href = '${redirectUrl}';
                }
              }, ${redirectDelay});
            }
            
            function cancelRedirect() {
              countdownActive = false;
              clearTimeout(redirectTimeout);
              clearInterval(countdownInterval);
              
              const countdownDiv = document.querySelector('.countdown');
              if (countdownDiv) {
                countdownDiv.innerHTML = '<span style="color: #4CAF50;">✅ Auto-redirect cancelled. You can stay on this page.</span>';
              }
              
              // Show manual options
              const manualOptions = document.querySelector('.manual-options');
              if (manualOptions) {
                manualOptions.style.display = 'block';
              }
            }
            
            // Start countdown if auto-redirect is enabled
            if (countdownActive) {
              startCountdown();
            }
            
            // Handle browser back/forward navigation
            window.addEventListener('popstate', function(event) {
              cancelRedirect();
            });
          </script>
        </body>
        </html>
      `;
      
      return res.send(successHtml);
    } else {
      // Only log minimal information in development environment
      if (process.env.NODE_ENV === 'development') {
        logger.dev('Email verification failed');
      }
      
      return res.status(400).json({ 
        error: 'Invalid or expired token', 
        message: 'The verification link is invalid or has expired. Please request a new one.' 
      });
    }
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Email verification error:', error);
    }
    res.status(500).json({ error: 'Server error during email verification' });
  }
});

// Mobile verification route - verifies email and redirects to mobile app
router.get('/verify-mobile', async (req, res) => {
  try {
    const { token, userId, email } = req.query;
    
    if (!token || !userId) {
      return res.status(400).json({ error: 'Token and userId are required' });
    }
    
    const isValid = await verifyToken(token, userId);
    
    if (isValid) {
      // Update the email_confirmed status in users table
      await pool.execute(
        'UPDATE users SET email_confirmed = TRUE WHERE id = ?',
        [userId]
      );
      
      // Get app scheme from environment
      const appScheme = process.env.APP_SCHEME || 'realestate://';
      const frontendUrl = process.env.FRONTEND_URL || 'https://cewealthzen.com';
      
      // Create mobile verification success page with app redirect
      const mobileSuccessHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Email Verified - Opening Mobile App</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
              font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
              background: linear-gradient(135deg, #34C759 0%, #30B955 100%);
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 20px;
            }
            .success-container { 
              background: white;
              max-width: 500px; 
              margin: 0 auto;
              padding: 40px 30px;
              border-radius: 16px;
              box-shadow: 0 20px 40px rgba(0,0,0,0.1);
              text-align: center;
              position: relative;
              overflow: hidden;
            }
            .success-container::before {
              content: '';
              position: absolute;
              top: 0;
              left: 0;
              right: 0;
              height: 4px;
              background: linear-gradient(90deg, #34C759, #30B955);
            }
            .success-icon { 
              font-size: 72px; 
              color: #34C759; 
              margin-bottom: 20px;
              animation: checkmark 0.6s ease-in-out;
            }
            .success-icon::before {
              content: '📱';
              display: inline-block;
              border: 3px solid #34C759;
              border-radius: 50%;
              width: 120px;
              height: 120px;
              line-height: 114px;
              background: #f8fff9;
            }
            h1 { 
              color: #1d1d1f; 
              font-size: 28px; 
              font-weight: 600; 
              margin-bottom: 12px; 
            }
            .subtitle { 
              color: #666; 
              font-size: 18px; 
              margin-bottom: 24px; 
              line-height: 1.4;
            }
            .message { 
              background: #f8fff9; 
              padding: 20px; 
              border-radius: 12px; 
              margin: 20px 0; 
              text-align: left;
              border-left: 4px solid #34C759;
            }
            .btn {
              display: inline-block;
              background: #34C759;
              color: white;
              padding: 14px 28px;
              text-decoration: none;
              border-radius: 8px;
              font-weight: 600;
              margin: 8px;
              transition: all 0.2s ease;
              border: none;
              cursor: pointer;
              font-size: 16px;
            }
            .btn:hover {
              background: #30B955;
              transform: translateY(-1px);
            }
            .btn-secondary {
              background: #f1f1f1;
              color: #333;
            }
            .btn-secondary:hover {
              background: #e1e1e1;
            }
            .countdown {
              font-size: 14px;
              color: #666;
              margin-top: 20px;
              padding: 12px;
              background: #e8f5e8;
              border-radius: 6px;
            }
            .app-options {
              margin-top: 20px;
              padding: 20px;
              background: #f8f9fa;
              border-radius: 8px;
            }
            .app-option {
              display: block;
              margin: 10px 0;
              padding: 12px;
              background: white;
              border: 1px solid #ddd;
              border-radius: 6px;
              text-decoration: none;
              color: #333;
              transition: all 0.2s ease;
            }
            .app-option:hover {
              border-color: #34C759;
              background: #f8fff9;
            }
            @keyframes checkmark {
              0% { transform: scale(0); }
              50% { transform: scale(1.1); }
              100% { transform: scale(1); }
            }
            @media (max-width: 600px) {
              .success-container { padding: 30px 20px; }
              h1 { font-size: 24px; }
              .subtitle { font-size: 16px; }
            }
          </style>
        </head>
        <body>
          <div class="success-container">
            <div class="success-icon"></div>
            <h1>🎉 Email Verified Successfully!</h1>
            <p class="subtitle">Your email has been verified. Opening the mobile app...</p>
            <div class="message">
              <strong>✅ Account Status:</strong> Fully activated<br>
              <strong>📧 Email:</strong> ${email || 'Verified and confirmed'}<br>
              <strong>📱 Next Step:</strong> Mobile app is opening automatically
            </div>
            
            <div class="countdown">
              <span id="countdown-text">Attempting to open mobile app in <span id="countdown">3</span> seconds...</span>
            </div>
            
            <div class="app-options">
              <h3 style="margin-bottom: 15px; color: #333;">If the app doesn't open automatically:</h3>
              <a href="${appScheme}login?verified=true" class="app-option">
                📱 <strong>Open Real Estate App</strong><br>
                <small style="color: #666;">Tap here if you have the app installed</small>
              </a>
              <a href="${frontendUrl}" class="app-option">
                🌐 <strong>Continue in Web Browser</strong><br>
                <small style="color: #666;">Access the web version instead</small>
              </a>
              <a href="https://play.google.com/store" class="app-option">
                📲 <strong>Download from Play Store</strong><br>
                <small style="color: #666;">Get the app if not installed</small>
              </a>
            </div>
            
            <div style="margin-top: 20px;">
              <button onclick="openApp()" class="btn">Try Opening App Again</button>
              <a href="${frontendUrl}" class="btn btn-secondary">Continue in Browser</a>
            </div>
          </div>
          
          <script>
            let countdownActive = true;
            let redirectTimeout;
            let countdownInterval;
            
            function openApp() {
              // Try to open the app
              window.location.href = '${appScheme}login?verified=true';
              
              // Fallback to web version after a short delay
              setTimeout(() => {
                if (countdownActive) {
                  document.getElementById('countdown-text').innerHTML = 
                    '<span style="color: #FF9500;">App not detected. You can continue in browser or download the app.</span>';
                }
              }, 2000);
            }
            
            function startCountdown() {
              let timeLeft = 3;
              const countdownElement = document.getElementById('countdown');
              
              countdownInterval = setInterval(() => {
                timeLeft--;
                if (countdownElement) {
                  countdownElement.textContent = timeLeft;
                }
                
                if (timeLeft <= 0) {
                  clearInterval(countdownInterval);
                  openApp();
                }
              }, 1000);
            }
            
            // Start countdown immediately
            startCountdown();
            
            // Handle browser back/forward navigation
            window.addEventListener('popstate', function(event) {
              countdownActive = false;
              clearTimeout(redirectTimeout);
              clearInterval(countdownInterval);
            });
            
            // Detect if user returns to page (app didn't open)
            let hidden = false;
            document.addEventListener('visibilitychange', function() {
              if (document.hidden) {
                hidden = true;
              } else if (hidden) {
                // User returned to page, app might not have opened
                setTimeout(() => {
                  if (countdownActive) {
                    document.getElementById('countdown-text').innerHTML = 
                      '<span style="color: #FF9500;">Having trouble opening the app? Try the options below.</span>';
                  }
                }, 1000);
              }
            });
          </script>
        </body>
        </html>
      `;
      
      return res.send(mobileSuccessHtml);
    } else {
      // Verification failed - show error page
      const errorHtml = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Verification Failed</title>
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
          <style>
            * { margin: 0; padding: 0; box-sizing: border-box; }
            body { 
              font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
              background: linear-gradient(135deg, #FF3B30 0%, #D70015 100%);
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 20px;
            }
            .error-container { 
              background: white;
              max-width: 500px; 
              margin: 0 auto;
              padding: 40px 30px;
              border-radius: 16px;
              box-shadow: 0 20px 40px rgba(0,0,0,0.1);
              text-align: center;
            }
            .error-icon { 
              font-size: 72px; 
              color: #FF3B30; 
              margin-bottom: 20px;
            }
            h1 { 
              color: #1d1d1f; 
              font-size: 28px; 
              font-weight: 600; 
              margin-bottom: 12px; 
            }
            .subtitle { 
              color: #666; 
              font-size: 18px; 
              margin-bottom: 24px; 
              line-height: 1.4;
            }
            .btn {
              display: inline-block;
              background: #007AFF;
              color: white;
              padding: 14px 28px;
              text-decoration: none;
              border-radius: 8px;
              font-weight: 600;
              margin: 8px;
              transition: all 0.2s ease;
            }
            .btn:hover {
              background: #0056D3;
              transform: translateY(-1px);
            }
          </style>
        </head>
        <body>
          <div class="error-container">
            <div class="error-icon">❌</div>
            <h1>Verification Failed</h1>
            <p class="subtitle">The verification link is invalid or has expired.</p>
            <div style="margin-top: 20px;">
              <a href="${process.env.FRONTEND_URL || 'https://cewealthzen.com'}" class="btn">Go to App</a>
            </div>
          </div>
        </body>
        </html>
      `;
      
      return res.status(400).send(errorHtml);
    }
  } catch (error) {
    logger.error('Mobile verification error:', error.message);
    
    const errorHtml = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Verification Error</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          body { font-family: Arial, sans-serif; text-align: center; padding: 50px; }
          .error { color: #FF3B30; font-size: 18px; }
        </style>
      </head>
      <body>
        <div class="error">
          <h1>❌ Verification Error</h1>
          <p>An error occurred during verification. Please try again or contact support.</p>
          <a href="${process.env.FRONTEND_URL || 'https://cewealthzen.com'}" 
             style="display: inline-block; margin-top: 20px; padding: 10px 20px; background: #007AFF; color: white; text-decoration: none; border-radius: 5px;">
            Go to App
          </a>
        </div>
      </body>
      </html>
    `;
    
    res.status(500).send(errorHtml);
  }
});

// Resend verification email
router.post('/resend-verification', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    // Find user by email
    const [userResult] = await pool.execute('SELECT id, email, email_confirmed FROM users WHERE email = ?', [email]);
    
    if (userResult.length === 0) {
      // Don't reveal that the user doesn't exist for security reasons
      return res.json({ 
        success: true, 
        message: 'If your email exists in our system, a verification email has been sent.' 
      });
    }
    
    const user = userResult[0];
    
    // Check if email is already verified
    if (user.email_confirmed) {
      return res.json({ 
        success: true, 
        message: 'Your email is already verified. You can log in now.' 
      });
    }
    
    // Generate a new verification token and send email
    let verificationToken;
    try {
      verificationToken = await createVerificationToken(user.id);
      await sendVerificationEmail(email, verificationToken, user.id);
      
      // Only log in development environment
      if (process.env.NODE_ENV === 'development') {
        logger.dev(`New verification email sent to ${email}`);
        // Log the verification token for testing purposes
        logger.dev('Verification token for testing:', verificationToken);
      }
    } catch (emailError) {
      logger.error('Error sending verification email:', emailError.message);
      
      // Return success even if email fails, but include a message
      return res.json({ 
        success: true, 
        message: 'Verification email request processed. If there are issues with email delivery, please contact support.',
        emailError: emailError.message,
        note: 'Email service may be temporarily unavailable, but your account is ready for verification.'
      });
    }
    
    res.json({ 
      success: true, 
      message: 'Verification email has been sent. Please check your inbox.',
      // Include the token in development environment for testing
      ...(process.env.NODE_ENV === 'development' && { token: verificationToken, userId: user.id })
    });
  } catch (error) {
    logger.error('Resend verification error:', error.message);
    
    // Provide more specific error handling
    if (error.message.includes('duplicate key') || error.message.includes('unique constraint')) {
      return res.status(400).json({ 
        error: 'Verification request already in progress',
        message: 'Please wait a moment before requesting another verification email.'
      });
    }
    
    res.status(500).json({ 
      error: 'Server error during resend verification',
      details: process.env.NODE_ENV === 'development' ? error.message : 'Internal server error',
      timestamp: new Date().toISOString()
    });
  }
});

// Change password
router.post('/change-password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Current password and new password are required' });
    }
    
    // Get user with password
    const [rows] = await pool.execute('SELECT * FROM users WHERE id = ?', [req.user.id]);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Check current password
    const isMatch = await bcrypt.compare(currentPassword, rows[0].password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }
    
    // Hash new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);
    
    // Update password
    await pool.execute(
      'UPDATE users SET password = ?, updated_at = NOW() WHERE id = ?',
      [hashedPassword, req.user.id]
    );
    
    res.json({ success: true, message: 'Password updated successfully' });
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Change password error:', error);
    }
    res.status(500).json({ error: 'Server error during password change' });
  }
});

// Initiate password reset (request OTP)
router.post('/forgot-password', async (req, res) => {
  try {
    const { email, newPassword } = req.body;
    
    if (!email || !newPassword) {
      return res.status(400).json({ 
        success: false,
        error: 'Email and new password are required' 
      });
    }
    
    // Check if user exists
    const user = await findUserByEmail(email);
    if (!user) {
      // For security reasons, don't reveal that the user doesn't exist
      return res.status(200).json({ 
        success: true, 
        message: 'If your email exists in our system, an OTP has been sent to reset your password.' 
      });
    }
    
    // Hash the new password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);
    
    // Generate OTP and store it with the hashed password
    const otp = await createPasswordResetOTP(user.id, hashedPassword);
    
    // Send OTP email with better error handling
    try {
      await sendPasswordResetOTPEmail(email, otp, user.id);
      logger.dev('✅ Password reset OTP email sent successfully to:', email);
    } catch (emailError) {
      logger.error('❌ Failed to send password reset OTP email:', emailError.message);
      
      // Still return success but with a note about email delivery
      return res.json({ 
        success: true, 
        message: 'OTP has been generated. If there are email delivery issues, please try again in a few minutes.',
        emailDeliveryWarning: true,
        // Include the OTP in development environment for testing
        ...(process.env.NODE_ENV === 'development' && { otp, emailError: emailError.message })
      });
    }
    
    res.json({ 
      success: true, 
      message: 'OTP has been sent to your email. Please check your inbox.',
      // Include the OTP in development environment for testing
      ...(process.env.NODE_ENV === 'development' && { otp })
    });
  } catch (error) {
    // Enhanced error logging
    logger.error('Forgot password error:', error.message);
    logger.dev('Forgot password error stack:', error.stack);
    
    res.status(500).json({ 
      success: false,
      error: 'Server error during password reset request',
      message: 'An error occurred while processing your request. Please try again.',
      ...(process.env.NODE_ENV === 'development' && { details: error.message })
    });
  }
});

// Verify OTP and complete password reset
router.post('/verify-reset-otp', async (req, res) => {
  try {
    const { email, otp } = req.body;
    
    logger.dev('OTP verification request received:', { email, otp: otp ? '***' : 'missing' });
    
    if (!email || !otp) {
      logger.dev('Missing email or OTP in request');
      return res.status(400).json({ error: 'Email and OTP are required' });
    }
    
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      logger.dev('Invalid email format:', email);
      return res.status(400).json({ error: 'Invalid email format' });
    }
    
    // Validate OTP format (should be 6 digits)
    const otpRegex = /^\d{6}$/;
    if (!otpRegex.test(otp)) {
      logger.dev('Invalid OTP format:', otp);
      return res.status(400).json({ error: 'OTP must be 6 digits' });
    }
    
    logger.dev('Starting OTP verification process...');
    
    // Verify the OTP
    const result = await verifyPasswordResetOTP(otp, email);
    
    logger.dev('OTP verification result:', { success: result.success, message: result.message });
    
    if (result.success) {
      logger.dev('OTP verification successful, proceeding with password reset...');
      
      // Send success email (non-blocking)
      sendPasswordResetSuccessEmail(email).catch(emailError => {
        logger.error('Failed to send success email:', emailError.message);
      });
      
      // Generate a JWT token for automatic login
      const token = jwt.sign(
        { id: result.userId, email },
        process.env.JWT_SECRET || 'your_jwt_secret',
        { expiresIn: '7d' }
      );
      
      // Get user details
      const [rows] = await pool.execute(
        `SELECT u.id, u.email, u.full_name, u.role, u.email_confirmed, u.created_at,
                p.phone_number, p.address, p.avatar_url
         FROM users u
         LEFT JOIN profiles p ON u.id = p.id
         WHERE u.id = ?`,
        [result.userId]
      );
      
      if (rows.length === 0) {
        logger.error('User not found after successful OTP verification:', result.userId);
        return res.status(404).json({ error: 'User not found' });
      }
      
      const user = rows[0];
      
      logger.dev('Password reset completed successfully for user:', user.email);
      
      res.json({
        success: true,
        message: 'Password has been reset successfully.',
        user: {
          id: user.id,
          email: user.email,
          role: user.role || 'user',
          full_name: user.full_name,
          email_confirmed: user.email_confirmed,
          created_at: user.created_at,
          phone_number: user.phone_number,
          address: user.address,
          avatar_url: user.avatar_url
        },
        token
      });
    } else {
      logger.dev('OTP verification failed:', result.message);
      res.status(400).json({ 
        success: false, 
        message: result.message || 'Invalid or expired OTP. Please try again.' 
      });
    }
  } catch (error) {
    logger.error('Verify reset OTP error:', error);
    logger.error('Error stack:', error.stack);
    res.status(500).json({ 
      error: 'Server error during OTP verification',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Debug endpoint to check OTP status (development/verbose logging only)
if (process.env.NODE_ENV === 'development' || process.env.VERBOSE_LOGGING === 'true') {
  router.post('/debug-otp', async (req, res) => {
    try {
      const { email } = req.body;
      
      if (!email) {
        return res.status(400).json({ error: 'Email is required' });
      }
      
      // Find user
      const [userRows] = await pool.execute(
        'SELECT id, email FROM users WHERE email = ?',
        [email]
      );
      
      if (userRows.length === 0) {
        return res.json({ error: 'User not found' });
      }
      
      const userId = userRows[0].id;
      
      // Get all OTPs for this user
      const [otpRows] = await pool.execute(
        `SELECT token, expires_at, created_at, 
                (expires_at > NOW()) as is_valid,
                TIMESTAMPDIFF(MINUTE, NOW(), expires_at) as minutes_remaining
         FROM password_reset_tokens 
         WHERE user_id = ? 
         ORDER BY created_at DESC`,
        [userId]
      );
      
      // Check temp password
      const [tempRows] = await pool.execute(
        'SELECT temp_password IS NOT NULL as has_temp_password FROM users WHERE id = ?',
        [userId]
      );
      
      res.json({
        user: { id: userId, email },
        otps: otpRows,
        hasTempPassword: tempRows[0]?.has_temp_password || false,
        currentTime: new Date().toISOString()
      });
      
    } catch (error) {
      logger.error('Debug OTP error:', error);
      res.status(500).json({ error: error.message });
    }
  });
}

// Test email service endpoint (development only)
if (process.env.NODE_ENV === 'development') {
  router.post('/test-email', async (req, res) => {
    try {
      const { email } = req.body;
      
      if (!email) {
        return res.status(400).json({ error: 'Email is required' });
      }
      
      // Test email sending
      const { sendEmail } = require('../services/emailService');
      
      const testEmailResult = await sendEmail({
        to: email,
        subject: 'Test Email from Real Estate App',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <h2 style="color: #007AFF;">🧪 Email Service Test</h2>
            <p>This is a test email to verify that the email service is working correctly.</p>
            <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
            <p><strong>Environment:</strong> ${process.env.NODE_ENV}</p>
            <p>If you received this email, the email service is configured properly! ✅</p>
          </div>
        `
      });
      
      res.json({
        success: true,
        message: 'Test email sent successfully',
        messageId: testEmailResult.messageId
      });
      
    } catch (error) {
      logger.error('Test email failed:', error.message);
      res.status(500).json({
        success: false,
        error: error.message,
        details: 'Email service test failed'
      });
    }
  });
}

// Diagnostic endpoint to test verification email template
router.post('/test-verification-email', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    // Create a test verification token
    const testToken = 'TEST-' + require('crypto').randomBytes(32).toString('hex');
    const testUserId = 999;
    
    // Send the verification email
    const result = await sendVerificationEmail(email, testToken, testUserId);
    
    res.json({
      success: true,
      message: 'Diagnostic verification email sent successfully',
      email: email,
      messageId: result.messageId,
      note: 'Check your email for the verification template. Look for version marker: [v2.0-optimized] or [v2.0-FALLBACK-INLINE]'
    });
    
  } catch (error) {
    logger.error('Diagnostic verification email failed:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      details: 'Failed to send diagnostic verification email'
    });
  }
});

module.exports = router;
