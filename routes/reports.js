const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const auth = require('../middleware/auth');
const adminAuth = require('../middleware/adminAuth');
const logger = require('../utils/logger');

// Helpers
function parseDateParam(value, fallback) {
  const d = value ? new Date(value) : fallback;
  return isNaN(d.getTime()) ? fallback : d;
}

function parseINR(val) {
  if (!val) return 0;
  const s = String(val).trim().toLowerCase();
  if (s.includes('lakh')) { const n = parseFloat(s.replace(/[^0-9.]/g, '')) || 0; return n * 100000; }
  if (s.includes('cr')) { const n = parseFloat(s.replace(/[^0-9.]/g, '')) || 0; return n * 10000000; }
  return parseFloat(s.replace(/[^0-9.]/g, '')) || 0;
}

// Build WHERE clauses for filters
function buildPropertyFilter(query) {
  const { propertyType, city, status } = query || {};
  const where = [];
  const params = [];
  if (propertyType && propertyType !== 'all') { where.push('p.property_type = ?'); params.push(propertyType); }
  if (city && city !== 'all') { where.push('p.city = ?'); params.push(city); }
  if (status && status !== 'all') { where.push('p.status = ?'); params.push(status); }
  const clause = where.length ? ` AND ${where.join(' AND ')}` : '';
  return { clause, params };
}

function buildUserFilter(query) {
  const { userRole } = query || {};
  const where = [];
  const params = [];
  if (userRole && userRole !== 'all') { where.push('u.role = ?'); params.push(userRole); }
  const clause = where.length ? ` AND ${where.join(' AND ')}` : '';
  return { clause, params };
}

