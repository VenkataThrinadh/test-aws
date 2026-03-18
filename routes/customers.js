const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const auth = require('../middleware/auth');
const logger = require('../utils/logger');
const bcrypt = require('bcrypt');
const { sendCustomerCredentialsEmail } = require('../services/emailService');

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

// Sync users with customer role to customers table
const syncCustomerUsers = async () => {
  try {
    // Get all users with customer role that don't have a customer record
    const [customerUsers] = await pool.execute(`
      SELECT u.id, u.full_name, u.email, u.created_at,
             p.phone_number, p.address,
             CASE 
               WHEN p.address IS NOT NULL AND p.address != '' THEN 
                 CASE
                   WHEN p.address LIKE '%,%' THEN TRIM(SUBSTRING_INDEX(p.address, ',', -1))
                   WHEN p.address LIKE '% %' THEN TRIM(SUBSTRING_INDEX(p.address, ' ', -1))
                   ELSE TRIM(p.address)
                 END
               ELSE NULL 
             END as extracted_city
      FROM users u 
      LEFT JOIN customers c ON u.id = c.user_id 
      LEFT JOIN profiles p ON u.id = p.id
      WHERE u.role = 'customer' AND c.id IS NULL
    `);
    
    // Create customer records for these users
    for (const user of customerUsers) {
      await pool.execute(`
        INSERT INTO customers (user_id, full_name, email, phone, address, city, created_at) 
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, [user.id, user.full_name, user.email, user.phone_number, user.address, user.extracted_city, user.created_at]);
    }
    
    console.log(`Synced ${customerUsers.length} customer users`);
    
    // Update existing customer records with missing phone/address/city data from profiles
    const [existingCustomers] = await pool.execute(`
      SELECT c.id, c.user_id, c.phone, c.address, c.city,
             p.phone_number, p.address as profile_address,
             CASE 
               WHEN p.address IS NOT NULL AND p.address != '' THEN 
                 CASE
                   WHEN p.address LIKE '%,%' THEN TRIM(SUBSTRING_INDEX(p.address, ',', -1))
                   WHEN p.address LIKE '% %' THEN TRIM(SUBSTRING_INDEX(p.address, ' ', -1))
                   ELSE TRIM(p.address)
                 END
               ELSE NULL 
             END as extracted_city
      FROM customers c
      LEFT JOIN users u ON c.user_id = u.id
      LEFT JOIN profiles p ON u.id = p.id
      WHERE u.role = 'customer' 
        AND (c.phone IS NULL OR c.phone = '' OR c.address IS NULL OR c.address = '' OR c.city IS NULL OR c.city = '')
        AND (p.phone_number IS NOT NULL OR p.address IS NOT NULL)
    `);
    
    // Update customer records with profile data
    for (const customer of existingCustomers) {
      const updateFields = [];
      const updateValues = [];
      
      if (customer.phone_number && (!customer.phone || customer.phone === '')) {
        updateFields.push('phone = ?');
        updateValues.push(customer.phone_number);
      }
      
      if (customer.profile_address && (!customer.address || customer.address === '')) {
        updateFields.push('address = ?');
        updateValues.push(customer.profile_address);
      }
      
      if (customer.extracted_city && (!customer.city || customer.city === '')) {
        updateFields.push('city = ?');
        updateValues.push(customer.extracted_city);
      }
      
      if (updateFields.length > 0) {
        updateFields.push('updated_at = NOW()');
        updateValues.push(customer.id);
        
        await pool.execute(
          `UPDATE customers SET ${updateFields.join(', ')} WHERE id = ?`,
          updateValues
        );
      }
    }
    
    if (existingCustomers.length > 0) {
      console.log(`Updated ${existingCustomers.length} existing customer records with profile data`);
    }
  } catch (error) {
    console.error('Error syncing customer users:', error);
  }
};

// Get all customers (admin only)
router.get('/', auth, async (req, res) => {
  try {
    console.log('Customers route accessed by user:', req.user);
    
    // Allow admin and staff to list customers. Other roles are denied.
    if (req.user.role !== 'admin' && req.user.role !== 'staff') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    // Sync customer users first
    await syncCustomerUsers();
    
    const { limit, sort, order, page, search, status, source, priority, filterDate, filterMonth, filterYear } = req.query;
    
    let query = `SELECT c.*,
                         u.email as user_email,
                         u.email_confirmed,
                         u.created_at as user_created_at,
                         u.role as user_role,
                         u.customer_id,
                         u.customer_password,
                         p.phone_number as profile_phone,
                         p.address as profile_address,
                         COALESCE(c.phone, p.phone_number) as phone,
                         COALESCE(c.address, p.address) as address,
                         COALESCE(c.city,
                           CASE
                             WHEN p.address IS NOT NULL AND p.address != '' THEN
                               CASE
                                 WHEN p.address LIKE '%,%' THEN TRIM(SUBSTRING_INDEX(p.address, ',', -1))
                                 WHEN p.address LIKE '% %' THEN TRIM(SUBSTRING_INDEX(p.address, ' ', -1))
                                 ELSE TRIM(p.address)
                               END
                             ELSE NULL
                           END
                         ) as city,
                         c.assigned_staff_name,
                         c.assigned_staff_email,
                         c.assigned_staff_phone,
                         c.assigned_staff_department,
                         c.assigned_staff_designation,
                         0 as total_enquiries,
                         0 as total_favorites,
                         NULL as last_enquiry_date
                  FROM customers c
                  LEFT JOIN users u ON c.user_id = u.id
                  LEFT JOIN profiles p ON u.id = p.id
                  WHERE 1=1`;
    let params = [];
    
    // Add search filter
    if (search) {
      query += ` AND (c.full_name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR p.phone_number LIKE ? OR u.customer_id LIKE ?)`;
      const searchTerm = `%${search}%`;
      params.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
    }
    
    // Add status filter
    if (status) {
      query += ` AND c.status = ?`;
      params.push(status);
    }
    
    // Add source filter
    if (source) {
      query += ` AND c.source = ?`;
      params.push(source);
    }
    
    // Add customer type filter
    if (priority) {
      query += ` AND c.customer_type = ?`;
      params.push(priority);
    }
    
    // Add date filter - filter customers created on the specific date
    if (filterDate) {
      query += ` AND DATE(c.created_at) = ?`;
      params.push(filterDate);
    }
    
    // Add month filter - filter customers by month and year (if both provided)
    if (filterMonth && filterYear) {
      query += ` AND MONTH(c.created_at) = ? AND YEAR(c.created_at) = ?`;
      params.push(filterMonth, filterYear);
    } else if (filterMonth) {
      // If only month is provided, filter by month across all years
      query += ` AND MONTH(c.created_at) = ?`;
      params.push(filterMonth);
    }
    
    // Add year filter - filter customers by year only (if month not provided)
    if (filterYear && !filterMonth) {
      query += ` AND YEAR(c.created_at) = ?`;
      params.push(filterYear);
    }
    
    // Add sorting
    const validSortFields = ['full_name', 'email', 'created_at', 'status', 'customer_type', 'total_enquiries'];
    const sortField = validSortFields.includes(sort) ? sort : 'created_at';
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
    console.log('Executing query:', query);
    console.log('With params:', params);
    const [rows] = await pool.execute(query, params);
    
    // Get total count for pagination
    let countQuery = `SELECT COUNT(c.id) as total FROM customers c 
                      LEFT JOIN users u ON c.user_id = u.id 
                      LEFT JOIN profiles p ON u.id = p.id 
                      WHERE 1=1`;
    let countParams = [];
    
    if (search) {
      countQuery += ` AND (c.full_name LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR p.phone_number LIKE ? OR u.customer_id LIKE ?)`;
      const searchTerm = `%${search}%`;
      countParams.push(searchTerm, searchTerm, searchTerm, searchTerm, searchTerm);
    }
    
    if (status) {
      countQuery += ` AND c.status = ?`;
      countParams.push(status);
    }
    
    if (source) {
      countQuery += ` AND c.source = ?`;
      countParams.push(source);
    }
    
    if (priority) {
      countQuery += ` AND c.customer_type = ?`;
      countParams.push(priority);
    }
    
    // Add date filter to count query
    if (filterDate) {
      countQuery += ` AND DATE(c.created_at) = ?`;
      countParams.push(filterDate);
    }
    
    // Add month filter to count query
    if (filterMonth && filterYear) {
      countQuery += ` AND MONTH(c.created_at) = ? AND YEAR(c.created_at) = ?`;
      countParams.push(filterMonth, filterYear);
    } else if (filterMonth) {
      countQuery += ` AND MONTH(c.created_at) = ?`;
      countParams.push(filterMonth);
    }
    
    // Add year filter to count query
    if (filterYear && !filterMonth) {
      countQuery += ` AND YEAR(c.created_at) = ?`;
      countParams.push(filterYear);
    }
    
    const [countResult] = await pool.execute(countQuery, countParams);
    const total = countResult[0].total;
    
    res.json({
      customers: rows,
      total: total,
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || total
    });
  } catch (error) {
    console.error('Error fetching customers:', error);
    logger.error('Error fetching customers:', error);
    res.status(500).json({ 
      error: 'Server error fetching customers',
      details: error.message 
    });
  }
});

// Get customer by ID
router.get('/:id', auth, async (req, res) => {
  try {
    // Allow admin and staff to fetch customer details
    if (req.user.role !== 'admin' && req.user.role !== 'staff') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { id } = req.params;
    
    const [rows] = await pool.execute(
      `SELECT c.*,
               u.email as user_email,
               u.email_confirmed,
               u.created_at as user_created_at,
               u.role as user_role,
               u.customer_id,
               u.customer_password,
               p.phone_number as profile_phone,
               p.address as profile_address,
               COALESCE(c.phone, p.phone_number) as phone,
               COALESCE(c.address, p.address) as address,
               COALESCE(c.city,
                 CASE
                   WHEN p.address IS NOT NULL AND p.address != '' THEN
                     CASE
                       WHEN p.address LIKE '%,%' THEN TRIM(SUBSTRING_INDEX(p.address, ',', -1))
                       WHEN p.address LIKE '% %' THEN TRIM(SUBSTRING_INDEX(p.address, ' ', -1))
                       ELSE TRIM(p.address)
                     END
                   ELSE NULL
                 END
               ) as city,
               c.assigned_staff_name,
               c.assigned_staff_email,
               c.assigned_staff_phone,
               c.assigned_staff_department,
               c.assigned_staff_designation,
               0 as total_enquiries,
               0 as total_favorites,
               NULL as last_enquiry_date
        FROM customers c
        LEFT JOIN users u ON c.user_id = u.id
        LEFT JOIN profiles p ON u.id = p.id
        WHERE c.id = ?`,
      [id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    res.json({ customer: rows[0] });
  } catch (error) {
    logger.error('Error fetching customer:', error);
    res.status(500).json({ error: 'Server error fetching customer' });
  }
});

// Create new customer
router.post('/', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const {
      full_name,
      email,
      phone,
      customer_type,
      address,
      city,
      state,
      zip_code,
      date_of_birth,
      gender,
      occupation,
      preferred_location,
      property_interest,
      source,
      status,
      notes,
      avatar_url
    } = req.body;
    
    // Validate required fields
    if (!full_name || !email) {
      return res.status(400).json({ error: 'Full name and email are required' });
    }
    
    logger.info('Creating new customer:', { full_name, email, phone });
    
    // Check if email already exists in users table
    const [existingUser] = await pool.execute(
      'SELECT id FROM users WHERE email = ?',
      [email]
    );
    
    if (existingUser.length > 0) {
      return res.status(400).json({ error: 'User with this email already exists' });
    }
    
    // Check if email already exists in customers table
    const [existingCustomer] = await pool.execute(
      'SELECT id FROM customers WHERE email = ?',
      [email]
    );
    
    if (existingCustomer.length > 0) {
      return res.status(400).json({ error: 'Customer with this email already exists' });
    }
    
    // Generate customer credentials
    let customerId = generateCustomerId(email);
    const customerPassword = 'Customer@123';
    
    // Ensure customer_id is unique
    let attempts = 0;
    while (attempts < 10) {
      const [existingCustomerId] = await pool.execute(
        'SELECT id FROM users WHERE customer_id = ?',
        [customerId]
      );
      
      if (existingCustomerId.length === 0) {
        break; // Customer ID is unique
      }
      
      // Generate a new customer ID
      customerId = generateCustomerId(email);
      attempts++;
    }
    
    if (attempts >= 10) {
      return res.status(500).json({ error: 'Unable to generate unique customer ID' });
    }
    
    logger.info('Generated customer credentials:', { customerId, customerPassword });
    
    // Hash the password for user account
    const hashedPassword = await bcrypt.hash(customerPassword, 10);
    
    logger.info('Starting customer creation process...');
    
    try {
      // 1. Create user account with customer role
      logger.info('Creating user account...');
      const [userResult] = await pool.execute(
        `INSERT INTO users (
          email, password, full_name, role, customer_id, customer_password, 
          email_confirmed, created_at, updated_at
        ) VALUES (?, ?, ?, 'customer', ?, ?, 1, NOW(), NOW())`,
        [email, hashedPassword, full_name, customerId, customerPassword]
      );
      
      const userId = userResult.insertId;
      logger.info('User created with ID:', userId);
      
      // 2. Create profile record
      logger.info('Creating profile record...');
      await pool.execute(
        `INSERT INTO profiles (
          id, phone_number, address, created_at, updated_at, email_confirmed
        ) VALUES (?, ?, ?, NOW(), NOW(), 1)`,
        [userId, phone, address]
      );
      logger.info('Profile created successfully');
      
      // 3. Create customer record
      logger.info('Creating customer record...');

      // 1. Find all present sales executives in sales department
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');
      const todayStr = `${yyyy}-${mm}-${dd}`;
      // Get all present sales executives
      const [presentExecs] = await pool.execute(
        `SELECT s.id, s.full_name, s.email, s.phone, s.department, s.designation
         FROM staff s
         JOIN attendance_logs a ON s.id = a.staff_id
         WHERE s.department = 'Sales' AND s.designation = 'Sales Executive'
           AND a.date = ? AND a.status = 'present' AND s.status = 'active'`
        , [todayStr]
      );

      let assignedStaff = null;
      if (presentExecs.length > 0) {
        // Find the sales executive with the least assigned customers today
        const execIds = presentExecs.map(e => e.id);
        const placeholders = execIds.map(() => '?').join(',');
        // Count assignments for each exec today
        const [assignmentCounts] = await pool.execute(
          `SELECT assigned_staff_id, COUNT(*) as cnt
           FROM customers
           WHERE assigned_staff_id IN (${placeholders})
             AND DATE(created_at) = ?
           GROUP BY assigned_staff_id`,
          [...execIds, todayStr]
        );
        // Map exec id to count
        const countMap = {};
        assignmentCounts.forEach(row => { countMap[row.assigned_staff_id] = row.cnt; });
        // Find exec(s) with min count
        let minCount = Math.min(...presentExecs.map(e => countMap[e.id] || 0));
        let leastLoaded = presentExecs.filter(e => (countMap[e.id] || 0) === minCount);
        // Pick randomly among least loaded
        assignedStaff = leastLoaded[Math.floor(Math.random() * leastLoaded.length)];
      }

      let assignedFields = {
        assigned_staff_id: null,
        assigned_staff_name: null,
        assigned_staff_email: null,
        assigned_staff_phone: null,
        assigned_staff_department: null,
        assigned_staff_designation: null
      };
      if (assignedStaff) {
        assignedFields = {
          assigned_staff_id: assignedStaff.id,
          assigned_staff_name: assignedStaff.full_name,
          assigned_staff_email: assignedStaff.email,
          assigned_staff_phone: assignedStaff.phone,
          assigned_staff_department: assignedStaff.department,
          assigned_staff_designation: assignedStaff.designation
        };
      }

      // 2. Insert customer with assigned staff
      const [customerResult] = await pool.execute(
        `INSERT INTO customers (user_id, full_name, email, phone, address, city, created_at,
          assigned_staff_id, assigned_staff_name, assigned_staff_email, assigned_staff_phone, assigned_staff_department, assigned_staff_designation)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, ?, ?)`,
        [userId, full_name, email, phone, address, city,
         assignedFields.assigned_staff_id, assignedFields.assigned_staff_name, assignedFields.assigned_staff_email,
         assignedFields.assigned_staff_phone, assignedFields.assigned_staff_department, assignedFields.assigned_staff_designation]
      );
      logger.info('Customer record created with ID:', customerResult.insertId);

      // Create customer object with the data we have
      const customerData = {
        id: customerResult.insertId,
        user_id: userId,
        full_name,
        email,
        phone,
        address,
        city,
        customer_id: customerId,
        customer_password: customerPassword,
        created_at: new Date().toISOString(),
        ...assignedFields
      };

      logger.info('New customer created successfully:', {
        customerId: customerId,
        customerPassword: customerPassword,
        email: email,
        full_name: full_name,
        assignedStaff: assignedFields
      });
      
      // Send customer credentials email
      let emailSent = false;
      let emailError = null;
      
      try {
        logger.info('📧 Sending customer credentials email...');
        logger.dev('Email details:', {
          to: email,
          customerId: customerId,
          customerPassword: customerPassword,
          fullName: full_name,
          userId: userId
        });
        
        await sendCustomerCredentialsEmail(email, customerId, customerPassword, full_name, userId);
        emailSent = true;
        logger.info('✅ Customer credentials email sent successfully to:', email);
        
        // Log success for admin tracking
        logger.info('📊 Customer account created and credentials emailed:', {
          customerId: customerId,
          email: email,
          fullName: full_name,
          emailSent: true,
          timestamp: new Date().toISOString()
        });
        
      } catch (error) {
        emailError = error;
        logger.error('❌ Failed to send customer credentials email:', error.message);
        logger.dev('Email error details:', {
          code: error.code,
          command: error.command,
          response: error.response,
          email: email,
          customerId: customerId,
          fullName: full_name,
          timestamp: new Date().toISOString()
        });
        
        // Even if email fails, we still created the customer successfully
        logger.warn('⚠️ Customer account created but email failed - manual notification may be needed');
      }
      
      res.status(201).json({ 
        customer: customerData,
        credentials: {
          customer_id: customerId,
          customer_password: customerPassword
        },
        message: 'Customer created successfully with login credentials',
        email: {
          sent: emailSent,
          error: emailError ? emailError.message : null
        }
      });
      
    } catch (dbError) {
      logger.error('Database error creating customer:', dbError);
      throw dbError;
    }
    
  } catch (error) {
    logger.error('Error creating customer:', error);
    res.status(500).json({ 
      error: 'Server error creating customer',
      details: error.message 
    });
  }
});

// Resend customer credentials email
router.post('/:id/resend-credentials', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { id } = req.params;
    
    // Get customer details
    const [customerRows] = await pool.execute(`
      SELECT c.*, u.customer_id, u.customer_password, u.full_name, u.email 
      FROM customers c 
      JOIN users u ON c.user_id = u.id 
      WHERE c.id = ?
    `, [id]);
    
    if (customerRows.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    const customer = customerRows[0];
    
    // Check if customer has credentials
    if (!customer.customer_id || !customer.customer_password) {
      return res.status(400).json({ 
        error: 'Customer does not have auto-generated credentials to resend' 
      });
    }
    
    // Send credentials email
    let emailSent = false;
    let emailError = null;
    
    try {
      logger.info('📧 Resending customer credentials email for customer ID:', customer.customer_id);
      await sendCustomerCredentialsEmail(
        customer.email, 
        customer.customer_id, 
        customer.customer_password, 
        customer.full_name, 
        customer.user_id
      );
      emailSent = true;
      logger.info('✅ Customer credentials email resent successfully to:', customer.email);
    } catch (error) {
      emailError = error;
      logger.error('❌ Failed to resend customer credentials email:', error.message);
    }
    
    res.json({
      success: emailSent,
      message: emailSent ? 'Credentials email sent successfully' : 'Failed to send credentials email',
      email: {
        sent: emailSent,
        error: emailError ? emailError.message : null,
        sentTo: customer.email
      }
    });
    
  } catch (error) {
    logger.error('Error resending customer credentials:', error);
    res.status(500).json({ 
      error: 'Server error resending credentials',
      details: error.message 
    });
  }
});

// Update customer
router.put('/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { id } = req.params;
    const updateData = req.body;
    
    // Log incoming data for debugging
    console.log('UPDATE /:id - Received update data:', updateData);

    // Check if customer exists
    const [existingCustomer] = await pool.execute(
      'SELECT id FROM customers WHERE id = ?',
      [id]
    );
    
    if (existingCustomer.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    // Build update query dynamically
    const updateFields = [];
    const updateValues = [];
    
    const allowedFields = [
      'full_name', 'email', 'phone', 'customer_type', 'address', 'city', 'state', 'zip_code',
      'date_of_birth', 'gender', 'occupation', 'preferred_location', 'property_interest',
      'source', 'status', 'notes', 'avatar_url', 'user_id',
      'assigned_staff_id', 'assigned_staff_name', 'assigned_staff_email',
      'assigned_staff_phone', 'assigned_staff_department', 'assigned_staff_designation'
    ];
    
    for (const field of allowedFields) {
      if (updateData.hasOwnProperty(field)) {
        // Handle different field types appropriately
        if (field === 'date_of_birth' && (updateData[field] === '' || updateData[field] === null)) {
          // Date fields: convert empty strings to NULL
          updateFields.push(`${field} = ?`);
          updateValues.push(null);
                } else if (field === 'gender' && updateData[field] === '') {
          // Gender field: convert empty strings to NULL
          updateFields.push(`${field} = ?`);
          updateValues.push(null);
        } else if (['occupation', 'preferred_location',
                    'property_interest', 'notes', 'avatar_url', 'address', 'city', 'state', 'zip_code',
                    'assigned_staff_name', 'assigned_staff_email', 'assigned_staff_phone',
                    'assigned_staff_department', 'assigned_staff_designation'].includes(field)) {
          // String fields that can be empty: convert empty strings to NULL
          const value = updateData[field] === '' ? null : updateData[field];
          updateFields.push(`${field} = ?`);
          updateValues.push(value);
        } else {
          // All other fields (required fields, enums, etc.)
          // Prevent full_name and email from being updated to an empty string, as they are required fields.
          if ((field === 'full_name' || field === 'email') && (typeof updateData[field] !== 'string' || updateData[field].trim() === '')) {
            // Skip updating if full_name or email is not a string or is being set to an empty string
            continue;
          }
          updateFields.push(`${field} = ?`);
          updateValues.push(updateData[field]);
        }
      }
    }
    
    if (updateFields.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }
    
    updateFields.push('updated_at = NOW()');
    updateValues.push(id);
    
    const updateQuery = `UPDATE customers SET ${updateFields.join(', ')} WHERE id = ?`;

    // Log query and values for debugging
    console.log('UPDATE /:id - Update fields:', updateFields);
    console.log('UPDATE /:id - Update values:', updateValues);
    console.log('UPDATE /:id - Generated query:', updateQuery);
    
    await pool.execute(updateQuery, updateValues);
    
    // Get updated customer
    const [updatedCustomer] = await pool.execute(
      'SELECT * FROM customers WHERE id = ?',
      [id]
    );
    
    res.json({ customer: updatedCustomer[0] });
  } catch (error) {
    logger.error('Error updating customer:', error);
    res.status(500).json({ error: 'Server error updating customer' });
  }
});

// Delete customer
router.delete('/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { id } = req.params;
    
    // Check if customer exists and get user_id
    console.log('Attempting to delete customer with ID:', id);
    const [existingCustomer] = await pool.execute(
      'SELECT id, user_id FROM customers WHERE id = ?',
      [id]
    );
    
    console.log('Customer query result:', existingCustomer);
    
    if (existingCustomer.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    const customer = existingCustomer[0];
    const userId = customer.user_id;
    console.log('Found customer:', customer);
    
    console.log('Starting customer deletion for customer ID:', id, 'user ID:', userId);
    
    try {
      // Step 1: Delete from customers table first
      const [customerResult] = await pool.execute('DELETE FROM customers WHERE id = ?', [id]);
      console.log('Deleted customer record:', customerResult.affectedRows);
      
      // Step 2: Delete from users table if user_id exists
      if (userId) {
        const [userResult] = await pool.execute('DELETE FROM users WHERE id = ?', [userId]);
        console.log('Deleted user record:', userResult.affectedRows);
      }
      
      console.log('Customer deletion completed successfully');
    } catch (error) {
      console.error('Error during customer deletion:', error);
      throw error;
    }
    
    res.json({ success: true, message: 'Customer and associated user account deleted successfully' });
  } catch (error) {
    logger.error('Error deleting customer:', error);
    console.error('Full error details:', {
      message: error.message,
      code: error.code,
      errno: error.errno,
      sqlState: error.sqlState,
      sqlMessage: error.sqlMessage,
      stack: error.stack
    });
    res.status(500).json({ 
      error: 'Server error deleting customer',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Bulk operations
router.put('/bulk', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { ids, data } = req.body;
    
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Customer IDs are required' });
    }
    
    // Build update query dynamically
    const updateFields = [];
    const updateValues = [];
    
    const allowedFields = ['status', 'customer_type', 'source'];
    
    for (const field of allowedFields) {
      if (data.hasOwnProperty(field) && data[field] !== null && data[field] !== '') {
        updateFields.push(`${field} = ?`);
        updateValues.push(data[field]);
      }
    }
    
    if (updateFields.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }
    
    updateFields.push('updated_at = NOW()');
    
    const placeholders = ids.map(() => '?').join(',');
    const updateQuery = `UPDATE customers SET ${updateFields.join(', ')} WHERE id IN (${placeholders})`;
    
    await pool.execute(updateQuery, [...updateValues, ...ids]);
    
    res.json({ success: true, message: `Updated ${ids.length} customers` });
  } catch (error) {
    logger.error('Error bulk updating customers:', error);
    res.status(500).json({ error: 'Server error bulk updating customers' });
  }
});

// Bulk delete
router.delete('/bulk', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { ids } = req.body;
    
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: 'Customer IDs are required' });
    }
    
    // Get user_ids for all customers to be deleted
    const placeholders = ids.map(() => '?').join(',');
    const [customersToDelete] = await pool.execute(
      `SELECT id, user_id FROM customers WHERE id IN (${placeholders})`,
      ids
    );
    
    if (customersToDelete.length === 0) {
      return res.status(404).json({ error: 'No customers found to delete' });
    }
    
    try {
      // Step 1: Delete from customers table
      await pool.execute(`DELETE FROM customers WHERE id IN (${placeholders})`, ids);
      console.log('Deleted customer records:', ids.length);
      
      // Step 2: Delete from users table for each customer that has a user_id
      for (const customer of customersToDelete) {
        if (customer.user_id) {
          await pool.execute('DELETE FROM users WHERE id = ?', [customer.user_id]);
          console.log('Deleted user record for user_id:', customer.user_id);
        }
      }
      
      console.log('Bulk customer deletion completed successfully');
    } catch (error) {
      console.error('Bulk delete error:', error);
      throw error;
    }
    
    res.json({ success: true, message: `Deleted ${ids.length} customers and their associated user accounts` });
  } catch (error) {
    logger.error('Error bulk deleting customers:', error);
    console.error('Bulk delete full error details:', {
      message: error.message,
      code: error.code,
      errno: error.errno,
      sqlState: error.sqlState,
      sqlMessage: error.sqlMessage,
      stack: error.stack
    });
    res.status(500).json({ 
      error: 'Server error bulk deleting customers',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Export customers
router.post('/export', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }
    
    const { customer_ids } = req.body;
    
    let query = 'SELECT * FROM customers';
    let params = [];
    
    if (customer_ids && customer_ids.length > 0) {
      const placeholders = customer_ids.map(() => '?').join(',');
      query += ` WHERE id IN (${placeholders})`;
      params = customer_ids;
    }
    
    query += ' ORDER BY created_at DESC';
    
    const [customers] = await pool.execute(query, params);
    
    // Convert to CSV format
    const headers = [
      'ID', 'Full Name', 'Email', 'Phone', 'City', 'Status', 'Customer Type',
      'Source', 'Created At'
    ];

    let csvContent = headers.join(',') + '\n';

    customers.forEach(customer => {
      const row = [
        customer.id,
        `"${customer.full_name || ''}"`,
        `"${customer.email || ''}"`,
        `"${customer.phone || ''}"`,
        `"${customer.city || ''}"`,
        `"${customer.status || ''}"`,
        `"${customer.customer_type || ''}"`,
        `"${customer.source || ''}"`,
        `"${customer.created_at || ''}"`
      ];
      csvContent += row.join(',') + '\n';
    });
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=customers.csv');
    res.send(csvContent);
  } catch (error) {
    logger.error('Error exporting customers:', error);
    res.status(500).json({ error: 'Server error exporting customers' });
  }
});

// Get customer analytics
router.get('/analytics/stats', auth, async (req, res) => {
  try {
    // Allow both admin and staff to view full analytics
    if (req.user.role !== 'admin' && req.user.role !== 'staff') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const [totalCustomers] = await pool.execute('SELECT COUNT(*) as total FROM customers');
    const [activeCustomers] = await pool.execute('SELECT COUNT(*) as total FROM customers WHERE status = "active"');
    const [newCustomersThisMonth] = await pool.execute(
      'SELECT COUNT(*) as total FROM customers WHERE MONTH(created_at) = MONTH(CURRENT_DATE()) AND YEAR(created_at) = YEAR(CURRENT_DATE())'
    );
    const [newCustomersThisDay] = await pool.execute(
      'SELECT COUNT(*) as total FROM customers WHERE DATE(created_at) = CURDATE()'
    );
    const [newCustomersThisWeek] = await pool.execute(
      'SELECT COUNT(*) as total FROM customers WHERE YEARWEEK(created_at, 1) = YEARWEEK(CURDATE(), 1)'
    );
    const [sourceStats] = await pool.execute('SELECT source, COUNT(*) as count FROM customers GROUP BY source ORDER BY count DESC');
    const [customerTypeStats] = await pool.execute('SELECT customer_type, COUNT(*) as count FROM customers GROUP BY customer_type ORDER BY count DESC');
    const [statusStats] = await pool.execute('SELECT status, COUNT(*) as count FROM customers GROUP BY status ORDER BY count DESC');
    const [monthlyTrends] = await pool.execute(`
      SELECT 
        DATE_FORMAT(created_at, '%Y-%m') as month,
        COUNT(*) as count
      FROM customers 
      WHERE created_at >= DATE_SUB(CURRENT_DATE(), INTERVAL 12 MONTH)
      GROUP BY DATE_FORMAT(created_at, '%Y-%m')
      ORDER BY month ASC
    `);
    const [cityStats] = await pool.execute('SELECT city, COUNT(*) as count FROM customers WHERE city IS NOT NULL AND city != "" GROUP BY city ORDER BY count DESC LIMIT 10');

    res.json({
      totalCustomers: totalCustomers[0].total,
      activeCustomers: activeCustomers[0].total,
      newCustomersThisMonth: newCustomersThisMonth[0].total,
      newCustomersThisDay: newCustomersThisDay[0].total,
      newCustomersThisWeek: newCustomersThisWeek[0].total,
      sourceDistribution: sourceStats,
      customerTypeDistribution: customerTypeStats,
      statusDistribution: statusStats,
      monthlyTrends: monthlyTrends,
      topCities: cityStats
    });
  } catch (error) {
    logger.error('Error fetching customer analytics:', error);
    res.status(500).json({ error: 'Server error fetching customer analytics' });
  }
});

// Sync customer users manually
router.post('/sync-users', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    await syncCustomerUsers();
    res.json({ success: true, message: 'Customer users synced successfully' });
  } catch (error) {
    logger.error('Error syncing customer users:', error);
    res.status(500).json({ error: 'Server error syncing customer users' });
  }
});

// Assign staff to customer
router.post('/:id/assign-staff', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const { id } = req.params;
    const { staff_id } = req.body;

    if (!staff_id) {
      return res.status(400).json({ error: 'Staff ID is required' });
    }

    // Check if customer exists
    const [customerCheck] = await pool.execute(
      'SELECT id FROM customers WHERE id = ?',
      [id]
    );

    if (customerCheck.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Check if staff member exists and is active
    const [staffCheck] = await pool.execute(
      'SELECT id, full_name, email, phone, department, designation FROM staff WHERE id = ? AND status = "active"',
      [staff_id]
    );

    if (staffCheck.length === 0) {
      return res.status(404).json({ error: 'Staff member not found or not active' });
    }

    const staffMember = staffCheck[0];

    // Update customer with assigned staff information
    await pool.execute(
      `UPDATE customers SET
        assigned_staff_id = ?,
        assigned_staff_name = ?,
        assigned_staff_email = ?,
        assigned_staff_phone = ?,
        assigned_staff_department = ?,
        assigned_staff_designation = ?,
        updated_at = NOW()
      WHERE id = ?`,
      [
        staffMember.id,
        staffMember.full_name,
        staffMember.email,
        staffMember.phone,
        staffMember.department,
        staffMember.designation,
        id
      ]
    );

    logger.info('Staff assigned to customer:', {
      customerId: id,
      staffId: staff_id,
      staffName: staffMember.full_name
    });

    res.json({
      success: true,
      message: 'Staff member assigned successfully',
      assignedStaff: {
        id: staffMember.id,
        name: staffMember.full_name,
        email: staffMember.email,
        phone: staffMember.phone,
        department: staffMember.department,
        designation: staffMember.designation
      }
    });

  } catch (error) {
    logger.error('Error assigning staff to customer:', error);
    res.status(500).json({
      error: 'Server error assigning staff to customer',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Remove staff assignment from customer
router.delete('/:id/assign-staff', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const { id } = req.params;

    // Check if customer exists
    const [customerCheck] = await pool.execute(
      'SELECT id FROM customers WHERE id = ?',
      [id]
    );

    if (customerCheck.length === 0) {
      return res.status(404).json({ error: 'Customer not found' });
    }

    // Remove staff assignment
    await pool.execute(
      `UPDATE customers SET
        assigned_staff_id = NULL,
        assigned_staff_name = NULL,
        assigned_staff_email = NULL,
        assigned_staff_phone = NULL,
        assigned_staff_department = NULL,
        assigned_staff_designation = NULL,
        updated_at = NOW()
      WHERE id = ?`,
      [id]
    );

    logger.info('Staff assignment removed from customer:', { customerId: id });

    res.json({
      success: true,
      message: 'Staff assignment removed successfully'
    });

  } catch (error) {
    logger.error('Error removing staff assignment from customer:', error);
    res.status(500).json({
      error: 'Server error removing staff assignment',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;


// --- Customer Conversations Endpoints ---

// GET /:id/conversations - list conversations for a customer
router.get('/:id/conversations', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute(
      'SELECT id, customer_id, conversation_date, conversation_text, staff_id, staff_name, conversation_type, notes, created_at, updated_at FROM customer_conversations WHERE customer_id = ? ORDER BY conversation_date DESC, created_at DESC',
      [id]
    );
    res.json(rows);
  } catch (error) {
    logger.error('Error fetching customer conversations:', error);
    res.status(500).json({ error: 'Server error fetching conversations' });
  }
});

// POST /:id/conversations - add a conversation for a customer
router.post('/:id/conversations', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { conversation_date, conversation_text, staff_id = null, staff_name = null, conversation_type = 'call', notes = null } = req.body;
    if (!conversation_date || !conversation_text) {
      return res.status(400).json({ error: 'Conversation date and text are required' });
    }
    await pool.execute(
      'INSERT INTO customer_conversations (customer_id, conversation_date, conversation_text, staff_id, staff_name, conversation_type, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, conversation_date, conversation_text, staff_id, staff_name, conversation_type, notes]
    );
    res.json({ success: true });
  } catch (error) {
    logger.error('Error adding customer conversation:', error);
    res.status(500).json({ error: 'Server error adding conversation' });
  }
});

// DELETE /:id/conversations/:conversationId - delete a conversation
router.delete('/:id/conversations/:conversationId', auth, async (req, res) => {
  try {
    const { conversationId } = req.params;
    await pool.execute('DELETE FROM customer_conversations WHERE id = ?', [conversationId]);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting customer conversation:', error);
    res.status(500).json({ error: 'Server error deleting conversation' });
  }
});