// Middleware to check if user is an admin
module.exports = function(req, res, next) {
  // User should already be authenticated by the auth middleware
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  // Allow admin, sub-admin, or sales department
  if (!(req.user.role === 'admin' || req.user.originalRole === 'sub-admin' || req.user.department === 'sales')) {
    return res.status(403).json({ error: 'Admin or sales access required' });
  }

  // User is authorized, proceed
  next();
};