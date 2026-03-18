const express = require('express');
const router = express.Router();
const path = require('path');
const { Readable } = require('stream');
const ExcelJS = require('exceljs');
const multer = require('multer');
const { pool } = require('../db');
const auth = require('../middleware/auth');
const { imageExists, filterExistingImages } = require('../utils/imageUtils');
const logger = require('../utils/logger');

const IMPORT_UPLOAD = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024 // 10MB
  },
  fileFilter: (req, file, cb) => {
    const allowedMimeTypes = [
      'text/csv',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/json'
    ];

    if (allowedMimeTypes.includes(file.mimetype) || ['.csv', '.xls', '.xlsx', '.json'].includes(path.extname(file.originalname).toLowerCase())) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Please upload a CSV, XLS, XLSX, or JSON file.'));
    }
  }
});

const EXPORT_COLUMNS = [
  { header: 'ID', key: 'id' },
  { header: 'Title', key: 'title' },
  { header: 'Description', key: 'description' },
  { header: 'Property Type', key: 'property_type' },
  { header: 'Status', key: 'status' },
  { header: 'Price', key: 'price' },
  { header: 'Area', key: 'area' },
  { header: 'City', key: 'city' },
  { header: 'State', key: 'state' },
  { header: 'Address', key: 'address' },
  { header: 'Zip Code', key: 'zip_code' },
  { header: 'Built Year', key: 'built_year' },
  { header: 'Is Featured', key: 'is_featured' },
  { header: 'Outstanding Amount', key: 'outstanding_amount' },
  { header: 'Unit Number', key: 'unit_number' },
  { header: 'Location', key: 'location' },
  { header: 'Contact Email', key: 'contact_email' },
  { header: 'Contact Phone', key: 'contact_phone' },
  { header: 'Features', key: 'features', width: 40 },
  { header: 'Created At', key: 'created_at' },
  { header: 'Updated At', key: 'updated_at' }
];

const REQUIRED_IMPORT_FIELDS = ['title', 'price', 'city'];
const BOOLEAN_FIELDS = ['is_featured'];
const FLOAT_FIELDS = ['area', 'outstanding_amount'];
const INTEGER_FIELDS = ['built_year'];
const SUPPORTED_FEATURE_KEYS = ['features'];
const ALPHANUMERIC_PRICE_TYPES = ['apartment', 'villa', 'commercial', 'house', 'land'];

const HEADER_KEY_MAP = EXPORT_COLUMNS.reduce((acc, column) => {
  if (column.header) {
    acc[column.header.toLowerCase()] = column.key;
  }
  acc[column.key.toLowerCase()] = column.key;
  return acc;
}, {});

const IMPORTABLE_KEYS = new Set([
  'title',
  'price',
  'description',
  'area',
  'address',
  'city',
  'state',
  'zip_code',
  'property_type',
  'type',
  'is_featured',
  'status',
  'features',
  'unit_number',
  'outstanding_amount',
  'location',
  'built_year',
  'contact_email',
  'contact_phone'
]);

const getCellPrimitiveValue = (value) => {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === 'object') {
    if (value.text !== undefined) {
      return value.text;
    }

    if (value.result !== undefined) {
      return value.result;
    }

    if (Array.isArray(value.richText)) {
      return value.richText.map((segment) => segment.text).join('');
    }

    if (value.hyperlink && value.text) {
      return value.text;
    }
  }

  return value;
};

const parseWorksheetRows = (worksheet) => {
  if (!worksheet) return [];

  const headerRow = worksheet.getRow(1);
  const headerValues = headerRow.values.slice(1).map((cell) => {
    const headerValue = getCellPrimitiveValue(cell);
    return headerValue ? String(headerValue).trim() : null;
  });

  const headers = headerValues.map((header) => {
    if (!header) return null;
    const mappedKey = HEADER_KEY_MAP[header.toLowerCase()];
    return mappedKey || header.replace(/\s+/g, '_').toLowerCase();
  });

  const rows = [];

  worksheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;

    const rowData = {};
    let hasValue = false;

    headers.forEach((key, index) => {
      if (!key) return;

      const cellValue = getCellPrimitiveValue(row.getCell(index + 1).value);

      if (cellValue !== null && cellValue !== undefined && cellValue !== '') {
        hasValue = true;
      }

      rowData[key] = cellValue;
    });

    if (hasValue) {
      rows.push({ rowNumber, data: rowData });
    }
  });

  return rows;
};

const safeParseJSON = (value, defaultValue = null) => {
  if (value === undefined || value === null) return defaultValue;
  try {
    if (typeof value === 'object') return value;
    return JSON.parse(value);
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      logger.warn('Failed to parse JSON value during properties import/export', { value });
    }
    return defaultValue;
  }
};