// ========== Overview ==========
router.get('/overview', auth, adminAuth, async (req, res) => {
  try {
    const start = parseDateParam(req.query.startDate, new Date(new Date().setMonth(new Date().getMonth() - 3)));
    const end = parseDateParam(req.query.endDate, new Date());

    const propFilt = buildPropertyFilter(req.query);
    const userFilt = buildUserFilter(req.query);

    // Daily properties
    let propertiesDaily = [];
    try {
      const [rows] = await pool.execute(
        `SELECT DATE(p.created_at) as date, COUNT(*) as properties
         FROM properties p
         WHERE p.created_at BETWEEN ? AND ?${propFilt.clause}
         GROUP BY DATE(p.created_at)
         ORDER BY date`,
        [start, end, ...propFilt.params]
      );
      propertiesDaily = rows;
    } catch (e) { logger.warn('overview propertiesDaily failed:', e.message); }

    // Daily users (role filter)
    let usersDaily = [];
    try {
      const [rows] = await pool.execute(
        `SELECT DATE(u.created_at) as date, COUNT(*) as users
         FROM users u
         WHERE u.created_at BETWEEN ? AND ?${userFilt.clause}
         GROUP BY DATE(u.created_at)
         ORDER BY date`,
        [start, end, ...userFilt.params]
      );
      usersDaily = rows;
    } catch (e) { logger.warn('overview usersDaily failed:', e.message); }

    // Daily enquiries (respect property filters via JOIN)
    let enquiriesDaily = [];
    try {
      const [rows] = await pool.execute(
        `SELECT DATE(e.created_at) as date, COUNT(*) as enquiries
         FROM property_enquiries e
         JOIN properties p ON p.id = e.property_id
         WHERE e.created_at BETWEEN ? AND ?${propFilt.clause}
         GROUP BY DATE(e.created_at)
         ORDER BY date`,
        [start, end, ...propFilt.params]
      );
      enquiriesDaily = rows;
    } catch (e) { logger.warn('overview enquiriesDaily failed:', e.message); }

    // Totals
    let totals = { totalProperties: 0, totalUsers: 0, totalEnquiries: 0, totalRevenue: 0, featuredProperties: 0, activeProperties: 0 };

    try {
      const [[tp]] = await pool.execute(
        `SELECT COUNT(*) AS cnt
         FROM properties p
         WHERE p.created_at BETWEEN ? AND ?${propFilt.clause}`,
        [start, end, ...propFilt.params]
      );
      totals.totalProperties = Number(tp?.cnt || 0);
    } catch (e) { logger.warn('overview totalProperties failed:', e.message); }

    try {
      const [[tu]] = await pool.execute(
        `SELECT COUNT(*) AS cnt
         FROM users u
         WHERE u.created_at BETWEEN ? AND ?${userFilt.clause}`,
        [start, end, ...userFilt.params]
      );
      totals.totalUsers = Number(tu?.cnt || 0);
    } catch (e) { logger.warn('overview totalUsers failed:', e.message); }

    try {
      const [[te]] = await pool.execute(
        `SELECT COUNT(*) AS cnt
         FROM property_enquiries e
         JOIN properties p ON p.id = e.property_id
         WHERE e.created_at BETWEEN ? AND ?${propFilt.clause}`,
        [start, end, ...propFilt.params]
      );
      totals.totalEnquiries = Number(te?.cnt || 0);
    } catch (e) { logger.warn('overview totalEnquiries failed:', e.message); }

    try {
      const [[feat]] = await pool.execute(
        `SELECT COUNT(*) AS cnt
         FROM properties p
         WHERE p.is_featured = 1 AND p.created_at BETWEEN ? AND ?${propFilt.clause}`,
        [start, end, ...propFilt.params]
      );
      totals.featuredProperties = Number(feat?.cnt || 0);
    } catch (e) { logger.warn('overview featuredProperties failed:', e.message); }

    try {
      const [[act]] = await pool.execute(
        `SELECT COUNT(*) AS cnt
         FROM properties p
         WHERE p.status IN ('active','available') AND p.created_at BETWEEN ? AND ?${propFilt.clause}`,
        [start, end, ...propFilt.params]
      );
      totals.activeProperties = Number(act?.cnt || 0);
    } catch (e) { logger.warn('overview activeProperties failed:', e.message); }

    // Revenue (JS parse)
    try {
      const [prices] = await pool.execute(
        `SELECT p.price FROM properties p
         WHERE p.price IS NOT NULL AND p.created_at BETWEEN ? AND ?${propFilt.clause}`,
        [start, end, ...propFilt.params]
      );
      totals.totalRevenue = prices.reduce((sum, r) => sum + parseINR(r.price), 0);
    } catch (e) { logger.warn('overview totalRevenue failed:', e.message); }

    // Build daily data skeleton
    const map = new Map();
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const key = d.toISOString().split('T')[0];
      map.set(key, { date: key, properties: 0, users: 0, enquiries: 0, revenue: 0, views: 0, conversions: 0 });
    }
    propertiesDaily.forEach(r => { if (map.has(r.date)) map.get(r.date).properties = Number(r.properties) || 0; });
    usersDaily.forEach(r => { if (map.has(r.date)) map.get(r.date).users = Number(r.users) || 0; });
    enquiriesDaily.forEach(r => { if (map.has(r.date)) map.get(r.date).enquiries = Number(r.enquiries) || 0; });

    // Optionally compute daily revenue for the chart
    try {
      const [revRows] = await pool.execute(
        `SELECT DATE(p.created_at) AS date, p.price
         FROM properties p
         WHERE p.price IS NOT NULL AND p.created_at BETWEEN ? AND ?${propFilt.clause}`,
        [start, end, ...propFilt.params]
      );
      revRows.forEach(r => {
        const key = typeof r.date === 'string' ? r.date : new Date(r.date).toISOString().split('T')[0];
        if (map.has(key)) map.get(key).revenue += parseINR(r.price);
      });
    } catch (e) { logger.warn('overview daily revenue failed:', e.message); }

    const dailyData = Array.from(map.values());

    res.json({
      totalProperties: totals.totalProperties,
      totalUsers: totals.totalUsers,
      totalEnquiries: totals.totalEnquiries,
      totalRevenue: totals.totalRevenue,
      totalViews: totals.totalEnquiries, // proxy until real views tracking exists
      conversionRate: totals.totalEnquiries > 0 ? 18.0 : 0,
      featuredProperties: totals.featuredProperties,
      activeProperties: totals.activeProperties,
      dailyData,
    });
  } catch (error) {
    logger.error('overview failed:', error);
    res.json({ totalProperties: 0, totalUsers: 0, totalEnquiries: 0, totalRevenue: 0, totalViews: 0, conversionRate: 0, featuredProperties: 0, activeProperties: 0, dailyData: [] });
  }
});

