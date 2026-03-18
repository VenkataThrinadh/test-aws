const nodemailer = require('nodemailer');
const logger = require('../utils/logger');
const mockEmailService = require('./mockEmailService');
const { createOptimizedVerificationTemplate } = require('../optimized-email-template');
// FALLBACK: If optimized-email-template fails to load, use inline template
const createOptimizedVerificationTemplateFallback = (email, token, userId, baseUrl, apiUrl) => {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9f9f9;">
      <div style="background-color: #ffffff; padding: 30px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #007AFF; margin: 0; font-size: 28px;">🏡 Real Estate App</h1>
          <p style="color: #666; margin: 10px 0 0 0; font-size: 16px;">Welcome to your property journey! [v2.0-FALLBACK-INLINE]</p>
        </div>
        
        <div style="background: linear-gradient(135deg, #007AFF 0%, #0056D3 100%); color: white; padding: 25px; border-radius: 8px; text-align: center; margin: 20px 0;">
          <h2 style="margin: 0 0 15px 0; font-size: 24px;">Complete Your Registration</h2>
          <p style="margin: 0; font-size: 16px; opacity: 0.9;">Choose your preferred verification method below</p>
        </div>
        
        <div style="text-align: center; margin: 30px 0;">
          <a href="${apiUrl}/api/auth/verify-email?token=${token}&userId=${userId}" 
             style="background-color: #007AFF; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-size: 16px; font-weight: 600; display: inline-block; box-shadow: 0 4px 12px rgba(0, 122, 255, 0.3); margin: 5px 10px;">
            🌐 Verify via Web
          </a>
          
          <a href="${apiUrl}/api/auth/verify-mobile?token=${token}&userId=${userId}&email=${encodeURIComponent(email)}" 
             style="background-color: #34C759; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-size: 16px; font-weight: 600; display: inline-block; box-shadow: 0 4px 12px rgba(52, 199, 89, 0.3); margin: 5px 10px;">
            📱 Verify via Mobile
          </a>
        </div>
        
        <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #f0f0f0;">
          <p style="color: #999; font-size: 12px; margin: 0;">
            Real Estate App Team<br>
            <a href="mailto:noreply@cewealthzen.com" style="color: #007AFF; text-decoration: none;">noreply@cewealthzen.com</a>
          </p>
        </div>
      </div>
    </div>
  `;
};
require('dotenv').config();

// Create a transporter object with improved configuration for webmail
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.EMAIL_PORT) || 587,
  secure: process.env.EMAIL_SECURE === 'true', // false for 587, true for 465
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD,
  },
  // Optimized configuration for webmail servers
  tls: {
    rejectUnauthorized: false, // Accept self-signed certificates (important for webmail)
    ciphers: 'SSLv3', // Use compatible cipher for webmail
    secureProtocol: 'TLSv1_2_method' // Force TLS 1.2 for better compatibility
  },
  connectionTimeout: 60000, // 60 seconds for webmail servers
  greetingTimeout: 30000, // 30 seconds for webmail servers
  socketTimeout: 60000, // 60 seconds for webmail servers
  // Remove pool for more reliable single connections
  pool: false,
  // Enable debug in development
  logger: process.env.NODE_ENV === 'development',
  debug: process.env.NODE_ENV === 'development',
  // Additional webmail compatibility settings
  requireTLS: process.env.EMAIL_SECURE === 'true',
  ignoreTLS: false
});

// Create alternative transporters for better reliability
const alternativeTransporters = [
  // Alternative webmail configuration (port 587)
  nodemailer.createTransport({
    host: process.env.EMAIL_HOST,
    port: 587,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASSWORD,
    },
    tls: {
      rejectUnauthorized: false,
      ciphers: 'SSLv3'
    },
    connectionTimeout: 60000,
    greetingTimeout: 30000,
    socketTimeout: 60000,
  }),
  
  // Gmail fallback
  nodemailer.createTransport({
    host: process.env.FALLBACK_EMAIL_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.FALLBACK_EMAIL_PORT) || 587,
    secure: process.env.FALLBACK_EMAIL_SECURE === 'true',
    auth: {
      user: process.env.FALLBACK_EMAIL_USER,
      pass: process.env.FALLBACK_EMAIL_PASSWORD,
    },
    tls: {
      rejectUnauthorized: false,
      ciphers: 'SSLv3'
    },
    connectionTimeout: 30000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  }),
  
  // Gmail with SSL (alternative)
  nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: {
      user: process.env.FALLBACK_EMAIL_USER,
      pass: process.env.FALLBACK_EMAIL_PASSWORD,
    },
    tls: {
      rejectUnauthorized: false,
      ciphers: 'SSLv3'
    },
    connectionTimeout: 30000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  })
];

// Test SMTP connection on startup
const testEmailConnection = async (useTransporter = transporter) => {
  try {
    await useTransporter.verify();
    logger.dev('✅ Email service connected successfully');
    return { success: true, transporter: useTransporter };
  } catch (error) {
    logger.error('❌ Email service connection failed:', error.message);
    logger.dev('Email configuration:', {
      host: process.env.EMAIL_HOST,
      port: process.env.EMAIL_PORT,
      user: process.env.EMAIL_USER ? '***configured***' : 'NOT SET',
      password: process.env.EMAIL_PASSWORD ? '***configured***' : 'NOT SET'
    });
    return { success: false, error: error.message };
  }
};

// Cache for working transporter to avoid repeated testing
let cachedWorkingTransporter = null;
let lastTransporterTest = 0;
const TRANSPORTER_CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

// Get working transporter (optimized with caching)
const getWorkingTransporter = async () => {
  const now = Date.now();
  
  // Use cached transporter if it's still valid (within 5 minutes)
  if (cachedWorkingTransporter && (now - lastTransporterTest) < TRANSPORTER_CACHE_DURATION) {
    return cachedWorkingTransporter;
  }
  
  // Try primary transporter first
  const primaryTest = await testEmailConnection(transporter);
  if (primaryTest.success) {
    cachedWorkingTransporter = transporter;
    lastTransporterTest = now;
    return transporter;
  }
  
  // Try alternative transporters if primary fails
  logger.dev('Primary email service failed, trying alternatives...');
  
  for (let i = 0; i < alternativeTransporters.length; i++) {
    const altTransporter = alternativeTransporters[i];
    logger.dev(`Trying alternative transporter ${i + 1}...`);
    
    const altTest = await testEmailConnection(altTransporter);
    if (altTest.success) {
      logger.dev(`Using alternative email service ${i + 1}`);
      cachedWorkingTransporter = altTransporter;
      lastTransporterTest = now;
      return altTransporter;
    }
  }
  
  // If all fail, return primary for error handling
  logger.error('All email services failed');
  cachedWorkingTransporter = transporter;
  lastTransporterTest = now;
  return transporter;
};

// Test connection on module load (only in development)
if (process.env.NODE_ENV === 'development') {
  testEmailConnection();
}

/**
 * Robust email sending with multiple transporter attempts
 * @param {Object} mailOptions - Email options
 * @returns {Promise} - Email send result
 */
const sendEmailWithRetry = async (mailOptions) => {
  const transportersToTry = [
    // Primary webmail transporter
    transporter,
    // Alternative webmail configurations
    ...alternativeTransporters
  ];

  let lastError = null;
  
  for (let i = 0; i < transportersToTry.length; i++) {
    const currentTransporter = transportersToTry[i];
    const transporterName = i === 0 ? 'Primary Webmail' : `Alternative ${i}`;
    
    try {
      logger.dev(`📧 Trying ${transporterName} for email to:`, mailOptions.to);
      
      // Test connection first
      await currentTransporter.verify();
      logger.dev(`✅ ${transporterName} connection verified`);
      
      // Send email
      const result = await currentTransporter.sendMail(mailOptions);
      logger.dev(`✅ Email sent successfully via ${transporterName}:`, result.messageId);
      
      return result;
    } catch (error) {
      lastError = error;
      logger.error(`❌ ${transporterName} failed:`, error.message);
      
      // Continue to next transporter
      continue;
    }
  }
  
  // If all transporters fail, throw the last error
  throw new Error(`All email transporters failed. Last error: ${lastError.message}`);
};

/**
 * Send an email
 * @param {Object} options - Email options
 * @param {string} options.to - Recipient email
 * @param {string} options.subject - Email subject
 * @param {string} options.html - Email HTML content
 * @param {string} options.text - Email text content (fallback)
 * @returns {Promise} - Nodemailer send result
 */
const sendEmail = async (options) => {
  try {
    // Validate required options
    if (!options.to || !options.subject || !options.html) {
      throw new Error('Missing required email options: to, subject, or html');
    }

    const mailOptions = {
      from: `"${process.env.EMAIL_FROM_NAME || 'Real Estate App'}" <${process.env.EMAIL_FROM || process.env.EMAIL_USER}>`,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text || options.html.replace(/<[^>]*>/g, ''), // Strip HTML tags for text version
      // Add custom headers if provided
      ...(options.headers && { headers: options.headers }),
      // Add reply-to for better deliverability
      replyTo: process.env.EMAIL_FROM || process.env.EMAIL_USER,
      // Add message priority
      priority: 'high'
    };
    
    logger.dev('📧 Attempting to send email to:', options.to);
    
    // Production-optimized email sending with webmail fallback
    const emailTransporters = [
      // Primary webmail transporter
      {
        name: 'Primary Webmail',
        transporter: transporter
      },
      // Alternative webmail configuration (port 587)
      {
        name: 'Alternative Webmail (587)',
        transporter: nodemailer.createTransport({
          host: process.env.EMAIL_HOST,
          port: 587,
          secure: false,
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASSWORD,
          },
          tls: {
            rejectUnauthorized: false,
            ciphers: 'SSLv3'
          },
          connectionTimeout: 60000,
          greetingTimeout: 30000,
          socketTimeout: 60000,
        })
      },
      // Gmail fallback
      {
        name: 'Gmail Fallback',
        transporter: nodemailer.createTransport({
          host: process.env.FALLBACK_EMAIL_HOST || 'smtp.gmail.com',
          port: parseInt(process.env.FALLBACK_EMAIL_PORT) || 587,
          secure: process.env.FALLBACK_EMAIL_SECURE === 'true',
          auth: {
            user: process.env.FALLBACK_EMAIL_USER,
            pass: process.env.FALLBACK_EMAIL_PASSWORD,
          },
          tls: {
            rejectUnauthorized: false,
            ciphers: 'SSLv3'
          },
          connectionTimeout: 30000,
          greetingTimeout: 15000,
          socketTimeout: 30000,
        })
      }
    ];

    let lastError = null;
    
    // Try each transporter in sequence
    for (const { name, transporter: currentTransporter } of emailTransporters) {
      try {
        logger.dev(`📧 Trying ${name} for email to:`, options.to);
        
        const startTime = Date.now();
        const info = await currentTransporter.sendMail(mailOptions);
        const sendTime = Date.now() - startTime;
        
        logger.dev(`📧 Email sent successfully via ${name} in ${sendTime}ms to:`, options.to);
        
        return info;
      } catch (error) {
        lastError = error;
        logger.error(`❌ ${name} failed:`, error.message);
        
        // Continue to next transporter
        continue;
      }
    }
    
    // If all SMTP fails, use mock service as final fallback
    logger.error('All SMTP transporters failed, using mock email service:', lastError.message);
    const mockInfo = await mockEmailService.sendEmail(options);
    
    // Add a flag to indicate this was sent via mock service
    mockInfo.isMockEmail = true;
    mockInfo.originalError = lastError.message;
    
    return mockInfo;
  } catch (error) {
    // Enhanced error logging for better debugging
    logger.error('❌ Error sending email:', error.message);
    logger.dev('Email error details:', {
      code: error.code,
      command: error.command,
      response: error.response,
      responseCode: error.responseCode,
      to: options.to,
      subject: options.subject
    });
    
    // Provide more specific error messages
    if (error.code === 'EAUTH') {
      throw new Error('Email authentication failed. Please check email credentials.');
    } else if (error.code === 'ECONNECTION') {
      throw new Error('Cannot connect to email server. Please check network connection.');
    } else if (error.code === 'ETIMEDOUT') {
      throw new Error('Email sending timed out. Please try again.');
    } else {
      throw new Error(`Email sending failed: ${error.message}`);
    }
  }
};

/**
 * Send a verification email
 * @param {string} email - Recipient email
 * @param {string} token - Verification token
 * @param {string} userId - User ID
 * @returns {Promise} - Email send result
 */
const sendVerificationEmail = async (email, token, userId) => {
  try {
    // Start timing for performance monitoring
    const startTime = Date.now();
    
    // Get the base URL from environment variables - production URL
    const baseUrl = process.env.FRONTEND_URL || 'https://ceinfotech.in';
    
    // Get the API URL for verification - use production URL
    const apiUrl = process.env.API_URL || 'https://api.ceinfotech.in';
    
    // Try to use the separated template file, fall back to inline if it fails
    let html;
    let templateSource = 'OPTIMIZED';
    try {
      logger.info('🔍 Attempting to use optimized template from separate file...');
      html = createOptimizedVerificationTemplate(email, token, userId, baseUrl, apiUrl);
      logger.info('✅ Successfully loaded optimized template from separate file');
    } catch (err) {
      logger.error('❌ Failed to load createOptimizedVerificationTemplate, using inline fallback:', err.message);
      templateSource = 'FALLBACK_INLINE';
      html = createOptimizedVerificationTemplateFallback(email, token, userId, baseUrl, apiUrl);
      logger.info('✅ Using fallback inline template');
    }
    
    // Log which template is being used (for debugging)
    logger.info(`📧 Email template source: ${templateSource}`);

    // Use fast direct email sending to avoid transporter testing delays
    const fromName = process.env.EMAIL_FROM_NAME || 'Real Estate App';
    const fromEmail = process.env.EMAIL_FROM || process.env.EMAIL_USER || 'noreply@cewealthzen.com';

    const mailOptions = {
      from: `"${fromName}" <${fromEmail}>`,
      to: email,
      subject: '🏡 Complete Your Real Estate App Registration',
      html,
      text: html.replace(/<[^>]*>/g, ''), // Strip HTML for text version
      headers: {
        'X-Priority': '1',
        'X-MSMail-Priority': 'High',
        'Importance': 'high',
        'List-Unsubscribe': `<mailto:unsubscribe@${fromEmail.split('@').pop()}>`,
        'X-Mailer': 'Real Estate App v1.0'
      },
      priority: 'high'
    };
    
    // Use robust email sending with multiple transporter attempts
    logger.dev('📧 Sending verification email with retry mechanism...');
    const result = await sendEmailWithRetry(mailOptions);
    logger.dev('📧 Verification email sent successfully:', result.messageId);
    
    const totalTime = Date.now() - startTime;
    logger.dev(`✅ Verification email sent in ${totalTime}ms to:`, email);
    
    // Log successful email sending (non-blocking, after email is sent)
    setImmediate(() => {
      logEmailAttempt(userId, 'verification', email, 'sent', null, result.messageId).catch(err => {
        logger.dev('Email logging failed (non-critical):', err.message);
      });
      updateEmailServiceStatus('ok', new Date().toISOString()).catch(err => {
        logger.dev('Status update failed (non-critical):', err.message);
      });
    });
    
    return result;
  } catch (error) {
    const totalTime = Date.now() - startTime;
    logger.error(`❌ Verification email failed after ${totalTime}ms:`, error.message);
    
    // Log failed email sending (non-blocking, after error handling)
    setImmediate(() => {
      logEmailAttempt(userId, 'verification', email, 'failed', error.message).catch(err => {
        logger.dev('Email logging failed (non-critical):', err.message);
      });
      updateEmailServiceStatus('error').catch(err => {
        logger.dev('Status update failed (non-critical):', err.message);
      });
    });
    
    throw error;
  }
};

/**
 * Send a password reset OTP email with direct, simple approach
 * @param {string} email - Recipient email
 * @param {string} otp - One-time password for verification
 * @returns {Promise} - Email send result
 */
const sendPasswordResetOTPEmail = async (email, otp, userId = null) => {
  try {
    logger.dev('📧 Starting password reset email send to:', email);
    logger.dev('📧 OTP to send:', otp);
    
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #007AFF; margin: 0;">🏡 Real Estate App</h1>
        </div>
        
        <h2 style="color: #333; text-align: center;">Password Reset Request</h2>
        
        <p style="font-size: 16px; color: #333; line-height: 1.6;">
          Hello,<br><br>
          You have requested to reset your password for your Real Estate App account. 
          Please use the following One-Time Password (OTP) to complete the password reset process:
        </p>
        
        <div style="text-align: center; margin: 30px 0; background: linear-gradient(135deg, #007AFF, #0056CC); padding: 30px; border-radius: 12px; box-shadow: 0 4px 15px rgba(0,122,255,0.3);">
          <h1 style="font-size: 36px; letter-spacing: 8px; color: white; margin: 0; font-family: 'Courier New', monospace; text-shadow: 2px 2px 4px rgba(0,0,0,0.3);">${otp}</h1>
          <p style="color: rgba(255,255,255,0.9); margin: 10px 0 0 0; font-size: 14px;">Your 6-digit verification code</p>
        </div>
        
        <div style="background-color: #fff3cd; border: 1px solid #ffeaa7; border-radius: 8px; padding: 15px; margin: 20px 0;">
          <p style="margin: 0; color: #856404; font-size: 14px;">
            ⏰ <strong>Important:</strong> This OTP will expire in 30 minutes for security reasons.
          </p>
        </div>
        
        <p style="font-size: 14px; color: #666; line-height: 1.6;">
          If you did not request a password reset, please ignore this email or contact our support team if you have concerns about your account security.
        </p>
        
        <hr style="border: none; border-top: 1px solid #eee; margin: 30px 0;">
        
        <div style="text-align: center;">
          <p style="color: #999; font-size: 12px; margin: 0;">
            This email was sent by Real Estate App<br>
            © ${new Date().getFullYear()} Real Estate App. All rights reserved.
          </p>
        </div>
      </div>
    `;

    const mailOptions = {
      from: `"Real Estate App" <${process.env.EMAIL_FROM || process.env.EMAIL_USER}>`,
      to: email,
      subject: '🔐 Password Reset OTP - Real Estate App',
      html,
      text: `Password Reset OTP: ${otp}\n\nThis OTP will expire in 30 minutes.\n\nIf you did not request this, please ignore this email.`,
      priority: 'high',
      headers: {
        'X-Priority': '1',
        'X-MSMail-Priority': 'High',
        'Importance': 'high'
      }
    };
    
    logger.dev('📧 Mail options prepared:', {
      from: mailOptions.from,
      to: mailOptions.to,
      subject: mailOptions.subject
    });
    
    // Use robust email sending with multiple transporter attempts
    logger.dev('📧 Sending password reset OTP email with retry mechanism...');
    const result = await sendEmailWithRetry(mailOptions);
    
    logger.dev('📧 Email sent successfully:', {
      messageId: result.messageId,
      response: result.response
    });
    
    // Log successful email sending (non-blocking, after email is sent)
    if (userId) {
      setImmediate(() => {
        logEmailAttempt(userId, 'password_reset', email, 'sent', null, result.messageId).catch(err => {
          logger.dev('Email logging failed (non-critical):', err.message);
        });
      });
    }
    
    return result;
  } catch (error) {
    logger.error('❌ Password reset email failed:', error.message);
    logger.dev('❌ Email error details:', {
      code: error.code,
      command: error.command,
      response: error.response
    });
    
    // Log failed email sending (non-blocking, after error handling)
    if (userId) {
      setImmediate(() => {
        logEmailAttempt(userId, 'password_reset', email, 'failed', error.message).catch(err => {
          logger.dev('Email logging failed (non-critical):', err.message);
        });
      });
    }
    throw error;
  }
};