const mapRowForExport = (row) => {
  const mappedRow = {
    ...row,
    is_featured: row.is_featured ? 'Yes' : 'No',
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };

  if (row.features) {
    const parsedFeatures = safeParseJSON(row.features);
    if (parsedFeatures) {
      mappedRow.features = JSON.stringify(parsedFeatures);
    }
  }

  return mappedRow;
};

const INSERT_PROPERTY_QUERY = `
  INSERT INTO properties (
    title, price, description, area,
    address, city, state, zip_code, property_type, type, is_featured,
    owner_id, status, features, unit_number, outstanding_amount, location, built_year,
    contact_email, contact_phone, clone_url
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

const normalizeValue = (key, value) => {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const trimmedValue = typeof value === 'string' ? value.trim() : value;

  if (BOOLEAN_FIELDS.includes(key)) {
    if (typeof trimmedValue === 'boolean') return trimmedValue;
    const lowerValue = String(trimmedValue).toLowerCase();
    return ['true', '1', 'yes', 'y'].includes(lowerValue);
  }

  if (FLOAT_FIELDS.includes(key)) {
    const parsed = parseFloat(trimmedValue);
    return Number.isNaN(parsed) ? null : parsed;
  }

  if (INTEGER_FIELDS.includes(key)) {
    const parsed = parseInt(trimmedValue, 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  if (SUPPORTED_FEATURE_KEYS.includes(key)) {
    if (Array.isArray(trimmedValue)) return trimmedValue;
    if (typeof trimmedValue === 'object') {
      return [trimmedValue];
    }

    try {
      const parsed = JSON.parse(trimmedValue);
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (error) {
      return [{ value: trimmedValue }];
    }
  }

  if (key === 'price') {
    const normalized = String(trimmedValue).trim();
    return normalized === '' ? null : normalized;
  }

  return trimmedValue;
};

const normalizeRow = (row) => {
  const normalizedRow = {};

  Object.entries(row).forEach(([key, value]) => {
    if (!IMPORTABLE_KEYS.has(key)) {
      return;
    }

    normalizedRow[key] = normalizeValue(key, value);
  });

  if (normalizedRow.property_type && !normalizedRow.type) {
    normalizedRow.type = normalizedRow.property_type;
  }

  if (normalizedRow.price && normalizedRow.property_type) {
    const sanitizedPrice = sanitizePriceForType(normalizedRow.price, normalizedRow.property_type);
    normalizedRow.price = sanitizedPrice;
  }

  return normalizedRow;
};

const validateRow = (row) => {
  const errors = [];
  REQUIRED_IMPORT_FIELDS.forEach((field) => {
    if (!row[field]) {
      errors.push(`${field} is required`);
    }
  });

  if (row.area && Number.isNaN(parseFloat(row.area))) {
    errors.push('area must be numeric');
  }

  if (row.built_year && (Number.isNaN(parseInt(row.built_year, 10)) || parseInt(row.built_year, 10) < 1800)) {
    errors.push('built_year must be a valid year');
  }

  if (row.contact_phone) {
    const normalizedPhone = String(row.contact_phone).replace(/\s|-/g, '');
    if (!/^\+?\d{7,15}$/.test(normalizedPhone)) {
      errors.push('contact_phone is not a valid phone number');
    }
  }

  if (row.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(row.contact_email))) {
    errors.push('contact_email is not a valid email');
  }

  if (row.property_type) {
    if (!row.price) {
      errors.push('price is required when property_type is provided');
    }

    const sanitizedPrice = sanitizePriceForType(row.price, row.property_type);
    if (row.price && sanitizedPrice === null) {
      errors.push('price must be numeric for this property type');
    }
  }

  return errors;
};

// Health check endpoint (no auth required)
router.get('/health', async (req, res) => {
  try {
    // Test database connection
    const [result] = await pool.execute('SELECT COUNT(*) as property_count FROM properties');
    
    res.json({
      status: 'ok',
      message: 'Properties service is healthy',
      database: 'connected',
      propertyCount: result[0].property_count,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      message: 'Properties service health check failed',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});





// Debug endpoint to test property creation (development only)
if (process.env.NODE_ENV === 'development') {
  router.post('/debug-create', auth, async (req, res) => {
    try {
      logger.dev('🔧 DEBUG: Property creation test');
      logger.dev('User:', req.user);
      logger.dev('Request body:', JSON.stringify(req.body, null, 2));
      
      // Test database connection
      const [testResult] = await pool.execute('SELECT 1 as test');
      logger.dev('Database connection test:', testResult);
      
      // Test user exists
      const [userResult] = await pool.execute('SELECT id, email, role FROM users WHERE id = ?', [req.user.id]);
      logger.dev('User verification:', userResult);
      
      // Test properties table structure
      const [tableInfo] = await pool.execute('DESCRIBE properties');
      logger.dev('Properties table structure:', tableInfo.map(col => ({ field: col.Field, type: col.Type, null: col.Null })));
      
      res.json({
        success: true,
        message: 'Debug test completed',
        user: req.user,
        dbTest: testResult,
        userExists: userResult.length > 0,
        tableStructure: tableInfo.map(col => ({ field: col.Field, type: col.Type, null: col.Null })),
        requestBody: req.body
      });
    } catch (error) {
      logger.error('Debug test error:', error);
      res.status(500).json({
        error: 'Debug test failed',
        message: error.message,
        code: error.code
      });
    }
  });
  
  // Test property creation with minimal data
  router.post('/test-create', auth, async (req, res) => {
    try {
      logger.dev('🧪 TEST: Creating test property');
      
      const testPropertyData = {
        title: 'Test Property ' + Date.now(),
        price: '100000',
        city: 'Test City',
        property_type: 'apartment',
        status: 'available'
      };
      
      logger.dev('Test property data:', testPropertyData);
      
      // Create the query with minimal fields
      const query = `
        INSERT INTO properties (title, price, city, property_type, status, owner_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, NOW())
      `;
      
      const values = [
        testPropertyData.title,
        testPropertyData.price,
        testPropertyData.city,
        testPropertyData.property_type,
        testPropertyData.status,
        req.user.id
      ];
      
      logger.dev('Executing query:', query);
      logger.dev('With values:', values);
      
      const [result] = await pool.execute(query, values);
      logger.dev('Insert result:', result);
      
      // Get the created property
      const [propertyRows] = await pool.execute('SELECT * FROM properties WHERE id = ?', [result.insertId]);
      
      res.json({
        success: true,
        message: 'Test property created successfully',
        insertResult: {
          insertId: result.insertId,
          affectedRows: result.affectedRows
        },
        property: propertyRows[0]
      });
      
    } catch (error) {
      logger.error('Test property creation error:', error);
      res.status(500).json({
        error: 'Test property creation failed',
        message: error.message,
        code: error.code,
        sqlState: error.sqlState
      });
    }
  });
}

router.get('/export', auth, async (req, res) => {
  try {
    const {
      format = 'csv',
      includeInactive,
      includeImages,
      startDate,
      endDate,
      status,
      propertyType
    } = req.query;

    let query = 'SELECT * FROM properties WHERE 1=1';
    const params = [];

    if (includeInactive !== 'true') {
      query += " AND (status != 'inactive' OR status IS NULL)";
    }

    if (status && status !== 'all') {
      query += ' AND status = ?';
      params.push(status);
    }

    if (propertyType && propertyType !== 'all') {
      query += ' AND property_type = ?';
      params.push(propertyType);
    }

    if (startDate) {
      query += ' AND created_at >= ?';
      params.push(new Date(startDate));
    }

    if (endDate) {
      query += ' AND created_at <= ?';
      params.push(new Date(endDate));
    }

    query += ' ORDER BY created_at DESC';

    const [rows] = await pool.execute(query, params);

    const exportColumns = [...EXPORT_COLUMNS];
    const includeImageUrls = includeImages === 'true';

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(200).json({
        success: true,
        message: 'No properties found for the selected filters',
        count: 0
      });
    }

    if (includeImageUrls) {
      exportColumns.push({ header: 'Image URLs', key: 'image_urls', width: 60 });
    }

    let rowsWithImages = [...rows];

    if (includeImageUrls && rows.length > 0) {
      const propertyIds = rows.map((row) => row.id);
      const placeholders = propertyIds.map(() => '?').join(',');
      const [imageRows] = await pool.execute(
        `SELECT property_id, image_url FROM property_images WHERE property_id IN (${placeholders}) ORDER BY is_primary DESC`,
        propertyIds
      );

      const imageMap = imageRows.reduce((acc, current) => {
        if (!acc.has(current.property_id)) {
          acc.set(current.property_id, []);
        }
        acc.get(current.property_id).push(current.image_url);
        return acc;
      }, new Map());

      rowsWithImages = rows.map((row) => ({
        ...row,
        image_urls: imageMap.has(row.id) ? imageMap.get(row.id).join(', ') : ''
      }));
    }

    const mappedRows = rowsWithImages.map((row) => {
      const mapped = mapRowForExport(row);
      if (includeImageUrls) {
        mapped.image_urls = row.image_urls || '';
      }
      return mapped;
    });

    const timestamp = new Date().toISOString().split('T')[0];
    const baseFilename = `properties_${timestamp}`;
    const normalizedFormat = String(format).toLowerCase();

    if (normalizedFormat === 'json') {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="${baseFilename}.json"`);
      return res.status(200).send(JSON.stringify(mappedRows, null, 2));
    }

    if (normalizedFormat === 'xlsx') {
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet('Properties');

      worksheet.columns = exportColumns.map((column) => ({
        header: column.header || column.key,
        key: column.key,
        width: column.width || 20
      }));

      mappedRows.forEach((row) => {
        worksheet.addRow(row);
      });

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );
      res.setHeader('Content-Disposition', `attachment; filename="${baseFilename}.xlsx"`);

      await workbook.xlsx.write(res);
      return res.end();
    }

    const headers = exportColumns.map((column) => column.header || column.key);
    const csvRows = [headers.join(',')];

    mappedRows.forEach((row) => {
      const csvRow = exportColumns.map((column) => {
        const rawValue = row[column.key];
        const value = rawValue === undefined || rawValue === null ? '' : rawValue;
        const stringValue = typeof value === 'string' ? value : JSON.stringify(value);
        return `"${stringValue.replace(/"/g, '""')}"`;
      });
      csvRows.push(csvRow.join(','));
    });

    const csvContent = csvRows.join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${baseFilename}.csv"`);
    return res.status(200).send(csvContent);
  } catch (error) {
    logger.error('Failed to export properties', error);
    return res.status(500).json({ error: 'Failed to export properties. Please try again later.' });
  }
});

