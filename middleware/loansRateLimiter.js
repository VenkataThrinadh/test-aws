/**
 * Rate Limiter Middleware for Loan Endpoints
 * 
 * Applies rate limiting specifically to loan management endpoints
 * to prevent abuse and ensure fair resource usage
 */

const rateLimit = require('express-rate-limit');

/**
 * Rate limiter for loan endpoints
 * Applied to all /api/loans/* routes
 */
const loansLimiter = rateLimit({
  windowMs: parseInt(process.env.LOAN_RATE_LIMIT_WINDOW_MS || '900000'), // 15 minutes default
  max: parseInt(process.env.LOAN_RATE_LIMIT_MAX_REQUESTS || '1000'), // 1000 requests per window
  message: 'Too many requests to loan endpoints, please try again later.',
  standardHeaders: true, // Return rate limit info in RateLimit-* headers
  legacyHeaders: false, // Disable X-RateLimit-* headers
  
  /**
   * Skip rate limiting in development environment
   * Also skip for file serving endpoints (PDFs, images)
   * Allows unrestricted testing during development
   */
  skip: (req, res) => {
    // Skip in development
    if (process.env.NODE_ENV === 'development') return true;
    
    // Skip file serving endpoints for better performance
    if (req.path.includes('/file/')) return true;
    
    return false;
  },
  
  /**
   * Store options - uses default in-memory store
   * For production, consider redis store
   */
  store: undefined, // Uses default MemoryStore
  
  /**
   * Handler when rate limit exceeded
   */
  handler: (req, res) => {
    res.status(429).json({
      success: false,
      message: 'Too many requests to loan endpoints, please try again later.',
      retryAfter: req.rateLimit.resetTime
    });
  }
});

module.exports = loansLimiter;
