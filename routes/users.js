const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const auth = require('../middleware/auth');
const logger = require('../utils/logger');
const { sendCustomerCredentialsEmail } = require('../services/emailService');

// Function to generate unique agent code (e.g., AGT-XXXXXX) based on email and timestamp
const generateAgentCode = (email) => {
  const username = email.split('@')[0].toUpperCase().replace(/[^A-Z0-9]/g, '');
  const randomPart = Math.floor(100000 + Math.random() * 900000).toString();
  return `AGT-${username.substring(0, 3)}${randomPart}`;
};

// Function to generate unique agent number (e.g., 8-digit number)
const generateAgentNumber = () => {
  return Math.floor(10000000 + Math.random() * 90000000).toString();
};

// Function to generate unique 8-digit customer ID based on email
const generateCustomerId = (email) => {
  // Extract username part from email (before @)
  const username = email.split('@')[0].toLowerCase();
  // Clean username: remove special characters, keep only alphanumeric
  const cleanUsername = username.replace(/[^a-z0-9]/g, '');
  // Convert first few characters of username to numbers
  let emailPart = '';
  for (let i = 0; i < Math.min(cleanUsername.length, 4); i++) {
    const char = cleanUsername[i];
    if (char >= 'a' && char <= 'z') {
      // Convert letter to number (a=01, b=02, ..., z=26)
      const charCode = (char.charCodeAt(0) - 96).toString().padStart(2, '0');
      emailPart += charCode.slice(-1); // Take last digit only
    } else if (char >= '0' && char <= '9') {
      // Keep numbers as is
      emailPart += char;
    }
  }
  // Ensure we have at least 4 digits from email
  emailPart = emailPart.substring(0, 4).padStart(4, '0');
  // Generate 4-digit random number for uniqueness
  const randomPart = Math.floor(1000 + Math.random() * 9000).toString();
  // Combine to create 8-digit customer ID
  const customerId = emailPart + randomPart;
  return customerId;
};

// Generate deterministic 10-digit numeric password based on email and phone
const generateSubAdminPassword = (email = '', phone = '') => {
  const base = `${(email || '').toLowerCase()}|${(phone || '')}`;
  let hash = 2166136261;
  for (let i = 0; i < base.length; i++) {
    hash ^= base.charCodeAt(i);
    hash = (hash >>> 0) * 16777619;
    hash >>>= 0;
  }
  const num = (hash % 10000000000) >>> 0; // 0..9,999,999,999
  return num.toString().padStart(10, '0');
};

