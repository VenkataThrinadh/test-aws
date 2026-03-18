const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const auth = require('../middleware/auth');
const logger = require('../utils/logger');
const NotificationService = require('../services/notificationService');

// In-memory cache to prevent rapid duplicate submissions
const recentSubmissions = new Map();
const processedSubmissionIds = new Set();

// Clean up old entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamp] of recentSubmissions.entries()) {
    if (now - timestamp > 60000) { // Remove entries older than 1 minute
      recentSubmissions.delete(key);
    }
  }
  
  // Clean up processed submission IDs (keep only last 1000)
  if (processedSubmissionIds.size > 1000) {
    const idsArray = Array.from(processedSubmissionIds);
    processedSubmissionIds.clear();
    // Keep only the last 500
    idsArray.slice(-500).forEach(id => processedSubmissionIds.add(id));
  }
}, 300000); // Run cleanup every 5 minutes



// Get all enquiries (admin only)
router.get('/', auth, async (req, res) => {
  try {
    const { status, property_id, user_id, limit, sort, order, page } = req.query;
    
    // Debug logging
    console.log(`🔍 Fetching enquiries with filters:`, { status, property_id, user_id, limit, sort, order, page });
    console.log(`👤 Requesting user:`, { id: req.user.id, email: req.user.email, role: req.user.role });
    
    // Check if user is admin or property owner
    let query;
    let params = [];
    
    if (req.user.role === 'admin') {
      // Admin can see all enquiries
      query = `
        SELECT e.*, p.title as property_title, u.full_name as user_name, u.email as user_email,
               lp.plot_number as land_plot_number, lp.area as plot_area, lp.price as plot_price
        FROM property_enquiries e
        JOIN properties p ON e.property_id = p.id
        LEFT JOIN users u ON e.user_id = u.id
        LEFT JOIN land_plots lp ON e.plot_id = lp.id
        WHERE 1=1
      `;
      
      if (status) {
        query += ` AND e.status = ?`;
        params.push(status);
      }
      
      if (property_id) {
        query += ` AND e.property_id = ?`;
        params.push(property_id);
      }
      
      if (user_id) {
        query += ` AND e.user_id = ?`;
        params.push(user_id);
      }
    } else {
      // Regular users can only see enquiries for their properties
      query = `
        SELECT e.*, p.title as property_title, u.full_name as user_name, u.email as user_email,
               lp.plot_number as land_plot_number, lp.area as plot_area, lp.price as plot_price
        FROM property_enquiries e
        JOIN properties p ON e.property_id = p.id
        LEFT JOIN users u ON e.user_id = u.id
        LEFT JOIN land_plots lp ON e.plot_id = lp.id
        WHERE p.owner_id = ?
      `;
      params.push(req.user.id);
      
      if (status) {
        query += ` AND e.status = ?`;
        params.push(status);
      }
      
      if (property_id) {
        query += ` AND e.property_id = ?`;
        params.push(property_id);
      }
      
      if (user_id) {
        query += ` AND e.user_id = ?`;
        params.push(user_id);
      }
    }
    
    // Add sorting
    const sortField = sort === 'created_at' ? 'e.created_at' : 'e.created_at';
    const sortOrder = order === 'asc' ? 'ASC' : 'DESC';
    query += ` ORDER BY ${sortField} ${sortOrder}`;
    
    // Add pagination
    if (limit) {
      const limitNum = parseInt(limit, 10) || 10;
      const pageNum = parseInt(page, 10) || 1;
      const offset = (pageNum - 1) * limitNum;
      query += ` LIMIT ${limitNum} OFFSET ${offset}`;
    }
    
    console.log(`📝 Final query:`, query);
    console.log(`🔧 Query params:`, params);
    
    const [rows] = await pool.execute(query, params);
    
    console.log(`📊 Found ${rows.length} enquiries`);
    if (rows.length > 0) {
      console.log(`📋 Sample enquiry:`, rows[0]);
    }
    
    res.json({ enquiries: rows });
  } catch (error) {
    logger.error('Error fetching enquiries:', error);
    res.status(500).json({ 
      error: 'Server error fetching enquiries',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get all enquiries (admin only) - alternative endpoint for the frontend
router.get('/all', auth, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized to access all enquiries' });
    }
    
    const query = `
      SELECT e.*, p.title as property_title, u.full_name as user_name, u.email as user_email,
             lp.plot_number as land_plot_number, lp.area as plot_area, lp.price as plot_price
      FROM property_enquiries e
      JOIN properties p ON e.property_id = p.id
      LEFT JOIN users u ON e.user_id = u.id
      LEFT JOIN land_plots lp ON e.plot_id = lp.id
      ORDER BY e.created_at DESC
    `;
    
    const [rows] = await pool.execute(query);
    
    res.json({ enquiries: rows });
  } catch (error) {
    logger.error('Error fetching all enquiries:', error);
    res.status(500).json({ 
      error: 'Server error fetching all enquiries',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get user's enquiries
router.get('/my-enquiries', auth, async (req, res) => {
  try {
    const [rows] = await pool.execute(
      `SELECT e.*, p.title as property_title, p.price, p.city, p.status as property_status,
              lp.plot_number as land_plot_number, lp.area as plot_area, lp.price as plot_price
       FROM property_enquiries e
       JOIN properties p ON e.property_id = p.id
       LEFT JOIN land_plots lp ON e.plot_id = lp.id
       WHERE e.user_id = ?
       ORDER BY e.created_at DESC`,
      [req.user.id]
    );
    
    res.json({ enquiries: rows });
  } catch (error) {
    logger.error('Error fetching user enquiries:', error);
    res.status(500).json({ 
      error: 'Server error fetching user enquiries',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get single enquiry by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if user is admin or property owner
    let query;
    let params = [id];
    
    if (req.user.role === 'admin') {
      // Admin can see any enquiry
      query = `
        SELECT e.*, p.title as property_title, u.full_name as user_name, u.email as user_email,
               lp.plot_number as land_plot_number, lp.area as plot_area, lp.price as plot_price
        FROM property_enquiries e
        JOIN properties p ON e.property_id = p.id
        LEFT JOIN users u ON e.user_id = u.id
        LEFT JOIN land_plots lp ON e.plot_id = lp.id
        WHERE e.id = ?
      `;
    } else {
      // Regular users can only see enquiries for their properties or their own enquiries
      query = `
        SELECT e.*, p.title as property_title, u.full_name as user_name, u.email as user_email,
               lp.plot_number as land_plot_number, lp.area as plot_area, lp.price as plot_price
        FROM property_enquiries e
        JOIN properties p ON e.property_id = p.id
        LEFT JOIN users u ON e.user_id = u.id
        LEFT JOIN land_plots lp ON e.plot_id = lp.id
        WHERE e.id = ? AND (p.owner_id = ? OR e.user_id = ?)
      `;
      params = [id, req.user.id, req.user.id];
    }
    
    const [rows] = await pool.execute(query, params);
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Enquiry not found' });
    }
    
    res.json(rows[0]);
  } catch (error) {
    logger.error('Error fetching enquiry:', error);
    res.status(500).json({ 
      error: 'Server error fetching enquiry',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Create new enquiry
router.post('/', auth, async (req, res) => {
  try {
    const {
      propertyId,
      message,
      plotId,
      plotNumber,
      enquiryType,
      unitType,
      name,
      email,
      phone,
      subject,
      priority,
      source,
      budget_min,
      budget_max,
      preferred_location,
      property_type,
      requirements,
      follow_up_date,
      notes,
      submissionId
    } = req.body;

    const submissionIdFromBody = req.body.submissionId;

    logger.info('Received enquiry creation request:', {
      userId: req.user.id,
      propertyId,
      message,
      plotId,
      plotNumber,
      enquiryType,
      unitType,
      name,
      email,
      phone,
      subject,
      priority,
      source,
      budget_min,
      budget_max,
      preferred_location,
      property_type,
      requirements,
      follow_up_date,
      notes,
      submissionIdFromBody,
      bodyKeys: Object.keys(req.body),
      fullRequestBody: req.body
    });

    logger.info('Submission ID:', submissionId);
    
    // Check if this submission ID has already been processed
    if (submissionIdFromBody && processedSubmissionIds.has(submissionIdFromBody)) {
      logger.warn('Duplicate submission ID found:', submissionIdFromBody);
      return res.status(409).json({
        error: 'This enquiry has already been submitted',
        submissionId: submissionIdFromBody,
        message: 'Your enquiry was already submitted successfully',
        success: true // Indicate this is not a real error
      });
    }

    // Add submission ID to processed set
    if (submissionIdFromBody) {
      processedSubmissionIds.add(submissionIdFromBody);
      logger.info('Added submission ID to processed set:', submissionIdFromBody);
    }

    // Log the actual data being inserted
    logger.info('About to insert enquiry with data:', {
      user_id: req.user.id,
      property_id: propertyId,
      message: message ? message.substring(0, 100) + '...' : null,
      plot_id: plotId,
      plot_number: plotNumber,
      enquiry_type: enquiryType,
      unit_type: unitType,
      name: name,
      email: email,
      phone: phone,
      subject: subject,
      priority: priority,
      source: source,
      budget_min: budget_min,
      budget_max: budget_max,
      preferred_location: preferred_location,
      property_type: property_type,
      requirements: requirements,
      follow_up_date: follow_up_date,
      notes: notes
    });

    // Determine the plot_id to use for database insertion
    // For non-land properties, we don't want to use plotId as FK reference
    let dbPlotId = null;
    if (plotId && plotId !== null && plotId !== undefined && plotId !== '') {
      logger.info('Determining database plot ID for insertion');
      // Check if this is a land property
      const propertyTypeCheck = await pool.execute('SELECT property_type FROM properties WHERE id = ?', [propertyId]);
      const propertyType = propertyTypeCheck[0]?.property_type;

      logger.info('Property type:', propertyType);

      if (propertyType === 'land') {
        logger.info('Using actual plot ID for land property');
        // For land properties, use the actual plotId
        dbPlotId = plotId;
      } else {
        logger.info('Setting plot ID to null for non-land property');
        // For non-land properties, set to null to avoid FK constraint
        // We'll still store the plot_number for reference
        dbPlotId = null;
      }
    }

    logger.info('Database plot ID:', dbPlotId);

    // Log the exact parameter array being passed to the query
    const insertParams = [
      req.user.id, // user_id (0)
      propertyId, // property_id (1)
      message, // message (2)
      dbPlotId, // plot_id (3)
      plotNumber || null, // plot_number (4)
      enquiryType || 'general', // enquiry_type (5)
      unitType || null, // unit_type (6)
      name || null, // name (7)
      email || null, // email (8)
      phone || null, // phone (9)
      subject, // subject (10)
      priority || 'medium', // priority (11)
      source || 'website', // source (12)
      budget_min || null, // budget_min (13)
      budget_max || null, // budget_max (14)
      preferred_location || null, // preferred_location (15)
      property_type || null, // property_type (16)
      requirements || null, // requirements (17)
      follow_up_date ? new Date(follow_up_date).toISOString().split('T')[0] : null, // follow_up_date (18)
      notes || null // notes (19)
    ];

    logger.info('INSERT parameters array:', insertParams);
    logger.info('INSERT parameters length:', insertParams.length);

    // Validate critical parameters
    if (!insertParams[1] || insertParams[1] === null || insertParams[1] === undefined) {
      logger.error('CRITICAL: property_id is null/undefined:', insertParams[1]);
      return res.status(400).json({
        error: 'Property ID is required',
        details: 'property_id cannot be null or undefined'
      });
    }

    if (!insertParams[2] || insertParams[2] === null || insertParams[2] === undefined) {
      logger.error('CRITICAL: message is null/undefined:', insertParams[2]);
      return res.status(400).json({
        error: 'Message is required',
        details: 'message cannot be null or undefined'
      });
    }

    if (!insertParams[10] || insertParams[10] === null || insertParams[10] === undefined) {
      logger.error('CRITICAL: subject is null/undefined:', insertParams[10]);
      return res.status(400).json({
        error: 'Subject is required',
        details: 'subject cannot be null or undefined'
      });
    }
    
    // Create a unique key for this submission
    const submissionKey = `${req.user.id}_${propertyId}_${plotNumber || 'general'}_${enquiryType}`;
    const now = Date.now();

    logger.info('Submission key:', submissionKey);
    
    // Check in-memory cache for recent submissions
    if (recentSubmissions.has(submissionKey)) {
      const lastSubmission = recentSubmissions.get(submissionKey);
      const timeDiff = now - lastSubmission;

      logger.info('Recent submission found:', { timeDiff });
      
      if (timeDiff < 5000) { // 5 seconds
        logger.warn('Rate limited submission:', submissionKey);
        return res.status(429).json({
          error: 'Please wait before submitting another enquiry',
          retryAfter: Math.ceil((5000 - timeDiff) / 1000),
          message: 'Your enquiry is being processed',
          success: true // Indicate this is not a real error
        });
      }
    }
    
    // Add to cache
    recentSubmissions.set(submissionKey, now);
    logger.info('Added submission key to cache:', submissionKey);
    
    // Check for recent duplicate submissions (within last 30 seconds)
    // Include plot information in duplicate check for more accuracy
    const [duplicateCheck] = await pool.execute(
      `SELECT id, created_at, message, plot_number, enquiry_type, subject FROM property_enquiries
       WHERE user_id = ? AND property_id = ?
       AND created_at > NOW() - INTERVAL 30 SECOND
       AND (
         (message = ? AND subject = ?) OR
         (plot_number = ? AND plot_number IS NOT NULL) OR
         (enquiry_type = ? AND enquiry_type = 'plot_enquiry')
       )
       ORDER BY created_at DESC LIMIT 1`,
      [req.user.id, propertyId, message || '', subject || '', plotNumber || null, enquiryType || '']
    );

    logger.info('Duplicate check query result:', duplicateCheck);
    
    if (duplicateCheck.length > 0) {
      const existing = duplicateCheck[0];
      const timeDiff = new Date() - new Date(existing.created_at);

      logger.info('Duplicate enquiry found:', { existing, timeDiff });
      
      // If it's an exact match (same message or same plot), return existing
      if ((existing.message === message && existing.subject === subject) ||
          (existing.plot_number === plotNumber && plotNumber) ||
          (existing.enquiry_type === 'plot_enquiry' && enquiryType === 'plot_enquiry' && existing.plot_number === plotNumber)) {
        
        logger.warn('Exact duplicate enquiry found, returning existing:', existing.id);
        return res.status(200).json({
          ...existing,
          message: 'Your enquiry was already submitted successfully',
          isDuplicate: true
        });
      }
    }
    
    if (!propertyId || !message || !subject) {
      logger.error('Property ID, subject and message are required', {
        propertyId,
        message: !!message,
        subject,
        hasPropertyId: !!propertyId,
        messageLength: message ? message.length : 0,
        subjectLength: subject ? subject.length : 0
      });
      return res.status(400).json({
        error: 'Property ID, subject and message are required',
        details: {
          propertyId: !!propertyId,
          message: !!message,
          subject: !!subject
        }
      });
    }

    logger.info('Property ID and message are present');
    
    // Check if property exists
    const [propertyCheck] = await pool.execute('SELECT id, title FROM properties WHERE id = ?', [propertyId]);

    logger.info('Property check query result:', propertyCheck);
    
    if (propertyCheck.length === 0) {
      logger.error('Property not found:', propertyId);
      return res.status(404).json({ error: 'Property not found' });
    }

    logger.info('Property exists:', propertyCheck[0].title);
    
    const [result] = await pool.execute(
      `INSERT INTO property_enquiries (
        user_id, property_id, message, status, plot_id, plot_number,
        enquiry_type, unit_type, name, email, phone, subject, priority,
        source, budget_min, budget_max, preferred_location, property_type,
        requirements, follow_up_date, notes, created_at
      )
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      insertParams
    );

    logger.info('Enquiry inserted successfully, result:', result);
    
    // Get the inserted record
    const [newEnquiry] = await pool.execute(
      'SELECT * FROM property_enquiries WHERE id = ?',
      [result.insertId]
    );

    logger.info('New enquiry record:', newEnquiry[0]);
    
    // Create notification for admin with assigned telecaller
    try {
      logger.info('Creating notification for admin with auto-assigned telecaller');
      // Get property details for notification
      const [propertyResult] = await pool.execute(
        'SELECT id, title FROM properties WHERE id = ?',
        [propertyId]
      );
      
      // Get user details for notification
      const [userResult] = await pool.execute(
        'SELECT id, full_name, email FROM users WHERE id = ?',
        [req.user.id]
      );
      
      const property = propertyResult[0];
      const user = userResult[0];
      
      // Auto-assign a telecaller using round-robin
      let assignedStaff = null;
      try {
        // Get all active telecaller staff members (sorted by id for consistency)
        const [telleCallers] = await pool.execute(
          `SELECT id, full_name, email, phone, designation, department 
           FROM staff 
           WHERE designation = 'telecaller' AND status = 'active'
           ORDER BY id ASC`
        );
        
        if (telleCallers.length > 0) {
          // Get the current round-robin pointer for this property
          const [pointerRows] = await pool.execute(
            `SELECT last_assigned_staff_id FROM enquiry_assignment_pointer WHERE property_id = ?`,
            [propertyId]
          );
          
          let nextStaffIndex = 0;
          if (pointerRows.length > 0 && pointerRows[0].last_assigned_staff_id) {
            // Find the last assigned staff index
            const lastStaffId = pointerRows[0].last_assigned_staff_id;
            const lastIndex = telleCallers.findIndex(tc => tc.id === lastStaffId);
            nextStaffIndex = (lastIndex === -1 || lastIndex === telleCallers.length - 1) ? 0 : lastIndex + 1;
          }
          
          assignedStaff = telleCallers[nextStaffIndex];
          
          // Update the round-robin pointer
          await pool.execute(
            `REPLACE INTO enquiry_assignment_pointer (property_id, last_assigned_staff_id) VALUES (?, ?)`,
            [propertyId, assignedStaff.id]
          );
          
          logger.info(`Auto-assigned telecaller ${assignedStaff.full_name} (${assignedStaff.phone}) to enquiry ${result.insertId}`);
        }
      } catch (assignError) {
        logger.warn('Error auto-assigning telecaller:', assignError.message);
        // Continue without auto-assignment if it fails
      }
      
      await NotificationService.createEnquiryNotification(
        newEnquiry[0],
        user,
        property,
        assignedStaff
      );
      
      logger.info(`Notification created for enquiry ${result.insertId}${assignedStaff ? ' with assigned telecaller: ' + assignedStaff.full_name : ''}`);
    } catch (notificationError) {
      logger.error('Error creating notification for enquiry:', notificationError);
      // Don't fail the enquiry creation if notification fails
    }
    
    res.status(201).json(newEnquiry[0]);
  } catch (error) {
    logger.error('Error creating enquiry:', error);
    logger.error('Error details:', {
      message: error.message,
      code: error.code,
      errno: error.errno,
      sqlState: error.sqlState,
      sqlMessage: error.sqlMessage,
      stack: error.stack
    });

    // Return more detailed error in development
    if (process.env.NODE_ENV === 'development') {
      res.status(500).json({
        error: 'Server error creating enquiry',
        details: error.message,
        sqlError: error.sqlMessage,
        code: error.code,
        errno: error.errno
      });
    } else {
      res.status(500).json({
        error: 'Server error creating enquiry',
        details: 'An unexpected error occurred. Please try again later.'
      });
    }
  }
});

// Respond to enquiry (admin or property owner only)
router.post('/:id/respond', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { response } = req.body;
    
    if (!response) {
      return res.status(400).json({ error: 'Response is required' });
    }
    
    // Check if enquiry exists and user is authorized
    const enquiryCheck = await pool.execute(
      `SELECT e.*, p.owner_id
       FROM property_enquiries e
       JOIN properties p ON e.property_id = p.id
       WHERE e.id = ?`,
      [id]
    );
    
    if (enquiryCheck.length === 0) {
      return res.status(404).json({ error: 'Enquiry not found' });
    }
    
    const enquiry = enquiryCheck[0][0];
    
    // Check authorization
    if (req.user.role !== 'admin' && req.user.id !== enquiry.owner_id) {
      return res.status(403).json({ error: 'Not authorized to respond to this enquiry' });
    }
    
    // Update enquiry with response
    const [result] = await pool.execute(
      `UPDATE property_enquiries
       SET status = 'responded', response = ?, updated_at = NOW()
       WHERE id = ?`,
      [response, id]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Enquiry not found' });
    }
    
    // Get the updated record
    const [updatedEnquiry] = await pool.execute(
      `SELECT e.*, p.title as property_title, u.full_name as user_name, u.email as user_email,
              lp.plot_number as land_plot_number, lp.area as plot_area, lp.price as plot_price
       FROM property_enquiries e
       JOIN properties p ON e.property_id = p.id
       LEFT JOIN users u ON e.user_id = u.id
       LEFT JOIN land_plots lp ON e.plot_id = lp.id
       WHERE e.id = ?`,
      [id]
    );
    
    res.json(updatedEnquiry[0]);
  } catch (error) {
    logger.error('Error responding to enquiry:', error);
    res.status(500).json({ 
      error: 'Server error responding to enquiry',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Update enquiry status (admin or property owner only)
router.put('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, response } = req.body;
    
    if (!status) {
      return res.status(400).json({ error: 'Status is required' });
    }
    
    // Validate status
    if (!['pending', 'responded', 'resolved', 'in_progress', 'closed'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    
    // Check if enquiry exists and user is authorized
    const enquiryCheck = await pool.execute(
      `SELECT e.*, p.owner_id
       FROM property_enquiries e
       JOIN properties p ON e.property_id = p.id
       WHERE e.id = ?`,
      [id]
    );
    
    if (enquiryCheck.length === 0) {
      return res.status(404).json({ error: 'Enquiry not found' });
    }
    
    const enquiry = enquiryCheck[0];
    
    // Check if user is admin or property owner
    if (req.user.role !== 'admin' && req.user.id !== enquiry.owner_id) {
      return res.status(403).json({ error: 'Not authorized to update this enquiry' });
    }
    
    // Update enquiry
    const [result] = await pool.execute(
      `UPDATE property_enquiries
       SET status = ?, response = ?, updated_at = NOW()
       WHERE id = ?`,
      [status, response || null, id]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Enquiry not found' });
    }
    
    // Get the updated record
    const [updatedEnquiry] = await pool.execute(
      'SELECT * FROM property_enquiries WHERE id = ?',
      [id]
    );
    
    res.json(updatedEnquiry[0]);
  } catch (error) {
    logger.error('Error updating enquiry:', error);
    res.status(500).json({ 
      error: 'Server error updating enquiry',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Get enquiry conversation/replies
router.get('/:id/replies', auth, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if enquiry exists and user is authorized
    let query;
    let params = [id];

    if (req.user.role === 'admin') {
      // Admin can see any enquiry
      query = `
        SELECT er.*, u.full_name as sender_name, u.role as sender_role
        FROM enquiry_replies er
        LEFT JOIN users u ON er.user_id = u.id
        WHERE er.enquiry_id = ?
        ORDER BY er.created_at ASC
      `;
    } else {
      // Regular users can only see replies for their own enquiries
      query = `
        SELECT er.*, u.full_name as sender_name, u.role as sender_role
        FROM enquiry_replies er
        LEFT JOIN users u ON er.user_id = u.id
        JOIN property_enquiries pe ON er.enquiry_id = pe.id
        WHERE er.enquiry_id = ? AND (pe.user_id = ? OR pe.user_id IS NULL)
        ORDER BY er.created_at ASC
      `;
      params = [id, req.user.id];
    }

    const [replies] = await pool.execute(query, params);

    res.json({ replies });
  } catch (error) {
    logger.error('Error fetching enquiry replies:', error);
    res.status(500).json({
      error: 'Server error fetching replies',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Add reply to enquiry conversation
router.post('/:id/reply', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;

    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Check if enquiry exists and user is authorized
    const enquiryCheck = await pool.execute(
      `SELECT pe.*, p.owner_id
       FROM property_enquiries pe
       JOIN properties p ON pe.property_id = p.id
       WHERE pe.id = ?`,
      [id]
    );

    if (enquiryCheck.length === 0) {
      return res.status(404).json({ error: 'Enquiry not found' });
    }

    const enquiry = enquiryCheck[0][0];

    // Check authorization - user must be the enquiry owner or admin/property owner
    if (req.user.role !== 'admin' && req.user.id !== enquiry.owner_id && req.user.id !== enquiry.user_id) {
      return res.status(403).json({ error: 'Not authorized to reply to this enquiry' });
    }

    // Determine sender type
    let senderType = 'user';
    if (req.user.role === 'admin' || req.user.id === enquiry.owner_id) {
      senderType = 'admin';
    }

    // Insert the reply
    const [result] = await pool.execute(
      `INSERT INTO enquiry_replies (enquiry_id, user_id, sender_type, message, created_at)
       VALUES (?, ?, ?, ?, NOW())`,
      [id, req.user.id, senderType, message.trim()]
    );

    // Get the inserted reply with user info
    const [newReply] = await pool.execute(
      `SELECT er.*, u.full_name as sender_name, u.role as sender_role
       FROM enquiry_replies er
       LEFT JOIN users u ON er.user_id = u.id
       WHERE er.id = ?`,
      [result.insertId]
    );

    // Update enquiry updated_at timestamp
    await pool.execute(
      'UPDATE property_enquiries SET updated_at = NOW() WHERE id = ?',
      [id]
    );

    // Create notification for the other party
    try {
      const recipientId = senderType === 'admin' ? enquiry.user_id : enquiry.owner_id;
      if (recipientId) {
        const notificationMessage = senderType === 'admin'
          ? `New response to your enquiry for ${enquiry.property_title || 'a property'}`
          : `New reply from customer regarding enquiry for ${enquiry.property_title || 'a property'}`;

        await NotificationService.createNotification(
          'enquiry_reply',
          'New Enquiry Reply',
          notificationMessage,
          {
            enquiry_id: id,
            reply_id: result.insertId,
            sender_type: senderType,
            recipient_id: recipientId
          }
        );
      }
    } catch (notificationError) {
      logger.error('Error creating reply notification:', notificationError);
      // Don't fail the reply if notification fails
    }

    res.status(201).json({
      reply: newReply[0],
      message: 'Reply sent successfully'
    });
  } catch (error) {
    logger.error('Error adding enquiry reply:', error);
    res.status(500).json({
      error: 'Server error adding reply',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Mark replies as read
router.put('/:id/replies/read', auth, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if enquiry exists and user is authorized
    let query;
    let params = [req.user.id, id];

    if (req.user.role === 'admin') {
      // Admin can mark any enquiry replies as read
      query = `
        UPDATE enquiry_replies
        SET is_read = 1, read_at = NOW()
        WHERE enquiry_id = ? AND user_id != ? AND is_read = 0
      `;
      params = [id, req.user.id];
    } else {
      // Regular users can only mark replies for their own enquiries
      query = `
        UPDATE enquiry_replies er
        JOIN property_enquiries pe ON er.enquiry_id = pe.id
        SET er.is_read = 1, er.read_at = NOW()
        WHERE er.enquiry_id = ? AND pe.user_id = ? AND er.user_id != ? AND er.is_read = 0
      `;
    }

    const [result] = await pool.execute(query, params);

    res.json({
      success: true,
      markedAsRead: result.affectedRows,
      message: `${result.affectedRows} replies marked as read`
    });
  } catch (error) {
    logger.error('Error marking replies as read:', error);
    res.status(500).json({
      error: 'Server error marking replies as read',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// Delete enquiry (admin only)
router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const [result] = await pool.execute(
      'DELETE FROM property_enquiries WHERE id = ?',
      [id]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Enquiry not found' });
    }

    res.json({ success: true, message: 'Enquiry deleted successfully' });
  } catch (error) {
    logger.error('Error deleting enquiry:', error);
    res.status(500).json({
      error: 'Server error deleting enquiry',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

module.exports = router;