// Get all properties
router.get('/', async (req, res) => {
  try {
    const { status, featured, city, limit, offset, owner_id, includeInactive } = req.query;
    
    let query = 'SELECT * FROM properties WHERE 1=1';
    const params = [];
    let paramIndex = 1;
    
    // By default, don't show inactive properties unless specifically requested
    if (includeInactive !== 'true') {
      query += ` AND (status != 'inactive' OR status IS NULL)`;
    }
    
    if (status) {
      query += ` AND status = ?`;
      params.push(status);
      paramIndex++;
    }
    
    if (featured === 'true') {
      query += ` AND is_featured = true`;
    }
    
    if (city) {
      query += ` AND city LIKE ?`;
      params.push(`%${city}%`);
      paramIndex++;
    }
    
    if (owner_id) {
      query += ` AND owner_id = ?`;
      params.push(owner_id);
      paramIndex++;
    }
    
    query += ' ORDER BY created_at DESC';
    
    if (limit) {
      query += ` LIMIT ?`;
      params.push(parseInt(limit));
      paramIndex++;
    }
    
    if (offset) {
      query += ` OFFSET ?`;
      params.push(parseInt(offset));
    }
    
    const [rows] = await pool.execute(query, params);
    
    // For each property, get the primary image and validate it exists
    const propertiesWithImages = await Promise.all(
      rows.map(async (property) => {
        const [imageResult] = await pool.execute(
          'SELECT image_url FROM property_images WHERE property_id = ? ORDER BY is_primary DESC LIMIT 1',
          [property.id]
        );
        
        let imageUrl = imageResult.length > 0 ? imageResult[0].image_url : null;
        
        // Validate that the image actually exists on the server
        if (imageUrl && !imageExists(imageUrl)) {
          logger.dev(`⚠️ Primary image missing for property ${property.id}: ${imageUrl}`);
          
          // Try to find any existing image for this property
          const [allImages] = await pool.execute(
            'SELECT image_url FROM property_images WHERE property_id = ?',
            [property.id]
          );
          
          // Find first existing image
          imageUrl = null;
          for (const img of allImages) {
            if (imageExists(img.image_url)) {
              imageUrl = img.image_url;
              break;
            }
          }
        }
        
        return {
          ...property,
          image_url: imageUrl
        };
      })
    );
    
    res.json(propertiesWithImages);
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error fetching properties:', error);
    }
    res.status(500).json({ error: 'Server error fetching properties' });
  }
});

