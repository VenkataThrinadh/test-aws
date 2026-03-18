console.log('Leads API route loaded');
const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const auth = require('../middleware/auth');
const logger = require('../utils/logger');
const { sendLeadEvent } = require('../services/facebookService');
const axios = require('axios');



// Helper: Get random present telecaller in Sales department for today
async function getRandomPresentTelecaller() {
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const todayStr = `${yyyy}-${mm}-${dd}`;
  const [presentTelecallers] = await pool.execute(
    `SELECT s.id
     FROM staff s
     JOIN attendance_logs a ON s.id = a.staff_id
     WHERE s.department = 'Sales' AND s.designation = 'Telecaller'
       AND a.date = ? AND a.status = 'present' AND s.status = 'active'`
    , [todayStr]
  );
  if (presentTelecallers.length > 0) {
    const telecallerIds = presentTelecallers.map(e => e.id);
    const placeholders = telecallerIds.map(() => '?').join(',');
    const [assignmentCounts] = await pool.execute(
      `SELECT assigned_to, COUNT(*) as cnt
       FROM leads
       WHERE assigned_to IN (${placeholders})
         AND DATE(created_at) = ?
       GROUP BY assigned_to`,
      [...telecallerIds, todayStr]
    );
    const countMap = {};
    assignmentCounts.forEach(row => { countMap[row.assigned_to] = row.cnt; });
    let minCount = Math.min(...presentTelecallers.map(e => countMap[e.id] || 0));
    let leastLoaded = presentTelecallers.filter(e => (countMap[e.id] || 0) === minCount);
    return leastLoaded[Math.floor(Math.random() * leastLoaded.length)].id;
  }
  return null;
}

// PUT /:id/assign - assign telecaller to a lead (admin or staff)
router.put('/:id/assign', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { staffId } = req.body;
    if (!staffId) return res.status(400).json({ error: 'staffId is required' });

    // Only allow assignment to telecallers in Sales department
    const [staffRows] = await pool.execute(
      `SELECT id FROM staff WHERE id = ? AND department = 'Sales' AND designation = 'Telecaller' AND status = 'active'`,
      [staffId]
    );
    if (staffRows.length === 0) return res.status(400).json({ error: 'Invalid telecaller' });

    // Update lead assignment
    await pool.execute('UPDATE leads SET assigned_to = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [staffId, id]);

    // Return updated lead
    const [rows] = await pool.execute(
      `SELECT l.*, s.full_name AS assigned_name, s.phone AS assigned_phone, s.email AS assigned_email, s.department AS assigned_staff_department, s.designation AS assigned_staff_designation
       FROM leads l
       LEFT JOIN staff s ON l.assigned_to = s.id
       WHERE l.id = ?`,
      [id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Lead not found' });
    // Add aliases for frontend compatibility
    const lead = rows[0];
    lead.assigned_staff_phone = lead.assigned_phone;
    lead.assigned_staff_email = lead.assigned_email;
    lead.assigned_staff_department = lead.assigned_staff_department || lead.department;
    lead.assigned_staff_designation = lead.assigned_staff_designation || lead.designation;
    res.json(lead);
  } catch (error) {
    logger.error('Error assigning telecaller to lead:', error);
    res.status(500).json({ error: 'Server error assigning telecaller' });
  }
});

// Helper to get a usable Facebook Page access token from env.
function getFacebookAccessToken() {
  const raw = process.env.FB_PAGE_ACCESS_TOKEN || process.env.FB_ACCESS_TOKEN || process.env.FB_ACCESS_TOKEN_URL;
  if (!raw) return null;
  // If someone accidentally pasted a full URL with ?access_token=..., extract the token
  const m = String(raw).match(/[?&]access_token=([^&]+)/);
  if (m && m[1]) return decodeURIComponent(m[1]);
  // If the env contains the token itself, return it
  return String(raw);
}

// Fetch lead details from Meta Graph API when webhook only provides leadgen id
async function fetchLeadFromFacebook(leadgenId) {
  try {
    const token = getFacebookAccessToken();
    if (!token) {
      logger.warn('No Facebook access token configured; cannot fetch lead details');
      return null;
    }

    // Request common fields including field_data (answers)
    const fields = ['field_data', 'full_name', 'created_time', 'form_id', 'ad_id', 'page_id', 'leadgen_id'].join(',');
    const url = `https://graph.facebook.com/v14.0/${encodeURIComponent(leadgenId)}?access_token=${encodeURIComponent(token)}&fields=${encodeURIComponent(fields)}`;
    const resp = await axios.get(url, { timeout: 5000 });
    return resp.data;
  } catch (err) {
    logger.error('Error fetching lead from Facebook Graph API:', err.response?.data || err.message);
    return null;
  }
}

// Helper: admin-only guard
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
}