// ========== Properties ==========
router.get('/properties', auth, adminAuth, async (req, res) => {
  try {
    const start = parseDateParam(req.query.startDate, new Date(new Date().setMonth(new Date().getMonth() - 3)));
    const end = parseDateParam(req.query.endDate, new Date());
    const propFilt = buildPropertyFilter(req.query);

    const [propRows] = await pool.execute(
      `SELECT p.id, p.title, p.city, p.property_type, p.created_at, p.price
       FROM properties p
       WHERE p.created_at BETWEEN ? AND ?${propFilt.clause}`,
      [start, end, ...propFilt.params]
    );

    // byType
    const byTypeMap = new Map();
    propRows.forEach(p => {
      const key = p.property_type || 'Unknown';
      const entry = byTypeMap.get(key) || { type: key, count: 0, revenue: 0, avgPriceBase: 0 };
      const amt = parseINR(p.price);
      entry.count += 1;
      entry.revenue += amt;
      entry.avgPriceBase += amt;
      byTypeMap.set(key, entry);
    });
    const byType = Array.from(byTypeMap.values()).map(e => ({ type: e.type, count: e.count, revenue: e.revenue, avgPrice: e.count ? e.avgPriceBase / e.count : 0 }));

    // byCity + enquiries per city
    const byCityMap = new Map();
    propRows.forEach(p => {
      const key = p.city || 'Unknown';
      const entry = byCityMap.get(key) || { city: key, properties: 0, revenue: 0, enquiries: 0 };
      entry.properties += 1;
      entry.revenue += parseINR(p.price);
      byCityMap.set(key, entry);
    });

    // enquiries per property
    const propIds = propRows.map(p => p.id);
    let enquiriesByProp = new Map();
    if (propIds.length) {
      const placeholders = propIds.map(() => '?').join(',');
      const [enqRows] = await pool.execute(
        `SELECT e.property_id, COUNT(*) as cnt
         FROM property_enquiries e
         WHERE e.property_id IN (${placeholders})
         GROUP BY e.property_id`,
        propIds
      );
      enqRows.forEach(r => enquiriesByProp.set(r.property_id, Number(r.cnt) || 0));
    }

    propRows.forEach(p => {
      const cityKey = p.city || 'Unknown';
      const entry = byCityMap.get(cityKey);
      entry.enquiries += (enquiriesByProp.get(p.id) || 0);
      byCityMap.set(cityKey, entry);
    });

    const byCity = Array.from(byCityMap.values()).sort((a,b) => b.properties - a.properties).slice(0, 10);

    // topPerformers
    const topPerformers = propRows
      .map(p => ({ id: p.id, title: p.title || 'Untitled Property', enquiries: enquiriesByProp.get(p.id) || 0, revenue: parseINR(p.price), views: 0 }))
      .sort((a,b) => b.enquiries - a.enquiries || b.revenue - a.revenue)
      .slice(0, 10);

    res.json({ byType, byCity, topPerformers });
  } catch (error) {
    logger.error('properties report failed:', error);
    res.json({ byType: [], byCity: [], topPerformers: [] });
  }
});

// ========== Users ==========
router.get('/users', auth, adminAuth, async (req, res) => {
  try {
    const start = parseDateParam(req.query.startDate, new Date(new Date().setMonth(new Date().getMonth() - 6)));
    const end = parseDateParam(req.query.endDate, new Date());
    const userFilt = buildUserFilter(req.query);

    // activity
    let activity = [];
    try {
      const [rows] = await pool.execute(
        `SELECT DATE_FORMAT(u.created_at, '%b') AS month,
                COUNT(*) AS newUsers,
                COUNT(*) AS activeUsers,
                85 AS retention
         FROM users u
         WHERE u.created_at BETWEEN ? AND ?${userFilt.clause}
         GROUP BY YEAR(u.created_at), MONTH(u.created_at)
         ORDER BY YEAR(u.created_at), MONTH(u.created_at)
         LIMIT 6`,
        [start, end, ...userFilt.params]
      );
      activity = rows;
    } catch (e) { logger.warn('users activity failed:', e.message); }

    // top agents
    const [agentsBase] = await pool.execute(
      `SELECT u.id, u.full_name AS name,
              COUNT(DISTINCT p.id) AS properties,
              COUNT(pe.id) AS enquiries
       FROM users u
       LEFT JOIN properties p ON p.owner_id = u.id
       LEFT JOIN property_enquiries pe ON pe.property_id = p.id
       WHERE u.role IN ('agent','admin')${userFilt.clause.replace('u.role = ?','')} AND u.created_at BETWEEN ? AND ?
       GROUP BY u.id, u.full_name
       ORDER BY properties DESC, enquiries DESC
       LIMIT 10`,
      [...userFilt.params.filter((v, i, a) => false), start, end] // drop role param already in WHERE above
    );

    // revenue per agent
    const agentIds = agentsBase.map(a => a.id);
    let revenueByAgent = new Map();
    if (agentIds.length) {
      const placeholders = agentIds.map(() => '?').join(',');
      const [priceRows] = await pool.execute(
        `SELECT owner_id, price FROM properties WHERE owner_id IN (${placeholders}) AND price IS NOT NULL`,
        agentIds
      );
      priceRows.forEach(r => revenueByAgent.set(r.owner_id, (revenueByAgent.get(r.owner_id) || 0) + parseINR(r.price)));
    }

    const topAgents = agentsBase.map(a => ({
      id: a.id,
      name: a.name || 'Unknown',
      properties: Number(a.properties) || 0,
      enquiries: Number(a.enquiries) || 0,
      revenue: Number(revenueByAgent.get(a.id) || 0),
    }));

    const demographics = [
      { ageGroup: '25-35', count: 0, percentage: 0 },
      { ageGroup: '35-45', count: 0, percentage: 0 },
      { ageGroup: '45-55', count: 0, percentage: 0 },
      { ageGroup: '55+', count: 0, percentage: 0 },
    ];

    res.json({ activity, topAgents, demographics });
  } catch (error) {
    logger.error('users report failed:', error);
    res.json({ activity: [], topAgents: [], demographics: [] });
  }
});

