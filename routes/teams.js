const express = require('express');
const router = express.Router();
const { pool } = require('../db');
const auth = require('../middleware/auth');
const logger = require('../utils/logger');

// List teams with optional project filter
router.get('/', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Not authorized' });

    const { project_id } = req.query;
    let query = `SELECT t.*, p.title as project_name FROM teams t LEFT JOIN properties p ON t.project_id = p.id WHERE 1=1`;
    const params = [];
    if (project_id) {
      query += ` AND t.project_id = ?`;
      params.push(project_id);
    }
    query += ' ORDER BY t.created_at DESC';

    const [teams] = await pool.execute(query, params);

    // Load members for each team
    const teamIds = teams.map(t => t.id);
    let members = [];
    if (teamIds.length > 0) {
      const placeholders = teamIds.map(() => '?').join(',');
      const [rows] = await pool.execute(
        `SELECT m.*, s.full_name, s.email FROM team_members m LEFT JOIN staff s ON m.staff_id = s.id WHERE m.team_id IN (${placeholders})`,
        teamIds
      );
      members = rows;
    }

    const teamsWithMembers = teams.map(t => ({
      ...t,
      members: members.filter(m => m.team_id === t.id)
    }));

    res.json({ teams: teamsWithMembers });
  } catch (error) {
    logger.error('Error fetching teams:', error);
    res.status(500).json({ error: 'Server error fetching teams' });
  }
});

// Get single team by id
router.get('/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Not authorized' });
    const { id } = req.params;
    const [rows] = await pool.execute('SELECT t.*, p.title as project_name FROM teams t LEFT JOIN properties p ON t.project_id = p.id WHERE t.id = ?', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'Team not found' });
    const team = rows[0];
    const [members] = await pool.execute('SELECT m.*, s.full_name, s.email FROM team_members m LEFT JOIN staff s ON m.staff_id = s.id WHERE m.team_id = ?', [id]);
    res.json({ team: { ...team, members } });
  } catch (error) {
    logger.error('Error fetching team:', error);
    res.status(500).json({ error: 'Server error fetching team' });
  }
});

// Create team
router.post('/', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Not authorized' });
    const { name, project_id, department = 'sales', members = [] } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Team name required' });

    const [result] = await pool.execute('INSERT INTO teams (name, project_id, department, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())', [name, project_id || null, department]);
    const teamId = result.insertId;

    // Insert members
    for (const m of members) {
      const { staff_id, role } = m;
      if (!staff_id || !role) continue;
      try {
        await pool.execute('INSERT INTO team_members (team_id, staff_id, role, created_at) VALUES (?, ?, ?, NOW())', [teamId, staff_id, role]);
      } catch (e) {
        // ignore duplicate member errors
      }
    }

    const [newRows] = await pool.execute('SELECT * FROM teams WHERE id = ?', [teamId]);
    res.status(201).json({ team: newRows[0] });
  } catch (error) {
    logger.error('Error creating team:', error);
    res.status(500).json({ error: 'Server error creating team' });
  }
});

// Update team and members
router.put('/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Not authorized' });
    const { id } = req.params;
    const { name, project_id, department = 'sales', members = [] } = req.body;

    await pool.execute('UPDATE teams SET name = COALESCE(?, name), project_id = COALESCE(?, project_id), department = COALESCE(?, department), updated_at = NOW() WHERE id = ?', [name, project_id || null, department, id]);

    // Replace members: simple approach - delete existing and insert provided
    await pool.execute('DELETE FROM team_members WHERE team_id = ?', [id]);
    for (const m of members) {
      const { staff_id, role } = m;
      if (!staff_id || !role) continue;
      await pool.execute('INSERT INTO team_members (team_id, staff_id, role, created_at) VALUES (?, ?, ?, NOW())', [id, staff_id, role]);
    }

    const [updated] = await pool.execute('SELECT * FROM teams WHERE id = ?', [id]);
    res.json({ team: updated[0] });
  } catch (error) {
    logger.error('Error updating team:', error);
    res.status(500).json({ error: 'Server error updating team' });
  }
});

// Delete team
router.delete('/:id', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: 'Not authorized' });
    const { id } = req.params;
    await pool.execute('DELETE FROM team_members WHERE team_id = ?', [id]);
    const [result] = await pool.execute('DELETE FROM teams WHERE id = ?', [id]);
    if (result.affectedRows === 0) return res.status(404).json({ error: 'Team not found' });
    res.json({ message: 'Team deleted' });
  } catch (error) {
    logger.error('Error deleting team:', error);
    res.status(500).json({ error: 'Server error deleting team' });
  }
});

module.exports = router;