// Base query for a single property including owner profile data
const PROPERTY_WITH_OWNER_QUERY = `
  SELECT 
    p.*, 
    pr.id AS owner_profile_id,
    pr.user_id AS owner_user_id,
    pr.firstname AS owner_firstname,
    pr.lastname AS owner_lastname,
    pr.email AS owner_email,
    pr.phone_number AS owner_phone,
    pr.address AS owner_address,
    pr.avatar_url AS owner_avatar_url
  FROM properties p
  LEFT JOIN profiles pr ON pr.id = p.owner_id
  WHERE p.id = ?
`;

// Helper to fetch a single enriched property row
const fetchPropertyWithOwner = async (id, connection = pool) => {
  try {
    const [rows] = await connection.execute(PROPERTY_WITH_OWNER_QUERY, [id]);
    return rows[0] || null;
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      logger.warn('Falling back to basic property fetch:', error.message);
    }
    const [fallbackRows] = await connection.execute('SELECT * FROM properties WHERE id = ?', [id]);
    return fallbackRows[0] || null;
  }
};

const mapPropertyRow = (row) => {
  if (!row) return null;

  const {
    owner_profile_id,
    owner_user_id,
    owner_firstname,
    owner_lastname,
    owner_email,
    owner_phone,
    owner_address,
    owner_avatar_url,
    ...propertyData
  } = row;

  const ownerProfile = owner_profile_id || owner_user_id
    ? {
        id: owner_profile_id ?? null,
        user_id: owner_user_id ?? null,
        firstname: owner_firstname ?? null,
        lastname: owner_lastname ?? null,
        email: owner_email ?? null,
        phone_number: owner_phone ?? null,
        address: owner_address ?? null,
        avatar_url: owner_avatar_url ?? null
      }
    : null;

  return {
    ...propertyData,
    owner: ownerProfile
  };
};

