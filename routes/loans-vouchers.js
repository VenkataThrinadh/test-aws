/**
 * Vouchers API Routes - REMOVED
 *
 * This router is an inert stub that returns 410 Gone for all requests. The active
 * vouchers routes have been removed from the project per request.
 */
const express = require('express');
const router = express.Router();

// This router is intentionally inert — returns 410 for all requests.
router.use((req, res) => {
  res.status(410).json({ success: false, message: 'Vouchers feature is removed from this installation.' });
});

module.exports = router;
// Deprecated: the rest of the implementation has been removed and replaced by an inert router.

