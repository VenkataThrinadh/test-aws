// Simple logger utility to control console output
const isDevelopment = process.env.NODE_ENV === 'development';
const isVerboseLoggingEnabled = process.env.VERBOSE_LOGGING === 'true';

const logger = {
  // Only log in development mode AND when verbose logging is enabled
  dev: (message, ...args) => {
    if (isDevelopment && isVerboseLoggingEnabled) {
      console.log('[DEV]', message, ...args);
    }
  },
  
  // Only log if verbose logging is explicitly enabled
  verbose: (message, ...args) => {
    if (isVerboseLoggingEnabled) {
      console.log('[VERBOSE]', message, ...args);
    }
  },
  
  // Always log errors (critical issues should always be visible)
  error: (message, ...args) => {
    console.error('[ERROR]', message, ...args);
  },
  
  // Always log warnings (important issues should be visible)
  warn: (message, ...args) => {
    console.warn('[WARN]', message, ...args);
  },
  
  // Only log info when verbose logging is enabled
  info: (message, ...args) => {
    if (isVerboseLoggingEnabled) {
      console.info('[INFO]', message, ...args);
    }
  }
};

module.exports = logger;