// Get all properties for dropdown (no auth required for staff form)
router.get('/all', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT id, title FROM properties ORDER BY title ASC');
    res.json(rows);
  } catch (error) {
    logger.error('Error fetching all properties:', error);
    res.status(500).json({ error: 'Server error fetching properties' });
  }
});

// Get property by ID
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    // Remove cache-busting parameter if present (e.g., ?_t=1234567890)
    const cleanId = id.split('?')[0];

    const propertyRow = await fetchPropertyWithOwner(cleanId);

    if (!propertyRow) {
      return res.status(404).json({ error: 'Property not found' });
    }

    const property = mapPropertyRow(propertyRow);

    // Get property images
    let images = [];
    try {
      const [imagesResult] = await pool.execute(
        'SELECT * FROM property_images WHERE property_id = ? ORDER BY is_primary DESC',
        [cleanId]
      );
      images = imagesResult;
    } catch (imagesError) {
      // Continue without images
    }

    // Filter out non-existent images
    const validImages = filterExistingImages(images);

    // Add cache control headers to prevent caching of property data
    res.set({
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });

    res.json({
      ...property,
      images: validImages,
      clone_url: property.clone_url
    });
  } catch (error) {
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error fetching property details:', error);
    }
    res.status(500).json({ error: 'Server error fetching property details', details: error.message });
  }
});