// Validate webhook secret
function validateWebhook(req) {
  const provided = req.headers['x-webhook-secret'] || req.query.secret;
  const expected = process.env.LEADS_WEBHOOK_SECRET || process.env.WEBHOOK_SECRET;
  return expected && provided && String(provided) === String(expected);
}

// Enhanced webhook validation for Meta Instant Forms
function validateMetaWebhook(req) {
  const signature = req.headers['x-hub-signature-256'];
  const body = JSON.stringify(req.body);

  if (!signature || !process.env.FB_APP_SECRET) {
    // Fallback to simple secret validation
    return validateWebhook(req);
  }

  const crypto = require('crypto');
  const expectedSignature = crypto
    .createHmac('sha256', process.env.FB_APP_SECRET)
    .update(body, 'utf8')
    .digest('hex');

  return signature === `sha256=${expectedSignature}`;
}

// Map source strings
const KNOWN_SOURCES = new Set(['facebook','instagram','youtube','linkedin','twitter','website','google','whatsapp','other']);
function normalizeSource(src) {
  if (!src) return 'other';
  const s = String(src).toLowerCase();
  if (s === 'ig') return 'instagram';
  if (s === 'fb' || s === 'facebook_ads' || s === 'meta') return 'facebook';
  if (s === 'yt' || s === 'youtube_ads') return 'youtube';
  if (s === 'ga' || s === 'google_ads') return 'google';
  return KNOWN_SOURCES.has(s) ? s : 'other';
}

// Try to extract a sensible display name from many webhook payload shapes
function extractNameFromBody(body) {
  if (!body || typeof body !== 'object') return null;

  // common flat fields
  if (body.full_name) return String(body.full_name).trim();
  if (body.fullName) return String(body.fullName).trim();
  if (body.name) return String(body.name).trim();

  // first/last name combinations
  const first = body.first_name || body.firstName || body.given_name || body.givenName;
  const last = body.last_name || body.lastName || body.family_name || body.familyName;
  if (first || last) {
    return `${(first || '').toString().trim()} ${(last || '').toString().trim()}`.trim() || null;
  }

  // Facebook/Meta leadgen: field_data or form_response arrays
  const arraysToCheck = [body.field_data, body.form_response?.answers, body.form_response?.field_data, body.data, body.entry];
  for (const arr of arraysToCheck) {
    if (!Array.isArray(arr)) continue;
    // field entries can be objects with { name, values } or { name, value } or { id, answer }
    for (const item of arr) {
      if (!item || typeof item !== 'object') continue;
      const key = (item.name || item.field || item.label || item.id || '').toString().toLowerCase();
      const candidate = item.value || item.values || item.answer || item.answers;
      // value may be array or nested
      let val = null;
      if (Array.isArray(candidate) && candidate.length) val = candidate[0];
      else if (typeof candidate === 'object' && candidate !== null) {
        val = candidate.text || candidate.value || JSON.stringify(candidate);
      } else if (candidate) val = candidate;

      if (!val && item.values && Array.isArray(item.values) && item.values.length) val = item.values[0];

      if (val && (key.includes('name') || key.includes('full') || key.includes('first') || key.includes('given'))) {
        return String(val).trim();
      }
    }
  }

  return null;
}