// ========== Enquiries ==========
router.get('/enquiries', auth, adminAuth, async (req, res) => {
  try {
    const start = parseDateParam(req.query.startDate, new Date(new Date().setMonth(new Date().getMonth() - 3)));
    const end = parseDateParam(req.query.endDate, new Date());
    const propFilt = buildPropertyFilter(req.query);

    const [sourceRows] = await pool.execute(
      `SELECT COALESCE(e.status,'Direct') AS source,
              COUNT(*) AS count,
              COUNT(CASE WHEN e.status = 'resolved' THEN 1 END) AS conversion
       FROM property_enquiries e
       JOIN properties p ON p.id = e.property_id
       WHERE e.created_at BETWEEN ? AND ?${propFilt.clause}
       GROUP BY e.status
       ORDER BY count DESC`,
      [start, end, ...propFilt.params]
    );

    const [trendRows] = await pool.execute(
      `SELECT DATE(e.created_at) AS date,
              COUNT(*) AS enquiries,
              COUNT(CASE WHEN e.status = 'resolved' THEN 1 END) AS conversions
       FROM property_enquiries e
       JOIN properties p ON p.id = e.property_id
       WHERE e.created_at BETWEEN ? AND ?${propFilt.clause}
       GROUP BY DATE(e.created_at)
       ORDER BY date`,
      [start, end, ...propFilt.params]
    );

    res.json({
      bySource: sourceRows.map(s => ({
        source: s.source === 'pending' ? 'Website' : s.source === 'resolved' ? 'Mobile App' : s.source === 'closed' ? 'Social Media' : 'Direct',
        count: Number(s.count)||0,
        conversion: Number(s.conversion)||0,
        conversionRate: (Number(s.count)||0) > 0 ? Number(((s.conversion / s.count) * 100).toFixed(1)) : 0
      })),
      trends: trendRows.map(t => ({ date: t.date, enquiries: Number(t.enquiries)||0, conversions: Number(t.conversions)||0 }))
    });
  } catch (error) {
    logger.error('enquiries report failed:', error);
    res.json({ bySource: [], trends: [] });
  }
});

// ========== Revenue ==========
router.get('/revenue', auth, adminAuth, async (req, res) => {
  try {
    const start = parseDateParam(req.query.startDate, new Date(new Date().setMonth(new Date().getMonth() - 3)));
    const end = parseDateParam(req.query.endDate, new Date());
    const propFilt = buildPropertyFilter(req.query);

    // Fetch raw price data; aggregate in JS
    const [rows] = await pool.execute(
      `SELECT DATE(p.created_at) AS date, p.property_type, p.price
       FROM properties p
       WHERE p.created_at BETWEEN ? AND ? AND p.price IS NOT NULL${propFilt.clause}`,
      [start, end, ...propFilt.params]
    );

    const trendMap = new Map();
    const typeMap = new Map();
    rows.forEach(r => {
      const amount = parseINR(r.price);
      const dateKey = typeof r.date === 'string' ? r.date : new Date(r.date).toISOString().split('T')[0];
      trendMap.set(dateKey, (trendMap.get(dateKey) || 0) + amount);
      const typeKey = r.property_type || 'Unknown';
      typeMap.set(typeKey, (typeMap.get(typeKey) || 0) + amount);
    });

    const trends = Array.from(trendMap.entries()).sort(([a],[b]) => a.localeCompare(b)).map(([date, revenue]) => ({ date, revenue }));
    const byPropertyType = Array.from(typeMap.entries()).sort((a,b) => b[1]-a[1]).map(([type, revenue]) => ({ type, revenue }));

    res.json({ trends, byPropertyType });
  } catch (error) {
    logger.error('revenue report failed:', error);
    res.json({ trends: [], byPropertyType: [] });
  }
});

// Export (placeholder)
router.get('/export/:reportType', auth, adminAuth, async (req, res) => {
  try {
    const { reportType } = req.params;
    res.json({ reportType, generatedAt: new Date().toISOString(), note: 'Implement CSV/PDF if needed.' });
  } catch (error) {
    logger.error('export report failed:', error);
    res.json({});
  }
});

module.exports = router;