// Create new property
router.post('/', auth, async (req, res) => {
  try {
    // Debug: Log the entire request body
    logger.dev('🔍 Full request body received:', JSON.stringify(req.body, null, 2));
    
    const {
      title,
      price,
      description,
      area,
      address,
      city,
      state,
      zip_code,
      property_type,
      is_featured,
      status,
      features,
      unit_number,
      outstanding_amount,
      location,
      built_year,
      contact_email,
      contact_phone,
      clone_url
    } = req.body;
    
    // Debug: Log each extracted field
    logger.dev('🔍 Extracted fields:', {
      title, price, description, area, address, city, state, zip_code,
      property_type, is_featured, status, features, unit_number,
      outstanding_amount, location, built_year, contact_email, contact_phone
    });
    
    // Validate required fields
    logger.dev('🔍 Validating required fields:', { title, price, city });
    
    if (!title || !price || !city) {
      return res.status(400).json({ 
        error: 'Title, price, and city are required',
        received: { title: !!title, price: !!price, city: !!city },
        values: { title, price, city }
      });
    }
    
    // Validate user authentication
    if (!req.user || !req.user.id) {
      return res.status(401).json({ error: 'User authentication required' });
    }

    // Validate that the user exists in the database
    const [userCheck] = await pool.execute('SELECT id FROM users WHERE id = ?', [req.user.id]);
    if (userCheck.length === 0) {
      return res.status(401).json({ error: 'Invalid user - user not found in database' });
    }

    // Generate clone URL if not provided
    let finalCloneUrl = clone_url;
    if (!finalCloneUrl || finalCloneUrl.trim() === '') {
      finalCloneUrl = 'https://cewealthzen.com/clone';
    }

    // Creating property
    
    // Handle features array
    let featuresJson = null;
    if (features) {
      try {
        logger.dev('Processing features:', features, 'Type:', typeof features);
        
        // If features is already a string, parse it to ensure it's valid JSON
        if (typeof features === 'string') {
          const parsed = JSON.parse(features);
          featuresJson = JSON.stringify(parsed);
        } 
        // If features is an array, stringify it
        else if (Array.isArray(features)) {
          featuresJson = JSON.stringify(features);
        }
        // If features is an object, stringify it
        else if (typeof features === 'object') {
          featuresJson = JSON.stringify(features);
        }
        
        logger.dev('Processed features JSON:', featuresJson);
      } catch (e) {
        logger.error('Error processing features:', e.message);
        // Error parsing features - store as simple string array
        featuresJson = JSON.stringify([features.toString()]);
      }
    }
    
    // Create the query with all necessary fields
    const query = `
      INSERT INTO properties (
        title, price, description, area,
        address, city, state, zip_code, property_type, type, is_featured,
        owner_id, status, features, unit_number, outstanding_amount, location, built_year,
        contact_email, contact_phone, clone_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    // Handle price based on property type (alphanumeric for specific types)
    const alphanumericPriceTypes = ['apartment', 'villa', 'commercial', 'house', 'land'];
    const isAlphanumericType = alphanumericPriceTypes.includes(property_type?.toLowerCase());
    
    // Since price is VARCHAR(50) in database, we'll store it as string
    // But validate numeric values for non-alphanumeric types
    let priceValue = price;
    if (!isAlphanumericType && price) {
      const numericPrice = parseFloat(price);
      if (isNaN(numericPrice)) {
        return res.status(400).json({ 
          error: 'Invalid price format', 
          detail: 'Price must be a valid number for this property type' 
        });
      }
      priceValue = price.toString(); // Store as string in database
    }
    
    // Prepare values array with proper type conversions
    const values = [
      title,
      priceValue,
      description || null,
      area ? parseFloat(area) : null,
      address || null,
      city,
      state || null,
      zip_code || null,
      property_type || 'residential',
      property_type || 'residential', // type column (sync with property_type)
      is_featured === true || is_featured === 'true',
      req.user.id,
      status || 'available',
      featuresJson,
      unit_number || null,
      outstanding_amount ? parseFloat(outstanding_amount) : null,
      location || null,
      built_year ? parseInt(built_year) : null,
      contact_email || null,
      contact_phone || null,
      finalCloneUrl
    ];
    
    // Executing property creation query
    logger.dev('🔍 Executing property creation with values:', values.length, 'values');
    logger.dev('🔍 Query placeholders count:', (query.match(/\?/g) || []).length);
    logger.dev('🔍 Request body keys:', Object.keys(req.body));
    logger.dev('🔍 User ID:', req.user.id);
    
    // Log first few values for debugging (avoid logging sensitive data)
    logger.dev('🔍 Sample values:', {
      title: values[0],
      price: values[1],
      city: values[7],
      property_type: values[10],
      owner_id: values[13]
    });
    
    const [result] = await pool.execute(query, values);
    
    // Get the newly created property
    const propertyId = result.insertId;
    
    // Fetch the complete property data to return
    const createdPropertyRow = await fetchPropertyWithOwner(propertyId);

    if (!createdPropertyRow) {
      return res.status(404).json({ error: 'Property created but could not retrieve data' });
    }

    const createdProperty = mapPropertyRow(createdPropertyRow);

    res.status(201).json({
      success: true,
      message: 'Property created successfully',
      property: createdProperty
    });
  } catch (error) {
    logger.error('Error creating property:', error.message);
    
    // Handle specific database errors
    if (error.code === 'ER_NO_REFERENCED_ROW_2') {
      return res.status(400).json({ 
        error: 'Invalid owner reference', 
        detail: 'The specified owner does not exist in the users table',
        userId: req.user?.id
      });
    }
    
    if (error.code === 'ER_NO_REFERENCED_ROW' || error.code === 'ER_ROW_IS_REFERENCED_2') {
      return res.status(400).json({ 
        error: 'Foreign key constraint violation', 
        detail: 'Referenced user does not exist',
        userId: req.user?.id
      });
    }
    
    if (error.code === 'ER_BAD_NULL_ERROR') {
      return res.status(400).json({ 
        error: 'Missing required field', 
        detail: 'One or more required fields are missing or null' 
      });
    }
    
    if (error.code === 'ER_DATA_TOO_LONG') {
      return res.status(400).json({ 
        error: 'Data too long', 
        detail: 'One or more fields exceed the maximum allowed length' 
      });
    }
    
    if (error.code === 'ER_TRUNCATED_WRONG_VALUE') {
      return res.status(400).json({ 
        error: 'Invalid data format', 
        detail: 'One or more fields have invalid data format' 
      });
    }
    
    if (error.code === 'ER_WRONG_VALUE_COUNT_ON_ROW') {
      return res.status(400).json({ 
        error: 'Database query error', 
        detail: `Column count mismatch: Expected ${(query.match(/\?/g) || []).length} values but got ${values.length} values`
      });
    }
    
    // Log the request body for debugging (in development only)
    if (process.env.NODE_ENV === 'development') {
      logger.error('Request body:', JSON.stringify(req.body, null, 2));
    }
    
    // Generic server error
    res.status(500).json({ 
      error: 'Server error creating property', 
      detail: process.env.NODE_ENV === 'development' ? error.message : 'Please try again later',
      code: error.code 
    });
  }
});

// Update property
router.put('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      title,
      price,
      description,
      clone_url,
      area,
      address,
      city,
      state,
      zip_code,
      property_type,
      is_featured,
      status,
      contact_email,
      contact_phone
    } = req.body;
    
    // Check if user owns the property or is admin
    const [propertyCheck] = await pool.execute(
      `SELECT * FROM properties WHERE id = ? AND (owner_id = ? OR ? = 'admin')`,
      [id, req.user.id, req.user.role]
    );
    
    if (propertyCheck.length === 0) {
      return res.status(403).json({ error: 'Not authorized to update this property' });
    }
    
    // Handle price based on property type (alphanumeric for specific types)
    const alphanumericPriceTypes = ['apartment', 'villa', 'commercial', 'house', 'land'];
    const isAlphanumericType = alphanumericPriceTypes.includes(property_type?.toLowerCase());
    
    // Since price is VARCHAR(50) in database, we'll store it as string
    // But validate numeric values for non-alphanumeric types
    let priceValue = price;
    if (!isAlphanumericType && price) {
      const numericPrice = parseFloat(price);
      if (isNaN(numericPrice)) {
        return res.status(400).json({ 
          error: 'Invalid price format', 
          detail: 'Price must be a valid number for this property type' 
        });
      }
      priceValue = price.toString(); // Store as string in database
    }
    
    const [result] = await pool.execute(
      `UPDATE properties SET
        title = ?, price = ?, description = ?, clone_url = ?, area = ?,
        address = ?, city = ?, state = ?, zip_code = ?, property_type = ?, type = ?,
        is_featured = ?, status = ?, contact_email = ?, contact_phone = ?, updated_at = NOW()
      WHERE id = ?`,
      [
        title, priceValue, description, clone_url, area,
        address, city, state, zip_code, property_type, property_type, // sync type with property_type
        is_featured, status, contact_email, contact_phone, id
      ]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Property not found' });
    }
    
    // Get the updated property
    const [updatedProperty] = await pool.execute(
      'SELECT * FROM properties WHERE id = ?',
      [id]
    );
    
    res.json(updatedProperty[0]);
  } catch (error) {
    // Force detailed error logging for debugging
    logger.error('❌ Error updating property:', error.message);
    logger.error('Error code:', error.code);
    logger.error('SQL State:', error.sqlState);
    logger.error('Property ID:', req.params.id);
    logger.error('User ID:', req.user?.id);
    logger.error('Request body:', JSON.stringify(req.body, null, 2));
    
    // Handle specific database errors
    if (error.code === 'ER_NO_REFERENCED_ROW_2') {
      return res.status(400).json({ 
        error: 'Invalid reference', 
        detail: 'Referenced data does not exist',
        code: error.code
      });
    }
    
    if (error.code === 'ER_BAD_NULL_ERROR') {
      return res.status(400).json({ 
        error: 'Missing required field', 
        detail: 'One or more required fields are missing or null',
        code: error.code
      });
    }
    
    if (error.code === 'ER_DATA_TOO_LONG') {
      return res.status(400).json({ 
        error: 'Data too long', 
        detail: 'One or more fields exceed the maximum allowed length',
        code: error.code
      });
    }
    
    if (error.code === 'ER_WRONG_VALUE_COUNT_ON_ROW') {
      return res.status(400).json({ 
        error: 'Database query error', 
        detail: 'Column count does not match value count',
        code: error.code
      });
    }
    
    // Force detailed error message for debugging
    res.status(500).json({ 
      error: 'Server error updating property',
      detail: error.message,
      code: error.code,
      sqlState: error.sqlState
    });
  }
});

// Delete property
router.delete('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if user owns the property or is admin
    const [propertyCheck] = await pool.execute(
      `SELECT * FROM properties WHERE id = ? AND (owner_id = ? OR ? = 'admin')`,
      [id, req.user.id, req.user.role]
    );
    
    if (propertyCheck.length === 0) {
      return res.status(403).json({ error: 'Not authorized to delete this property' });
    }
    
    // Delete property (cascade will delete images)
    await pool.execute('DELETE FROM properties WHERE id = ?', [id]);
    
    res.json({ success: true, message: 'Property deleted successfully' });
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error deleting property:', error);
    }
    res.status(500).json({ error: 'Server error deleting property' });
  }
});

// Get property images
router.get('/:id/images', async (req, res) => {
  try {
    const { id } = req.params;
    const { isPrimary } = req.query;
    
    let query = 'SELECT * FROM property_images WHERE property_id = ?';
    const params = [id];
    
    if (isPrimary === 'true') {
      query += ' AND is_primary = true';
    }
    
    query += ' ORDER BY is_primary DESC, created_at ASC';
    
    const [rows] = await pool.execute(query, params);
    
    res.json(rows);
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error fetching property images:', error);
    }
    res.status(500).json({ error: 'Server error fetching property images' });
  }
});

// Add property image
router.post('/:id/images', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { image_url, is_primary } = req.body;
    
    // Check if user owns the property or is admin
    const [propertyCheck] = await pool.execute(
      `SELECT * FROM properties WHERE id = ? AND (owner_id = ? OR ? = 'admin')`,
      [id, req.user.id, req.user.role]
    );
    
    if (propertyCheck.length === 0) {
      return res.status(403).json({ error: 'Not authorized to add images to this property' });
    }
    
    // Insert image
    const [result] = await pool.execute(
      `INSERT INTO property_images (property_id, image_url, is_primary, created_at)
       VALUES (?, ?, ?, NOW())`,
      [id, image_url, is_primary]
    );
    
    // If this is the primary image, make sure no other images are primary for this property
    if (is_primary) {
      await pool.execute(
        `UPDATE property_images SET is_primary = false WHERE property_id = ? AND id != ?`,
        [id, result.insertId]
      );
    }
    
    // Get the inserted image record
    const [newImage] = await pool.execute(
      'SELECT * FROM property_images WHERE id = ?',
      [result.insertId]
    );
    
    res.status(201).json(newImage[0]);
  } catch (error) {
    // Enhanced error logging for debugging
    logger.error('❌ Error adding property image:', error.message);
    logger.error('Error code:', error.code);
    logger.error('SQL State:', error.sqlState);
    logger.error('Property ID:', req.params.id);
    logger.error('User ID:', req.user?.id);
    logger.error('Request body:', req.body);
    
    // Handle specific database errors
    if (error.code === 'ER_NO_REFERENCED_ROW_2') {
      return res.status(400).json({ 
        error: 'Invalid property reference', 
        detail: 'The specified property does not exist'
      });
    }
    
    if (error.code === 'ER_BAD_NULL_ERROR') {
      return res.status(400).json({ 
        error: 'Missing required field', 
        detail: 'Image URL is required' 
      });
    }
    
    if (error.code === 'ER_NO_SUCH_TABLE') {
      return res.status(500).json({ 
        error: 'Database schema error', 
        detail: 'Property images table does not exist' 
      });
    }
    
    // Generic server error
    res.status(500).json({ 
      error: 'Server error adding property image',
      detail: process.env.NODE_ENV === 'development' ? error.message : 'Please try again later'
    });
  }
});

// Delete property image
router.delete('/:propertyId/images/:imageId', auth, async (req, res) => {
  try {
    const { propertyId, imageId } = req.params;
    
    // Check if user owns the property or is admin
    const [propertyCheck] = await pool.execute(
      `SELECT * FROM properties WHERE id = ? AND (owner_id = ? OR ? = 'admin')`,
      [propertyId, req.user.id, req.user.role]
    );
    
    if (propertyCheck.length === 0) {
      return res.status(403).json({ error: 'Not authorized to delete images from this property' });
    }
    
    // Delete image
    await pool.execute('DELETE FROM property_images WHERE id = ? AND property_id = ?', [imageId, propertyId]);
    
    res.json({ success: true, message: 'Property image deleted successfully' });
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error deleting property image:', error);
    }
    res.status(500).json({ error: 'Server error deleting property image' });
  }
});

// Update property status
router.put('/:id/status', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    
    // Validate status
    if (!status || !['available', 'sold', 'pending', 'inactive'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status value' });
    }
    
    // Check if user is admin
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Only admins can update property status' });
    }
    
    // Update property status
    const [rows] = await pool.execute(
      'UPDATE properties SET status = ?, updated_at = NOW() WHERE id = ?',
      [status, id]
    );
    
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Property not found' });
    }
    
    res.json({
      success: true,
      message: 'Property status updated successfully',
      property: rows[0]
    });
  } catch (error) {
    // Only log errors in development environment
    if (process.env.NODE_ENV === 'development') {
      logger.error('Error updating property status:', error);
    }
    res.status(500).json({ error: 'Server error updating property status' });
  }
});

// Get all properties for dropdown (no auth required for staff form)
router.get('/all', async (req, res) => {
  try {
    const [rows] = await pool.execute('SELECT id, title FROM properties ORDER BY title ASC');
    res.json(rows);
  } catch (error) {
    logger.error('Error fetching all properties:', error);
    res.status(500).json({ error: 'Server error fetching properties' });
  }
});

module.exports = router;