// GET / - list leads (allow staff and admin; mutations remain admin-only)
router.get('/', auth, async (req, res) => {
    console.log('GET /leads called');
  try {
    const { status, source, search, start_date, end_date, page = 1, limit = 20, assigned_to } = req.query;

    let query = `
      SELECT l.*, s.full_name AS assigned_name, s.phone AS assigned_phone, s.email AS assigned_email, s.department AS assigned_staff_department, s.designation AS assigned_staff_designation
      FROM leads l
      LEFT JOIN staff s ON l.assigned_to = s.id
      WHERE 1=1
    `;
    const params = [];

    if (status) { query += ' AND l.status = ?'; params.push(status); }
    if (source) { query += ' AND l.source = ?'; params.push(source); }
    if (assigned_to) {
      // Robust filter: cast both sides to string
      query += ' AND CAST(l.assigned_to AS CHAR) = CAST(? AS CHAR)';
      params.push(String(assigned_to));
    }
    if (start_date) { query += ' AND l.created_at >= ?'; params.push(start_date + ' 00:00:00'); }
    if (end_date) { query += ' AND l.created_at <= ?'; params.push(end_date + ' 23:59:59'); }
    if (search) {
      query += ` AND (l.name LIKE ? OR l.email LIKE ? OR l.phone LIKE ? OR l.message LIKE ?)`;
      const like = `%${search}%`;
      params.push(like, like, like, like);
    }

    query += ' ORDER BY l.created_at DESC';

    // Debug log: print query and params
    console.log('Leads GET query:', query);
    console.log('Leads GET params:', params);

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    const [countRows] = await pool.execute(`SELECT COUNT(*) as total FROM leads l WHERE 1=1` + query.split('WHERE 1=1')[1].split(' ORDER BY')[0], params);
    const total = countRows[0]?.total || 0;

    // Data page
    let [rows] = await pool.execute(query + ` LIMIT ${limitNum} OFFSET ${offset}`, params);

    // Auto-assign unassigned leads (optimized: batch UPDATE + selective staff JOIN)
    const unassignedIds = rows.filter(lead => !lead.assigned_to).map(l => l.id);
    if (unassignedIds.length > 0) {
      // Get a single least-loaded telecaller once (not per lead)
      const assignedTelecaller = await getRandomPresentTelecaller();
      if (assignedTelecaller) {
        // Batch UPDATE all unassigned leads in one query (not N separate queries)
        const placeholders = unassignedIds.map(() => '?').join(',');
        await pool.execute(
          `UPDATE leads SET assigned_to = ?, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
          [assignedTelecaller, ...unassignedIds]
        );
        
        // Fetch staff details only for the newly assigned leads (one JOIN query)
        const [staffInfo] = await pool.execute(
          `SELECT s.id, s.full_name, s.phone, s.email, s.department, s.designation 
           FROM staff s WHERE s.id = ?`,
          [assignedTelecaller]
        );
        const staffData = staffInfo[0];
        
        // Update rows in-memory with staff details (avoids re-fetching entire result set)
        rows = rows.map(lead => {
          if (unassignedIds.includes(lead.id)) {
            return {
              ...lead,
              assigned_to: assignedTelecaller,
              assigned_name: staffData?.full_name,
              assigned_phone: staffData?.phone,
              assigned_email: staffData?.email,
              assigned_staff_department: staffData?.department,
              assigned_staff_designation: staffData?.designation,
              assigned_staff_phone: staffData?.phone,
              assigned_staff_email: staffData?.email
            };
          }
          return lead;
        });
      }
    }

    // Add aliases for frontend compatibility
    const leads = rows.map(lead => ({
      ...lead,
      assigned_staff_phone: lead.assigned_staff_phone || lead.assigned_phone,
      assigned_staff_email: lead.assigned_staff_email || lead.assigned_email
      // department/designation already aliased
    }));
    res.json({ total, page: pageNum, limit: limitNum, leads });
  } catch (error) {
    logger.error('Error fetching leads:', error);
    res.status(500).json({ error: 'Server error fetching leads' });
  }
});

// GET /statistics - counts by source/status (admin OR staff with restricted view)
router.get('/statistics', auth, async (req, res) => {
  try {
    // Allow both admin and staff to view statistics (site-wide)
    if (req.user.role === 'admin' || req.user.role === 'staff') {
      const [bySource] = await pool.execute(`
        SELECT source, COUNT(*) as count
        FROM leads
        GROUP BY source
        ORDER BY count DESC
      `);
      const [byStatus] = await pool.execute(`
        SELECT status, COUNT(*) as count
        FROM leads
        GROUP BY status
      `);
      return res.json({ bySource, byStatus });
    }

    return res.status(403).json({ error: 'Admin access required' });
  } catch (error) {
    logger.error('Error fetching leads statistics:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /:id - get single lead by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    let [rows] = await pool.execute(`
      SELECT l.*, 
        s.full_name AS assigned_name, 
        s.phone AS assigned_phone, 
        s.email AS assigned_email, 
        s.department AS assigned_staff_department, 
        s.designation AS assigned_staff_designation
      FROM leads l
      LEFT JOIN staff s ON l.assigned_to = s.id
      WHERE l.id = ?
    `, [id]);
    if (rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }
    let lead = rows[0];
    // If not assigned, auto-assign now
    if (!lead.assigned_to) {
      const assignedTelecaller = await getRandomPresentTelecaller();
      if (assignedTelecaller) {
        await pool.execute('UPDATE leads SET assigned_to = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [assignedTelecaller, id]);
        // Re-fetch with staff join
        [rows] = await pool.execute(`
          SELECT l.*, 
            s.full_name AS assigned_name, 
            s.phone AS assigned_phone, 
            s.email AS assigned_email, 
            s.department AS assigned_staff_department, 
            s.designation AS assigned_staff_designation
          FROM leads l
          LEFT JOIN staff s ON l.assigned_to = s.id
          WHERE l.id = ?
        `, [id]);
        lead = rows[0];
      }
    }
    // Add aliases for frontend compatibility
    lead.assigned_staff_phone = lead.assigned_phone;
    lead.assigned_staff_email = lead.assigned_email;
    lead.assigned_staff_department = lead.assigned_staff_department || lead.department;
    lead.assigned_staff_designation = lead.assigned_staff_designation || lead.designation;
    res.json(lead);
  } catch (error) {
    logger.error('Error fetching lead:', error);
    res.status(500).json({ error: 'Server error fetching lead' });
  }
});

// POST / - create manual lead (admin)
router.post('/', auth, requireAdmin, async (req, res) => {
  try {
    const {
      name, email, phone, message,
      source, campaign, platform_id,
      property_id, plot_id,
      utm_source, utm_medium, utm_campaign, utm_term, utm_content,
      status = 'new', assigned_to = null, metadata
    } = req.body;

    if (!name && !phone && !email) {
      return res.status(400).json({ error: 'At least one of name, phone, or email is required' });
    }

    const normSource = normalizeSource(source);

    // Auto-assign to present telecaller in sales department if not provided
    let assignedTelecaller = assigned_to;
    if (!assigned_to) {
      assignedTelecaller = await getRandomPresentTelecaller();
    }

    const [result] = await pool.execute(`
      INSERT INTO leads
      (name, email, phone, message, source, campaign, platform_id, property_id, plot_id, status, assigned_to,
       utm_source, utm_medium, utm_campaign, utm_term, utm_content, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      name || null, email || null, phone || null, message || null, normSource, campaign || null, platform_id || null,
      property_id || null, plot_id || null, status, assignedTelecaller, utm_source || null, utm_medium || null,
      utm_campaign || null, utm_term || null, utm_content || null, metadata ? JSON.stringify(metadata) : null
    ]);

    const [rows] = await pool.execute('SELECT * FROM leads WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (error) {
    logger.error('Error creating lead:', error);
    res.status(500).json({ error: 'Server error creating lead' });
  }
});

// PUT /:id - update lead (admin)
router.put('/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;

    // Fetch current lead to get old status
    const [currentRows] = await pool.execute('SELECT * FROM leads WHERE id = ?', [id]);
    if (currentRows.length === 0) return res.status(404).json({ error: 'Lead not found' });
    const currentLead = currentRows[0];
    const oldStatus = currentLead.status;

    const fields = ['name','email','phone','message','source','campaign','platform_id','property_id','plot_id','status','assigned_to','utm_source','utm_medium','utm_campaign','utm_term','utm_content','metadata'];
    const sets = [];
    const params = [];
    for (const f of fields) {
      if (req.body.hasOwnProperty(f)) {
        if (f === 'source') {
          sets.push('source = ?');
          params.push(normalizeSource(req.body[f]));
        } else if (f === 'metadata' && req.body[f] && typeof req.body[f] === 'object') {
          sets.push('metadata = ?');
          params.push(JSON.stringify(req.body[f]));
        } else {
          sets.push(`${f} = ?`);
          params.push(req.body[f]);
        }
      }
    }
    if (sets.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    params.push(id);
    await pool.execute(`UPDATE leads SET ${sets.join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, params);

    // Fetch updated lead
    const [rows] = await pool.execute('SELECT * FROM leads WHERE id = ?', [id]);
    const updatedLead = rows[0];
    const newStatus = updatedLead.status;

    // Send Facebook event if status changed
    await sendLeadEvent(updatedLead, oldStatus, newStatus);

    res.json(updatedLead);
  } catch (error) {
    logger.error('Error updating lead:', error);
    res.status(500).json({ error: 'Server error updating lead' });
  }
});

// DELETE /:id - delete lead (admin)
router.delete('/:id', auth, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const [rows] = await pool.execute('SELECT id FROM leads WHERE id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Lead not found' });
    await pool.execute('DELETE FROM leads WHERE id = ?', [id]);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting lead:', error);
    res.status(500).json({ error: 'Server error deleting lead' });
  }
});

// ------------------------------
// Lead Conversations Endpoints
// GET /:id/conversations - list conversations for a lead
router.get('/:id/conversations', auth, async (req, res) => {
  try {
    const { id } = req.params;
    // Verify lead exists
    const [leadRows] = await pool.execute('SELECT id FROM leads WHERE id = ?', [id]);
    if (leadRows.length === 0) return res.status(404).json({ error: 'Lead not found' });

    const [rows] = await pool.execute(
      'SELECT id, lead_id, conversation_date, conversation_text, staff_id, staff_name, conversation_type, notes, created_at, updated_at FROM lead_conversations WHERE lead_id = ? ORDER BY conversation_date DESC, created_at DESC',
      [id]
    );

    res.json(rows);
  } catch (error) {
    logger.error('Error fetching lead conversations:', error);
    res.status(500).json({ error: 'Server error fetching conversations' });
  }
});

// POST /:id/conversations - add or upsert conversation for a lead (admin/staff)
router.post('/:id/conversations', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { conversation_date, conversation_text, staff_id = null, staff_name = null, conversation_type = 'call', notes = null } = req.body;

    if (!conversation_date || !conversation_text) {
      return res.status(400).json({ error: 'conversation_date and conversation_text are required' });
    }

    // Ensure lead exists
    const [leadRows] = await pool.execute('SELECT id FROM leads WHERE id = ?', [id]);
    if (leadRows.length === 0) return res.status(404).json({ error: 'Lead not found' });

    // Upsert conversation by unique lead_id + conversation_date
    const [existing] = await pool.execute('SELECT id FROM lead_conversations WHERE lead_id = ? AND conversation_date = ?', [id, conversation_date]);
    if (existing.length > 0) {
      const convId = existing[0].id;
      await pool.execute('UPDATE lead_conversations SET conversation_text = ?, staff_id = ?, staff_name = ?, conversation_type = ?, notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [conversation_text, staff_id, staff_name, conversation_type, notes, convId]);
      const [rows] = await pool.execute('SELECT * FROM lead_conversations WHERE id = ?', [convId]);
      return res.json(rows[0]);
    }

    const [result] = await pool.execute(
      'INSERT INTO lead_conversations (lead_id, conversation_date, conversation_text, staff_id, staff_name, conversation_type, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [id, conversation_date, conversation_text, staff_id, staff_name, conversation_type, notes]
    );

    const [rows] = await pool.execute('SELECT * FROM lead_conversations WHERE id = ?', [result.insertId]);
    res.status(201).json(rows[0]);
  } catch (error) {
    logger.error('Error saving lead conversation:', error);
    res.status(500).json({ error: 'Server error saving conversation' });
  }
});

// DELETE /:id/conversations/:conversationId - delete a conversation entry (admin)
router.delete('/:id/conversations/:conversationId', auth, requireAdmin, async (req, res) => {
  try {
    const { id, conversationId } = req.params;
    // Verify lead exists
    const [leadRows] = await pool.execute('SELECT id FROM leads WHERE id = ?', [id]);
    if (leadRows.length === 0) return res.status(404).json({ error: 'Lead not found' });

    const [rows] = await pool.execute('SELECT id FROM lead_conversations WHERE id = ? AND lead_id = ?', [conversationId, id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Conversation not found' });

    await pool.execute('DELETE FROM lead_conversations WHERE id = ?', [conversationId]);
    res.json({ success: true });
  } catch (error) {
    logger.error('Error deleting lead conversation:', error);
    res.status(500).json({ error: 'Server error deleting conversation' });
  }
});

// POST /webhook/facebook - Meta Lead Ads webhook
router.post('/webhook/facebook', async (req, res) => {
  try {
    // Use enhanced validation for Meta webhooks
    if (!validateMetaWebhook(req) && !validateWebhook(req)) {
      return res.status(401).json({ error: 'Invalid webhook signature or secret' });
    }

    const { name, full_name, email, phone_number, phone, message, campaign, adset, ad_id, form_id, leadgen_id, property_id, plot_id, utm_source, utm_medium, utm_campaign, utm_term, utm_content } = req.body || {};

    const leadName = extractNameFromBody(req.body) || null;

    let assignedTelecaller = await getRandomPresentTelecaller();
    const [result] = await pool.execute(`
      INSERT INTO leads (name, email, phone, message, source, campaign, platform_id, property_id, plot_id,
                          status, assigned_to, utm_source, utm_medium, utm_campaign, utm_term, utm_content, metadata)
      VALUES (?, ?, ?, ?, 'facebook', ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?)
    `, [
      leadName,
      email || null,
      phone_number || phone || null,
      message || null,
      campaign || adset || null,
      leadgen_id || form_id || ad_id || null,
      property_id || null,
      plot_id || null,
      assignedTelecaller,
      utm_source || 'facebook',
      utm_medium || 'paid_social',
      utm_campaign || campaign || null,
      utm_term || null,
      utm_content || null,
      JSON.stringify({
        raw: req.body,
        webhook_source: 'facebook',
        received_at: new Date().toISOString()
      })
    ]);

    res.status(201).json({ success: true, id: result.insertId });
  } catch (error) {
    logger.error('FB webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// POST /webhook/instagram - Instagram Lead Ads webhook (uses same format as Facebook)
router.post('/webhook/instagram', async (req, res) => {
  try {
    if (!validateMetaWebhook(req) && !validateWebhook(req)) {
      return res.status(401).json({ error: 'Invalid webhook signature or secret' });
    }

    const { name, full_name, email, phone_number, phone, message, campaign, adset, ad_id, form_id, leadgen_id, property_id, plot_id, utm_source, utm_medium, utm_campaign, utm_term, utm_content } = req.body || {};

    const leadName = extractNameFromBody(req.body) || null;

    let assignedTelecaller = await getRandomPresentTelecaller();
    const [result] = await pool.execute(`
      INSERT INTO leads (name, email, phone, message, source, campaign, platform_id, property_id, plot_id,
                          status, assigned_to, utm_source, utm_medium, utm_campaign, utm_term, utm_content, metadata)
      VALUES (?, ?, ?, ?, 'instagram', ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?)
    `, [
      leadName,
      email || null,
      phone_number || phone || null,
      message || null,
      campaign || adset || null,
      leadgen_id || form_id || ad_id || null,
      property_id || null,
      plot_id || null,
      assignedTelecaller,
      utm_source || 'instagram',
      utm_medium || 'paid_social',
      utm_campaign || campaign || null,
      utm_term || null,
      utm_content || null,
      JSON.stringify({
        raw: req.body,
        webhook_source: 'instagram',
        received_at: new Date().toISOString()
      })
    ]);

    res.status(201).json({ success: true, id: result.insertId });
  } catch (error) {
    logger.error('Instagram webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// POST /webhook/google - Google Ads Lead Form webhook
router.post('/webhook/google', async (req, res) => {
  try {
    if (!validateWebhook(req)) return res.status(401).json({ error: 'Invalid webhook secret' });

    const { name, full_name, email, phone, message, campaign, creative_id, gclid, form_id, property_id, utm_source, utm_medium, utm_campaign, utm_term, utm_content } = req.body || {};

    const leadName = extractNameFromBody(req.body) || null;

    let assignedTelecaller = await getRandomPresentTelecaller();
    const [result] = await pool.execute(`
      INSERT INTO leads (name, email, phone, message, source, campaign, platform_id, property_id,
                          status, assigned_to, utm_source, utm_medium, utm_campaign, utm_term, utm_content, metadata)
      VALUES (?, ?, ?, ?, 'google', ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?)
    `, [
      leadName,
      email || null,
      phone || null,
      message || null,
      campaign || null,
      form_id || creative_id || gclid || null,
      property_id || null,
      assignedTelecaller,
      utm_source || 'google',
      utm_medium || 'cpc',
      utm_campaign || campaign || null,
      utm_term || null,
      utm_content || null,
      JSON.stringify({
        raw: req.body,
        webhook_source: 'google',
        received_at: new Date().toISOString()
      })
    ]);

    res.status(201).json({ success: true, id: result.insertId });
  } catch (error) {
    logger.error('Google webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// POST /submit - public endpoint for website lead form
router.post('/submit', async (req, res) => {
  try {
    const { name, email, phone, message } = req.body;

    // Allow submission when name is split into first/last or present in other fields
    const leadName = extractNameFromBody(req.body) || name || null;

    if (!leadName || !email || !phone) {
      return res.status(400).json({ error: 'Name, email, and phone are required' });
    }

    let assignedTelecaller = await getRandomPresentTelecaller();
    const [result] = await pool.execute(`
      INSERT INTO leads (name, email, phone, message, source, status, assigned_to, utm_source, utm_medium)
      VALUES (?, ?, ?, ?, 'website', 'new', ?, 'website', 'organic')
    `, [leadName, email, phone, message || null, assignedTelecaller]);

    res.status(201).json({
      success: true,
      message: 'Lead submitted successfully',
      id: result.insertId
    });
  } catch (error) {
    logger.error('Lead submit error:', error);
    res.status(500).json({ error: 'Failed to submit lead' });
  }
});

// POST /webhook/generic - for other sources (YouTube, Instagram, etc.)
router.post('/webhook/generic', async (req, res) => {
  try {
    if (!validateWebhook(req)) return res.status(401).json({ error: 'Invalid webhook secret' });

    const { name, email, phone, message, source, campaign, platform_id, property_id, plot_id,
      utm_source, utm_medium, utm_campaign, utm_term, utm_content } = req.body || {};

    const src = normalizeSource(source);

    let assignedTelecaller = await getRandomPresentTelecaller();
    const [result] = await pool.execute(`
      INSERT INTO leads (name, email, phone, message, source, campaign, platform_id, property_id, plot_id,
                          status, assigned_to, utm_source, utm_medium, utm_campaign, utm_term, utm_content, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?, ?)
    `, [
      name || null,
      email || null,
      phone || null,
      message || null,
      src,
      campaign || null,
      platform_id || null,
      property_id || null,
      plot_id || null,
      assignedTelecaller,
      utm_source || src,
      utm_medium || null,
      utm_campaign || campaign || null,
      utm_term || null,
      utm_content || null,
      JSON.stringify({
        raw: req.body,
        webhook_source: src,
        received_at: new Date().toISOString()
      })
    ]);

    res.status(201).json({ success: true, id: result.insertId });
  } catch (error) {
    logger.error('Generic webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});


// ✅ Meta Webhook Verification (GET)
router.get('/webhook/meta', (req, res) => {
  const VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN || 'fb_lead_webhook_secret_2024_xyz123'; // Use same token you entered on Meta

  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('✅ Meta webhook verified successfully!');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Meta webhook verification failed!');
    res.sendStatus(403);
  }
});


// POST /webhook/meta - Universal Meta Instant Forms webhook (recommended for Instant Forms)
router.post('/webhook/meta', async (req, res) => {
  try {
    // Use enhanced Meta validation
    if (!validateMetaWebhook(req) && !validateWebhook(req)) {
      return res.status(401).json({ error: 'Invalid webhook signature or secret' });
    }

    const body = req.body;

    // Facebook Page webhooks send a wrapper: { object: 'page', entry: [ { changes: [ { field: 'leadgen', value: { leadgen_id, ... } } ] } ] }
    // Normalize to an array of lead-like objects that we can process below.
    let leads = [];

    if (body && body.object === 'page' && Array.isArray(body.entry)) {
      // Iterate entries and changes and fetch lead details when only IDs are provided
      for (const entry of body.entry) {
        if (!entry || !Array.isArray(entry.changes)) continue;
        for (const ch of entry.changes) {
          const val = ch.value || {};
          // Possible ID fields
          const leadgenId = val.leadgen_id || val.lead_id || val.id || val.leadId || val.leadGenId;
          // If the change already contains field data inline, use it; otherwise try to fetch
          if (val.field_data || val.data || val.form_response || val.full_name || val.first_name) {
            leads.push(Object.assign({}, val));
          } else if (leadgenId) {
            // Fetch details from Graph API
            const fetched = await fetchLeadFromFacebook(leadgenId);
            if (fetched) {
              // Normalize fetched into expected shape
              const normalized = { ...fetched };
              // Some responses include field_data as array; keep it
              normalized.lead_id = leadgenId;
              leads.push(normalized);
            } else {
              // Push minimal info so we still record something
              leads.push({ leadgen_id: leadgenId, page_id: val.page_id || entry.id });
            }
          } else {
            // Unknown change value: store raw
            leads.push({ raw_change: val });
          }
        }
      }
    } else {
      // Handle both single lead and batch leads (legacy format)
      leads = Array.isArray(body) ? body : [body];
    }

    const results = [];

    for (const leadData of leads) {
      const {
        name, full_name, email, phone_number, phone, message,
        campaign, adset, ad_id, form_id, leadgen_id,
        property_id, plot_id,
        utm_source, utm_medium, utm_campaign, utm_term, utm_content,
        lead_id, // Meta's lead ID
        page_id, // Facebook Page ID
        adgroup_id
      } = leadData;

      // Determine source based on available data
      let source = 'facebook';
      if (page_id && !ad_id) source = 'instagram'; // Instagram leads don't have ad_id
      if (leadData.platform === 'instagram') source = 'instagram';

      const leadName = extractNameFromBody(leadData) || null;

      const [result] = await pool.execute(`
        INSERT INTO leads (name, email, phone, message, source, campaign, platform_id, property_id, plot_id,
                            status, utm_source, utm_medium, utm_campaign, utm_term, utm_content, metadata)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, ?, ?, ?, ?, ?)
      `, [
        leadName,
        email || null,
        phone_number || phone || null,
        message || null,
        source,
        campaign || adset || null,
        lead_id || leadgen_id || form_id || ad_id || null, // Use lead_id as platform_id
        property_id || null,
        plot_id || null,
        utm_source || source,
        utm_medium || 'paid_social',
        utm_campaign || campaign || null,
        utm_term || null,

        utm_content || null,
        JSON.stringify({
          raw: leadData,
          webhook_source: 'meta_instant_forms',
          received_at: new Date().toISOString(),
          page_id,
          adgroup_id,
          lead_id
        })
      ]);
      results.push(result);
    }

    res.status(201).json({
      success: true,
      message: `Processed ${results.length} lead(s)`,
      results
    });

  } catch (error) {
    logger.error('Meta Instant Forms webhook error:', error);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});



module.exports = router;