// Email delivery status and troubleshooting endpoint
const express = require('express');
const router = express.Router();
const { sendVerificationEmail } = require('../services/emailService');
const { createVerificationToken } = require('../services/verificationService');
const { pool } = require('../db');
const logger = require('../utils/logger');

/**
 * Check email delivery status and provide troubleshooting
 */
router.post('/check-delivery', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    // Find user by email
    const [userResult] = await pool.execute('SELECT id, email, email_confirmed, created_at FROM users WHERE email = ?', [email]);
    
    if (userResult.length === 0) {
      return res.json({
        success: false,
        message: 'Email address not found in our system',
        suggestions: [
          'Check if you typed the email address correctly',
          'Try registering with this email address',
          'Contact support if you believe this is an error'
        ]
      });
    }
    
    const user = userResult[0];
    
    if (user.email_confirmed) {
      return res.json({
        success: true,
        status: 'verified',
        message: 'Your email is already verified! You can log in now.',
        action: 'login'
      });
    }
    
    // Check how long ago the user registered
    const registrationTime = new Date(user.created_at);
    const now = new Date();
    const timeDiff = now - registrationTime;
    const minutesAgo = Math.floor(timeDiff / (1000 * 60));
    
    let deliveryStatus = 'pending';
    let message = '';
    let suggestions = [];
    
    if (minutesAgo < 5) {
      deliveryStatus = 'recent';
      message = `Registration was ${minutesAgo} minute(s) ago. Email delivery is in progress.`;
      suggestions = [
        'Wait 2-3 more minutes for email delivery',
        'Check your spam/junk folder',
        'Search for emails from: ceteam.web@gmail.com',
        'Check Gmail Promotions and Updates tabs'
      ];
    } else if (minutesAgo < 15) {
      deliveryStatus = 'delayed';
      message = `Registration was ${minutesAgo} minute(s) ago. Email should have arrived by now.`;
      suggestions = [
        'Check spam/junk folder thoroughly',
        'Search for: "Real Estate App" or "ceteam.web@gmail.com"',
        'Check Gmail Promotions and Updates tabs',
        'Add ceteam.web@gmail.com to your contacts',
        'Use the "Resend Email" option below'
      ];
    } else {
      deliveryStatus = 'missing';
      message = `Registration was ${minutesAgo} minute(s) ago. Email delivery may have failed.`;
      suggestions = [
        'Use the "Resend Email" option below',
        'Check all email folders and tabs',
        'Try a different email address',
        'Contact support for manual verification',
        'Ensure your email address is spelled correctly'
      ];
    }
    
    res.json({
      success: true,
      status: deliveryStatus,
      message: message,
      registrationTime: registrationTime.toISOString(),
      minutesAgo: minutesAgo,
      suggestions: suggestions,
      troubleshooting: {
        searchTerms: ['ceteam.web@gmail.com', 'Real Estate App', 'Complete Your Registration'],
        checkLocations: [
          'Primary Inbox',
          'Spam/Junk Folder',
          'Promotions Tab (Gmail)',
          'Updates Tab (Gmail)',
          'Trash/Deleted Items'
        ],
        nextSteps: [
          'Add sender to contacts',
          'Mark as "Not Spam" if found in spam',
          'Check email filters and rules',
          'Try different email provider if issues persist'
        ]
      }
    });
    
  } catch (error) {
    logger.error('Email delivery check failed:', error.message);
    res.status(500).json({
      error: 'Failed to check email delivery status',
      message: 'Please try again or contact support'
    });
  }
});

/**
 * Send a test email to verify delivery
 */
router.post('/test-delivery', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }
    
    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }
    
    const nodemailer = require('nodemailer');
    
    // Create optimized transporter for test
    const transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: parseInt(process.env.EMAIL_PORT),
      secure: process.env.EMAIL_SECURE === 'true',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD,
      },
      tls: { rejectUnauthorized: false },
      connectionTimeout: 10000,
      greetingTimeout: 5000,
      socketTimeout: 10000
    });
    
    const startTime = Date.now();
    
    const result = await transporter.sendMail({
      from: `"Real Estate App" <${process.env.EMAIL_FROM}>`,
      to: email,
      subject: '📧 Email Delivery Test - Real Estate App',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h1 style="color: #007AFF;">📧 Email Delivery Test</h1>
          <p><strong>Test Time:</strong> ${new Date().toISOString()}</p>
          <p><strong>Purpose:</strong> Verify email delivery is working</p>
          
          <div style="background-color: #e8f5e8; padding: 15px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 0; color: #2e7d32; font-weight: 500;">
              ✅ SUCCESS: If you received this email, our email delivery system is working correctly!
            </p>
          </div>
          
          <div style="background-color: #fff3cd; padding: 15px; border-radius: 8px; margin: 20px 0;">
            <p style="margin: 0; color: #856404;">
              <strong>📍 Email Location:</strong> If this email arrived in your spam folder, 
              please mark it as "Not Spam" and add ceteam.web@gmail.com to your contacts.
            </p>
          </div>
          
          <p><strong>Next Steps:</strong></p>
          <ul>
            <li>If this email arrived quickly, verification emails should work too</li>
            <li>If this email went to spam, check spam folder for verification emails</li>
            <li>Add ceteam.web@gmail.com to your contacts for future emails</li>
            <li>Try the registration process again if needed</li>
          </ul>
          
          <p style="color: #666; font-size: 14px; margin-top: 30px;">
            This is a test email. You can safely delete it after reading.
          </p>
        </div>
      `,
      priority: 'high'
    });
    
    const deliveryTime = Date.now() - startTime;
    
    res.json({
      success: true,
      message: 'Test email sent successfully!',
      deliveryTime: deliveryTime,
      messageId: result.messageId,
      response: result.response,
      instructions: [
        'Check your email inbox now',
        'Look for "Email Delivery Test" subject',
        'If not in inbox, check spam folder',
        'Note the delivery time and location',
        'Add ceteam.web@gmail.com to contacts if needed'
      ],
      nextSteps: deliveryTime < 3000 
        ? 'Email delivery is fast! Verification emails should work normally.'
        : 'Email delivery is slower than expected. Check spam folder and email settings.'
    });
    
  } catch (error) {
    logger.error('Test email failed:', error.message);
    res.status(500).json({
      error: 'Failed to send test email',
      message: error.message,
      troubleshooting: [
        'Check your internet connection',
        'Verify email address is correct',
        'Try again in a few minutes',
        'Contact support if problem persists'
      ]
    });
  }
});

module.exports = router;