// Helper function to handle customer role change and send credentials email
const handleCustomerRoleChange = async (userId) => {
  try {
    // Get user details
    const [userDetails] = await pool.execute(
      'SELECT id, full_name, email, created_at, customer_id FROM users WHERE id = ?',
      [userId]
    );
    
    if (userDetails.length === 0) {
      throw new Error('User not found');
    }
    
    const user = userDetails[0];
    let customerId = user.customer_id;
    const customerPassword = 'Customer@123';
    let credentialsGenerated = false;
    
    // Generate customer_id and customer_password if not already exists
    if (!customerId) {
      customerId = generateCustomerId(user.email);
      
      // Update users table with customer_id and customer_password
      await pool.execute(
        'UPDATE users SET customer_id = ?, customer_password = ?, updated_at = NOW() WHERE id = ?',
        [customerId, customerPassword, userId]
      );
      
      credentialsGenerated = true;
      logger.dev('Generated customer credentials for role change:', { 
        userId: userId, 
        email: user.email, 
        customerId: customerId,
        customerPassword: customerPassword 
      });
    }
    
    // Check if customer record already exists
    const [existingCustomer] = await pool.execute(
      'SELECT id FROM customers WHERE user_id = ?',
      [userId]
    );
    
    if (existingCustomer.length === 0) {
      // Create customer record with current timestamp for proper analytics
      await pool.execute(
        'INSERT INTO customers (user_id, full_name, email, created_at) VALUES (?, ?, ?, NOW())',
        [user.id, user.full_name, user.email]
      );
      
      logger.dev('Created customer record for user role change:', { userId: userId, customerId: customerId });
    }
    
    // Send credentials email (always send when role changes to customer)
    let emailSent = false;
    let emailError = null;
    
    try {
      logger.info('📧 Sending customer credentials email for role change...');
      logger.dev('Email details for role change:', {
        to: user.email,
        customerId: customerId,
        customerPassword: customerPassword,
        fullName: user.full_name,
        userId: userId,
        credentialsGenerated: credentialsGenerated
      });
      
      await sendCustomerCredentialsEmail(user.email, customerId, customerPassword, user.full_name, userId);
      emailSent = true;
      logger.info('✅ Customer credentials email sent successfully for role change to:', user.email);
      
      // Log success for admin tracking
      logger.info('📊 User role changed to customer and credentials emailed:', {
        userId: userId,
        customerId: customerId,
        email: user.email,
        fullName: user.full_name,
        emailSent: true,
        credentialsGenerated: credentialsGenerated,
        timestamp: new Date().toISOString()
      });
      
    } catch (error) {
      emailError = error;
      logger.error('❌ Failed to send customer credentials email for role change:', error.message);
      logger.dev('Email error details for role change:', {
        code: error.code,
        command: error.command,
        response: error.response,
        email: user.email,
        customerId: customerId,
        fullName: user.full_name,
        userId: userId,
        timestamp: new Date().toISOString()
      });
      
      logger.warn('⚠️ User role changed to customer but email failed - manual notification may be needed');
    }
    
    return {
      customerId: customerId,
      customerPassword: customerPassword,
      emailSent: emailSent,
      emailError: emailError ? emailError.message : null,
      credentialsGenerated: credentialsGenerated
    };
    
  } catch (error) {
    logger.error('Error handling customer role change:', error);
    throw error;
  }
};