/**
 * Send a password reset success email
 * @param {string} email - Recipient email
 * @returns {Promise} - Email send result
 */
const sendPasswordResetSuccessEmail = async (email, userId = null) => {
  // Log email attempt as pending (non-blocking)
  if (userId) {
    logEmailAttempt(userId, 'password_reset_success', email, 'pending').catch(err => {
      logger.dev('Email logging failed (non-critical):', err.message);
    });
  }
  
  try {
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <h2 style="color: #007AFF;">Password Reset Successful</h2>
        <p>Your password for the Real Estate App has been successfully reset.</p>
        <p>You can now log in with your new password.</p>
        <p>If you did not make this change, please contact our support team immediately.</p>
        <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
        <p style="color: #999; font-size: 12px;">Real Estate App</p>
      </div>
    `;

    const result = await sendEmail({
      to: email,
      subject: 'Password Reset Successful',
      html,
    });
    
    // Log successful email sending (non-blocking)
    if (userId) {
      logEmailAttempt(userId, 'password_reset_success', email, 'sent', null, result.messageId).catch(err => {
        logger.dev('Email logging failed (non-critical):', err.message);
      });
    }
    
    return result;
  } catch (error) {
    // Log failed email sending (non-blocking)
    if (userId) {
      logEmailAttempt(userId, 'password_reset_success', email, 'failed', error.message).catch(err => {
        logger.dev('Email logging failed (non-critical):', err.message);
      });
    }
    throw error;
  }
};

/**
 * Send customer credentials email when a new customer account is created
 * @param {string} email - Customer's email address
 * @param {string} customerId - Generated customer ID
 * @param {string} customerPassword - Generated customer password
 * @param {string} fullName - Customer's full name
 * @param {string} userId - User ID for logging (optional)
 * @returns {Promise} - Email send result
 */
const sendCustomerCredentialsEmail = async (email, customerId, customerPassword, fullName, userId = null) => {
  // Log email attempt as pending (non-blocking)
  if (userId) {
    logEmailAttempt(userId, 'customer_credentials', email, 'pending').catch(err => {
      logger.dev('Email logging failed (non-critical):', err.message);
    });
  }
  
  try {
    logger.dev('📧 Sending customer credentials email to:', email);
    
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9f9f9;">
        <div style="background-color: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1);">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #2c3e50; margin: 0; font-size: 28px;">🎉 Welcome to Real Estate Portal!</h1>
          </div>
          
          <div style="background-color: #d4edda; border: 1px solid #c3e6cb; border-radius: 5px; padding: 15px; margin-bottom: 20px;">
            <p style="color: #155724; margin: 0; font-weight: bold;">✅ Your customer account has been created successfully!</p>
          </div>
          
          <p style="color: #555; line-height: 1.6; margin-bottom: 20px;">
            Dear ${fullName || 'Valued Customer'},<br><br>
            Welcome to Real Estate Portal! Your customer account has been created and you can now access our platform using the credentials below.
          </p>
          
          <div style="background-color: #f8f9fa; border: 2px solid #007bff; border-radius: 8px; padding: 20px; margin: 25px 0; text-align: center;">
            <h3 style="color: #007bff; margin: 0 0 15px 0; font-size: 18px;">🔑 Your Login Credentials</h3>
            <div style="background-color: white; padding: 15px; border-radius: 5px; margin: 10px 0;">
              <p style="margin: 5px 0; color: #333;"><strong>Customer ID:</strong> <span style="font-family: monospace; font-size: 16px; color: #007bff; font-weight: bold;">${customerId}</span></p>
              <p style="margin: 5px 0; color: #333;"><strong>Password:</strong> <span style="font-family: monospace; font-size: 16px; color: #dc3545; font-weight: bold;">${customerPassword}</span></p>
            </div>
          </div>
          
          <div style="background-color: #fff3cd; border: 1px solid #ffeaa7; border-radius: 5px; padding: 15px; margin: 20px 0;">
            <p style="color: #856404; margin: 0; font-size: 14px;">
              <strong>🔒 Security Notice:</strong> Please keep these credentials safe and secure. We recommend changing your password after your first login.
            </p>
          </div>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="https://ceinfotech.in" 
               style="background-color: #007bff; color: white; padding: 12px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">
              🚀 Login to Your Account
            </a>
          </div>
          
          <div style="background-color: #f8f9fa; border-left: 4px solid #28a745; padding: 15px; margin: 20px 0;">
            <h4 style="color: #155724; margin: 0 0 10px 0;">What you can do with your account:</h4>
            <ul style="color: #495057; margin: 0; padding-left: 20px;">
              <li>Browse and search properties</li>
              <li>Save your favorite properties</li>
              <li>Submit property inquiries</li>
              <li>Manage your profile and preferences</li>
              <li>Get updates on new properties</li>
            </ul>
          </div>
          
          <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #dee2e6;">
            <p style="color: #6c757d; font-size: 14px; margin: 0;">
              Need help? Contact our support team<br>
              <strong>Real Estate Portal</strong><br>
              <em>Your trusted property management platform</em>
            </p>
          </div>
        </div>
      </div>
    `;

    const result = await sendEmailWithRetry({
      from: `"Real Estate Portal" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Welcome! Your Customer Account Credentials - Real Estate Portal',
      html: html
    });
    
    // Log successful email sending (non-blocking)
    if (userId) {
      logEmailAttempt(userId, 'customer_credentials', email, 'sent', null, result.messageId).catch(err => {
        logger.dev('Email logging failed (non-critical):', err.message);
      });
    }
    
    logger.dev('✅ Customer credentials email sent successfully');
    return result;
    
  } catch (error) {
    // Log failed email sending (non-blocking)
    if (userId) {
      logEmailAttempt(userId, 'customer_credentials', email, 'failed', error.message).catch(err => {
        logger.dev('Email logging failed (non-critical):', err.message);
      });
    }
    
    logger.error('❌ Failed to send customer credentials email:', error.message);
    throw error;
  }
};

/**
 * Log email sending attempt to database
 * @param {number} userId - User ID
 * @param {string} emailType - Type of email (verification, password_reset, etc.)
 * @param {string} recipientEmail - Recipient email address
 * @param {string} status - Status (pending, sent, failed)
 * @param {string} errorMessage - Error message if failed
 * @param {string} messageId - Email message ID if sent
 */
// Cache database availability to avoid repeated connection attempts
let isDatabaseAvailable = null;
let lastDatabaseCheck = 0;
const DATABASE_CHECK_INTERVAL = 60000; // Check every minute

const logEmailAttempt = async (userId, emailType, recipientEmail, status, errorMessage = null, messageId = null) => {
  const now = Date.now();
  
  // Check database availability (cached for 1 minute)
  if (isDatabaseAvailable === null || (now - lastDatabaseCheck) > DATABASE_CHECK_INTERVAL) {
    try {
      const { pool } = require('../db');
      // Quick connection test with timeout
      const testQuery = await Promise.race([
        pool.execute('SELECT 1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Database timeout')), 1000))
      ]);
      isDatabaseAvailable = true;
      lastDatabaseCheck = now;
    } catch (error) {
      isDatabaseAvailable = false;
      lastDatabaseCheck = now;
      logger.dev('Database not available for email logging:', error.message);
      return; // Exit early if database is not available
    }
  }
  
  // If database is known to be unavailable, skip logging
  if (!isDatabaseAvailable) {
    logger.dev('Skipping email log - database unavailable');
    return;
  }
  
  // Attempt to log with timeout
  try {
    const { pool } = require('../db');
    await Promise.race([
      pool.execute(
        `INSERT INTO email_logs (user_id, email_type, recipient_email, status, error_message, message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        [userId, emailType, recipientEmail, status, errorMessage, messageId]
      ),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Logging timeout')), 2000))
    ]);
  } catch (error) {
    logger.dev('Failed to log email attempt:', error.message);
    // Mark database as unavailable if logging fails
    isDatabaseAvailable = false;
    lastDatabaseCheck = now;
  }
};

/**
 * Update system configuration for email service status
 * @param {string} status - Email service status (ok, error, unknown)
 * @param {string} lastTest - Last test timestamp
 */
const updateEmailServiceStatus = async (status, lastTest = null) => {
  try {
    const { pool } = require('../db');
    await pool.execute(
      `UPDATE system_config SET config_value = ?, updated_at = NOW() WHERE config_key = 'email_service_status'`,
      [status]
    );
    
    if (lastTest) {
      await pool.execute(
        `UPDATE system_config SET config_value = ?, updated_at = NOW() WHERE config_key = 'email_service_last_test'`,
        [lastTest]
      );
    }
  } catch (error) {
    logger.error('Failed to update email service status:', error.message);
  }
};

module.exports = {
  sendEmail,
  sendVerificationEmail,
  sendPasswordResetOTPEmail,
  sendPasswordResetSuccessEmail,
  sendCustomerCredentialsEmail,
  testEmailConnection,
  logEmailAttempt,
  updateEmailServiceStatus
};