router.post('/', auth, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to create users' });
    }

    const {
      full_name,
      email,
      phone,
      role = 'user',
      status = 'active',
      is_verified = false,
      date_of_birth,
      gender,
      address,
      city,
      state,
      zip_code,
      occupation,
      company
    } = req.body;

    logger.info('Creating new user:', {
      full_name,
      email,
      role,
      status,
      is_verified,
      created_by: req.user.id
    });

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

    // Validate role (allow sub-admin)
    if (!['user', 'admin', 'sub-admin', 'agent', 'customer'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role. Must be one of: user, admin, sub-admin, agent, customer' });
    }

    // Check if email already exists
    const [existingUser] = await pool.execute(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );

    if (existingUser.length > 0) {
      return res.status(409).json({ error: 'Email already exists' });
    }

    // Generate password for new user (they can reset it later)
    const bcrypt = require('bcrypt');
    let defaultPassword = 'TempPass123!'; // Temporary password for non sub-admins
    let subAdminPlain = null;
    let agentPlain = null;
    let agentCode = null;
    let agentNumber = null;
    if (role === 'sub-admin') {
      // Generate deterministic 10-digit numeric password based on email & phone
      defaultPassword = generateSubAdminPassword(email, phone || '');
      subAdminPlain = defaultPassword;
    } else if (role === 'agent') {
      // Generate deterministic 10-digit numeric password for agent as well
      defaultPassword = generateSubAdminPassword(email, phone || '');
      agentPlain = defaultPassword;
      agentCode = generateAgentCode(email);
      agentNumber = generateAgentNumber();
    }
    const hashedPassword = await bcrypt.hash(defaultPassword, 10);

    // Start transaction
    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      // Insert into users table
      // Insert into users table; include sub_admin_password column when present
      // Use single variables for result and userId to avoid redeclaration errors
      let userId;
      let userResult;
      if (subAdminPlain) {
        const [result] = await connection.execute(
          `INSERT INTO users (
            email, password, full_name, role, email_confirmed, sub_admin_password, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [email, hashedPassword, full_name, role, is_verified ? 1 : 0, subAdminPlain]
        );
        userResult = result;
      } else if (agentPlain) {
        const [result] = await connection.execute(
          `INSERT INTO users (
            email, password, full_name, role, email_confirmed, agent_password, agent_code, agent_number, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
          [email, hashedPassword, full_name, role, is_verified ? 1 : 0, agentPlain, agentCode, agentNumber]
        );
        userResult = result;
      } else {
        const [result] = await connection.execute(
          `INSERT INTO users (
            email, password, full_name, role, email_confirmed, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
          [email, hashedPassword, full_name, role, is_verified ? 1 : 0]
        );
        userResult = result;
      }

      userId = userResult.insertId;

      // Insert into profiles table if additional data provided
      if (phone || address || date_of_birth || gender) {
        try {
          await connection.execute(
            `INSERT INTO profiles (
              id, phone_number, address, created_at, updated_at
            ) VALUES (?, ?, ?, NOW(), NOW())
            ON DUPLICATE KEY UPDATE
              phone_number = VALUES(phone_number),
              address = VALUES(address),
              updated_at = NOW()`,
            [
              userId,
              phone || null,
              address || null
            ]
          );
        } catch (profileErr) {
          // Log profile insertion errors but do not fail the entire user creation
          logger.error('Failed to insert/update profile for new user:', {
            userId,
            email,
            error: profileErr && profileErr.message ? profileErr.message : profileErr
          });
        }
      }

      // If role is customer, create customer record and send credentials
      let customerEmailInfo = null;
      if (role === 'customer') {
        try {
          customerEmailInfo = await handleCustomerRoleChange(userId);
          logger.info('✅ Customer setup completed for new user:', customerEmailInfo);
        } catch (error) {
          logger.error('❌ Error setting up customer for new user:', error);
          // Continue with user creation even if customer setup fails
        }
      }

      // Commit transaction
      await connection.commit();

      // Get the created user data
      const [newUser] = await pool.execute(
        `SELECT u.id, u.email, u.full_name, u.role, u.customer_id, u.customer_password, u.sub_admin_password,
                u.email_confirmed, u.created_at, u.updated_at,
                p.phone_number as phone, p.address
         FROM users u
         LEFT JOIN profiles p ON u.id = p.id
         WHERE u.id = ?`,
        [userId]
      );

      const response = {
        ...newUser[0],
        message: 'User created successfully',
        tempPassword: defaultPassword // Include temporary password in response
      };

      // Include customer email info if role was customer
      if (customerEmailInfo) {
        response.customerCredentials = {
          customerId: customerEmailInfo.customerId,
          emailSent: customerEmailInfo.emailSent,
          emailError: customerEmailInfo.emailError,
          credentialsGenerated: customerEmailInfo.credentialsGenerated
        };
      }

      logger.info('✅ User created successfully:', {
        id: userId,
        email: email,
        role: role,
        customerSetup: !!customerEmailInfo
      });

      res.status(201).json(response);

    } catch (error) {
      // Rollback transaction on error
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

  } catch (error) {
    logger.error('Error creating user:', error);
    logger.error('Error details:', {
      message: error.message,
      code: error.code,
      errno: error.errno,
      sqlState: error.sqlState,
      sqlMessage: error.sqlMessage,
      stack: error.stack
    });

    // Handle specific database errors
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Email already exists' });
    }

    if (error.code === 'ER_NO_REFERENCED_ROW_2') {
      return res.status(400).json({ error: 'Invalid reference data' });
    }

    // Always return at least the error message and code to help debugging
    const responsePayload = {
      error: 'Server error creating user',
      details: error.message || String(error),
      code: error.code || null
    };

    // Include SQL details if present
    if (error.sqlMessage) responsePayload.sqlMessage = error.sqlMessage;

    // In development include stack for deeper debugging
    if (process.env.NODE_ENV === 'development') {
      responsePayload.stack = error.stack;
    }

    return res.status(500).json(responsePayload);
  }
});

router.get('/', auth, async (req, res) => {
  try {
    // Allow access for admin or sales department
    if (req.user.role !== 'admin' && req.user.department !== 'sales') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const { limit, sort, order, page } = req.query;

    let query = `SELECT u.id, u.email, u.full_name, u.role, u.customer_id, u.customer_password, u.email_confirmed, u.created_at, u.updated_at
                 FROM users u
                 WHERE u.role != 'customer'`;

    // Add sorting
    const sortField = sort === 'created_at' ? 'u.created_at' : 'u.created_at';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
    query += ` ORDER BY ${sortField} ${sortOrder}`;

    // Add pagination
    if (limit) {
      const limitNum = parseInt(limit, 10) || 10;
      const pageNum = parseInt(page, 10) || 1;
      const offset = (pageNum - 1) * limitNum;
      query += ` LIMIT ${limitNum} OFFSET ${offset}`;
    }

    // Execute the main query
    const [rows] = await pool.execute(query);

    // Get total count for pagination
    const [countResult] = await pool.execute('SELECT COUNT(*) as total FROM users WHERE role != ?', ['customer']);
    const total = countResult[0].total;

    res.json({
      users: rows,
      total: total,
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || total
    });
  } catch (error) {
    logger.error('Error fetching users:', error);
    res.status(500).json({
      error: 'Server error fetching users',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

router.get('/profile', auth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT u.id, u.email, u.full_name, u.role, u.customer_id, u.customer_password, u.agent_code, u.agent_number, u.agent_password, u.created_at, u.updated_at, 
              p.avatar_url, p.phone_number, p.address, p.bio
       FROM users u
       LEFT JOIN profiles p ON u.id = p.id
       WHERE u.id = ?`,
      [req.user.id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Profile not found' });
    }
    
    res.json(rows[0]);
  } catch (error) {
    logger.error('Error fetching profile:', error);
    res.status(500).json({ error: 'Server error fetching profile' });
  }
});

router.put('/profile', auth, async (req, res) => {
  try {
    logger.dev('PUT /users/profile - Request received');
    logger.dev('PUT /users/profile - User from auth middleware:', req.user);
    logger.dev('PUT /users/profile - Request body:', req.body);
    
    const {
      full_name,
      phone_number,
      address,
      avatar_url,
      role,
      bio
    } = req.body;
    
    logger.dev('PUT /users/profile - User:', req.user.id, 'Data:', { full_name, phone_number, address, avatar_url, role, bio });
    logger.dev('PUT /users/profile - User role:', req.user.role);
    
    // Validate and sanitize input data
    const sanitizedData = {
      full_name: full_name || null,
      phone_number: phone_number || null,
      address: address || null,
      avatar_url: avatar_url || null,
      bio: bio || null,
      role: role || null
    };
    
    logger.dev('PUT /users/profile - Sanitized data:', sanitizedData);
    
    // Verify user exists
    const [userCheck] = await pool.execute('SELECT id, role FROM users WHERE id = ?', [req.user.id]);
    if (userCheck.length === 0) {
      logger.dev('PUT /users/profile - User not found in database');
      return res.status(404).json({ error: 'User not found' });
    }
    
    logger.dev('PUT /users/profile - User found in database:', userCheck[0]);
    
    // Only allow role updates for admins
    const allowRoleUpdate = req.user.role === 'admin' && sanitizedData.role !== null;
    
    logger.dev('PUT /users/profile - Allow role update:', allowRoleUpdate);
    
    if (allowRoleUpdate) {
      // Update user table with role (admin only)
      logger.dev('PUT /users/profile - Updating with role');
      await pool.execute(
        `UPDATE users SET
          full_name = ?,
          role = ?,
          updated_at = NOW()
        WHERE id = ?`,
        [
          sanitizedData.full_name,
          sanitizedData.role,
          req.user.id
        ]
      );
    } else {
      // Update user table without role (regular users)
      logger.dev('PUT /users/profile - Updating without role');
      await pool.execute(
        `UPDATE users SET
          full_name = ?,
          updated_at = NOW()
        WHERE id = ?`,
        [
          sanitizedData.full_name,
          req.user.id
        ]
      );
    }
    
    // Update or insert into profiles table for avatar_url, phone_number, address, and bio
    logger.dev('PUT /users/profile - Checking for existing profile');
    const [profileCheck] = await pool.execute('SELECT id FROM profiles WHERE id = ?', [req.user.id]);
    logger.dev('PUT /users/profile - Profile exists:', profileCheck.length > 0);
    
    if (profileCheck.length > 0) {
      // Update existing profile
      logger.dev('PUT /users/profile - Updating existing profile');
      await pool.execute(
        `UPDATE profiles SET
          avatar_url = ?,
          phone_number = ?,
          address = ?,
          bio = ?,
          updated_at = NOW()
        WHERE id = ?`,
        [sanitizedData.avatar_url, sanitizedData.phone_number, sanitizedData.address, sanitizedData.bio, req.user.id]
      );
    } else {
      // Insert new profile
      logger.dev('PUT /users/profile - Creating new profile');
      await pool.execute(
        `INSERT INTO profiles (id, avatar_url, phone_number, address, bio, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
        [req.user.id, sanitizedData.avatar_url, sanitizedData.phone_number, sanitizedData.address, sanitizedData.bio]
      );
    }
    
    // Get updated user data
    logger.dev('PUT /users/profile - Fetching updated user data');
    const [result] = await pool.execute(
      `SELECT u.id, u.email, u.full_name, u.role, u.customer_id, u.customer_password, u.created_at, u.updated_at, 
              p.avatar_url, p.phone_number, p.address, p.bio
       FROM users u
       LEFT JOIN profiles p ON u.id = p.id
       WHERE u.id = ?`,
      [req.user.id]
    );
    
    logger.dev('PUT /users/profile - Query result:', result);
    
    if (result.length === 0) {
      logger.dev('PUT /users/profile - User not found after update');
      return res.status(404).json({ error: 'User not found' });
    }
    
    logger.dev('PUT /users/profile - Sending response:', result[0]);
    res.json(result[0]);
  } catch (error) {
    logger.error('Error updating profile:', error);
    logger.error('Error details:', {
      message: error.message,
      code: error.code,
      sqlState: error.sqlState,
      sqlMessage: error.sqlMessage
    });
    
    // Handle specific database errors
    if (error.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ error: 'Duplicate entry error' });
    }
    
    if (error.code === 'ER_NO_REFERENCED_ROW_2') {
      return res.status(400).json({ error: 'Referenced row does not exist' });
    }
    
    res.status(500).json({ error: 'Server error updating profile' });
  }
});

router.get('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    
    if (req.user.role !== 'admin' && req.user.id !== id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const [rows] = await pool.execute(
      `SELECT u.id, u.email, u.full_name, u.role, u.customer_id, u.customer_password, u.sub_admin_password, u.agent_code, u.agent_number, u.agent_password, u.email_confirmed, u.created_at, u.updated_at,
              p.avatar_url, p.phone_number as phone, p.address, p.bio
       FROM users u
       LEFT JOIN profiles p ON u.id = p.id
       WHERE u.id = ?`,
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Debug logging
    console.log(`👤 Fetching user details for ID: ${id}`);
    console.log(`📋 User data:`, rows[0]);
    
    res.json({ user: rows[0] });
  } catch (error) {
    logger.error('Error fetching user:', error);
    res.status(500).json({ error: 'Server error fetching user' });
  }
});

// Update user information (admin only)
router.put('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { full_name, phone, role } = req.body;
    
    logger.dev('PUT /users/:id - Updating user:', { id, full_name, phone, role });
    
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    // Validate user ID
    if (!id || isNaN(parseInt(id))) {
      return res.status(400).json({ error: 'Valid user ID is required' });
    }
    
    // Validate role if provided
    if (role && !['user', 'admin', 'sub-admin', 'agent', 'customer'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    
    // Check if user exists
    const [userCheck] = await pool.execute('SELECT id FROM users WHERE id = ?', [id]);
    if (userCheck.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Update user information
    const [result] = await pool.execute(
      `UPDATE users SET 
        full_name = COALESCE(?, full_name),
        role = COALESCE(?, role),
        updated_at = NOW() 
      WHERE id = ?`,
      [full_name, role, id]
    );
    
    // Update phone in profiles table if provided
    if (phone !== undefined) {
      // Check if profile exists
      const [profileCheck] = await pool.execute('SELECT id FROM profiles WHERE id = ?', [id]);
      
      if (profileCheck.length > 0) {
        // Update existing profile
        await pool.execute(
          `UPDATE profiles SET phone_number = ?, updated_at = NOW() WHERE id = ?`,
          [phone, id]
        );
      } else {
        // Create new profile
        await pool.execute(
          `INSERT INTO profiles (id, phone_number, created_at, updated_at) VALUES (?, ?, NOW(), NOW())`,
          [id, phone]
        );
      }
    }
    
    // If role is changed to customer, create customer record, generate credentials, and send email
    let customerEmailInfo = null;
    if (role === 'customer') {
      try {
        customerEmailInfo = await handleCustomerRoleChange(id);
        logger.info('✅ Customer role change handled successfully for PUT /:id:', customerEmailInfo);
      } catch (error) {
        logger.error('❌ Error handling customer role change for PUT /:id:', error);
        // Continue with the response even if customer setup fails
      }
    }
    
    // Get updated user data
    const [updatedUser] = await pool.execute(
      `SELECT u.id, u.email, u.full_name, u.role, u.customer_id, u.customer_password, u.created_at, u.updated_at,
              p.phone_number, p.address, p.bio, p.avatar_url
       FROM users u
       LEFT JOIN profiles p ON u.id = p.id
       WHERE u.id = ?`,
      [id]
    );
    
    // Include customer email info in response if role was changed to customer
    const response = {
      ...updatedUser[0]
    };
    
    if (customerEmailInfo) {
      response.customerCredentials = {
        customerId: customerEmailInfo.customerId,
        emailSent: customerEmailInfo.emailSent,
        emailError: customerEmailInfo.emailError,
        credentialsGenerated: customerEmailInfo.credentialsGenerated
      };
    }
    
    res.json(response);
  } catch (error) {
    logger.error('Error updating user:', error);
    res.status(500).json({ error: 'Server error updating user' });
  }
});

router.put('/:id/role', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { role } = req.body;
    
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    // Validate user ID
    if (!id || isNaN(parseInt(id))) {
      return res.status(400).json({ error: 'Valid user ID is required' });
    }
    
    if (!role || !['user', 'admin', 'sub-admin', 'agent', 'customer'].includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }
    
    // Update role in users table (not profiles table)
    const [result] = await pool.execute(
      `UPDATE users SET role = ?, updated_at = NOW() WHERE id = ?`,
      [role, id]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // If role is changed to customer, create customer record, generate credentials, and send email
    let customerEmailInfo = null;
    if (role === 'customer') {
      try {
        customerEmailInfo = await handleCustomerRoleChange(id);
        logger.info('✅ Customer role change handled successfully for PUT /:id/role:', customerEmailInfo);
      } catch (error) {
        logger.error('❌ Error handling customer role change for PUT /:id/role:', error);
        // Continue with the response even if customer setup fails
      }
    }
    
    // Include customer email info in response if role was changed to customer
    const response = { id, role };
    if (customerEmailInfo) {
      response.customerCredentials = {
        customerId: customerEmailInfo.customerId,
        emailSent: customerEmailInfo.emailSent,
        emailError: customerEmailInfo.emailError,
        credentialsGenerated: customerEmailInfo.credentialsGenerated
      };
    }
    
    res.json(response);
  } catch (error) {
    logger.error('Error updating user role:', error);
    res.status(500).json({ error: 'Server error updating user role' });
  }
});

// Delete user (admin only)
router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    
    logger.dev('DELETE /users/:id - Deleting user:', { id });
    
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    // Validate user ID
    if (!id || isNaN(parseInt(id))) {
      return res.status(400).json({ error: 'Valid user ID is required' });
    }
    
    // Prevent admin from deleting themselves
    if (parseInt(id) === req.user.id) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    
    // Check if user exists
    const [userCheck] = await pool.execute('SELECT id, role, email FROM users WHERE id = ?', [id]);
    if (userCheck.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const userToDelete = userCheck[0];
    logger.dev('DELETE /users/:id - User to delete:', userToDelete);
    
    // Start transaction for safe deletion
    const connection = await pool.getConnection();
    await connection.beginTransaction();
    
    try {
      // Delete related records first (to maintain referential integrity)
      // Use try-catch for each table in case some don't exist
      
      // Delete from profiles table
      try {
        await connection.execute('DELETE FROM profiles WHERE id = ?', [id]);
        logger.dev('DELETE /users/:id - Deleted profile for user:', id);
      } catch (profileError) {
        logger.dev('DELETE /users/:id - No profile to delete or error:', profileError.message);
      }
      
      // Delete from customers table if exists
      try {
        await connection.execute('DELETE FROM customers WHERE user_id = ?', [id]);
        logger.dev('DELETE /users/:id - Deleted customer record for user:', id);
      } catch (customerError) {
        logger.dev('DELETE /users/:id - No customer record to delete or error:', customerError.message);
      }
      
      // Delete from favorites table
      try {
        await connection.execute('DELETE FROM favorites WHERE user_id = ?', [id]);
        logger.dev('DELETE /users/:id - Deleted favorites for user:', id);
      } catch (favoritesError) {
        logger.dev('DELETE /users/:id - No favorites to delete or error:', favoritesError.message);
      }
      
      // Delete from enquiries table
      try {
        await connection.execute('DELETE FROM enquiries WHERE user_id = ?', [id]);
        logger.dev('DELETE /users/:id - Deleted enquiries for user:', id);
      } catch (enquiriesError) {
        logger.dev('DELETE /users/:id - No enquiries to delete or error:', enquiriesError.message);
      }
      
      // Finally, delete the user
      const [deleteResult] = await connection.execute('DELETE FROM users WHERE id = ?', [id]);
      
      if (deleteResult.affectedRows === 0) {
        throw new Error('User deletion failed - no rows affected');
      }
      
      // Commit transaction
      await connection.commit();
      logger.dev('DELETE /users/:id - Successfully deleted user:', { id, email: userToDelete.email });
      
      res.json({ 
        message: 'User deleted successfully',
        deletedUser: {
          id: parseInt(id),
          email: userToDelete.email,
          role: userToDelete.role
        }
      });
      
    } catch (error) {
      // Rollback transaction on error
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    
  } catch (error) {
    logger.error('Error deleting user:', error);
    logger.error('Error details:', {
      message: error.message,
      code: error.code,
      sqlState: error.sqlState,
      sqlMessage: error.sqlMessage,
      stack: error.stack
    });
    
    // Handle specific database errors
    if (error.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(400).json({ 
        error: 'Cannot delete user - user has associated records that cannot be removed' 
      });
    }
    
    if (error.code === 'ER_NO_SUCH_TABLE') {
      logger.error('Table does not exist:', error.sqlMessage);
      return res.status(500).json({ 
        error: 'Database table error',
        details: process.env.NODE_ENV === 'development' ? `Table error: ${error.sqlMessage}` : undefined
      });
    }
    
    res.status(500).json({ 
      error: 'Server error deleting user',
      details: process.env.NODE_ENV === 'development' ? {
        message: error.message,
        code: error.code,
        sqlMessage: error.sqlMessage
      } : undefined
    });
  }
});

// Bulk delete users (admin only)
router.delete('/bulk', auth, async (req, res) => {
  try {
    const { ids } = req.body;
    
    logger.dev('DELETE /users/bulk - Bulk deleting users:', { ids });
    
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    // Validate input
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Valid array of user IDs is required' });
    }
    
    // Validate all IDs are numbers
    const validIds = ids.filter(id => !isNaN(parseInt(id))).map(id => parseInt(id));
    if (validIds.length === 0) {
      return res.status(400).json({ error: 'No valid user IDs provided' });
    }
    
    // Prevent admin from deleting themselves
    if (validIds.includes(req.user.id)) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    
    // Check which users exist
    const placeholders = validIds.map(() => '?').join(',');
    const [existingUsers] = await pool.execute(
      `SELECT id, email, role FROM users WHERE id IN (${placeholders})`,
      validIds
    );
    
    if (existingUsers.length === 0) {
      return res.status(404).json({ error: 'No users found with provided IDs' });
    }
    
    const existingIds = existingUsers.map(user => user.id);
    logger.dev('DELETE /users/bulk - Users to delete:', existingUsers);
    
    // Start transaction for safe bulk deletion
    const connection = await pool.getConnection();
    await connection.beginTransaction();
    
    try {
      const deletedUsers = [];
      const failedDeletions = [];
      
      for (const userId of existingIds) {
        try {
          // Delete related records first (to maintain referential integrity)
          // Use try-catch for each table in case some don't exist
          
          // Delete from profiles table
          try {
            await connection.execute('DELETE FROM profiles WHERE id = ?', [userId]);
          } catch (profileError) {
            logger.dev(`DELETE /users/bulk - No profile to delete for user ${userId}:`, profileError.message);
          }
          
          // Delete from customers table if exists
          try {
            await connection.execute('DELETE FROM customers WHERE user_id = ?', [userId]);
          } catch (customerError) {
            logger.dev(`DELETE /users/bulk - No customer record to delete for user ${userId}:`, customerError.message);
          }
          
          // Delete from favorites table
          try {
            await connection.execute('DELETE FROM favorites WHERE user_id = ?', [userId]);
          } catch (favoritesError) {
            logger.dev(`DELETE /users/bulk - No favorites to delete for user ${userId}:`, favoritesError.message);
          }
          
          // Delete from enquiries table
          try {
            await connection.execute('DELETE FROM enquiries WHERE user_id = ?', [userId]);
          } catch (enquiriesError) {
            logger.dev(`DELETE /users/bulk - No enquiries to delete for user ${userId}:`, enquiriesError.message);
          }
          
          // Finally, delete the user
          const [deleteResult] = await connection.execute('DELETE FROM users WHERE id = ?', [userId]);
          
          if (deleteResult.affectedRows > 0) {
            const userInfo = existingUsers.find(u => u.id === userId);
            deletedUsers.push({
              id: userId,
              email: userInfo.email,
              role: userInfo.role
            });
            logger.dev('DELETE /users/bulk - Successfully deleted user:', userId);
          } else {
            failedDeletions.push({ id: userId, reason: 'No rows affected' });
          }
          
        } catch (error) {
          logger.error(`DELETE /users/bulk - Failed to delete user ${userId}:`, error);
          failedDeletions.push({ 
            id: userId, 
            reason: error.message || 'Unknown error' 
          });
        }
      }
      
      // Commit transaction
      await connection.commit();
      
      const response = {
        message: `Bulk deletion completed`,
        summary: {
          requested: validIds.length,
          successful: deletedUsers.length,
          failed: failedDeletions.length
        },
        deletedUsers,
        failedDeletions: failedDeletions.length > 0 ? failedDeletions : undefined
      };
      
      logger.dev('DELETE /users/bulk - Bulk deletion completed:', response.summary);
      
      // Return appropriate status code
      if (deletedUsers.length === 0) {
        return res.status(400).json({
          ...response,
          message: 'No users were deleted'
        });
      } else if (failedDeletions.length > 0) {
        return res.status(207).json({
          ...response,
          message: 'Bulk deletion partially completed'
        });
      } else {
        return res.status(200).json(response);
      }
      
    } catch (error) {
      // Rollback transaction on error
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    
  } catch (error) {
    logger.error('Error in bulk delete users:', error);
    
    res.status(500).json({ 
      error: 'Server error during bulk deletion',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;