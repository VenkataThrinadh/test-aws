const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');
const logger = require('../utils/logger');
const mockEmailService = require('../services/mockEmailService');

// Test email service endpoint
router.get('/test-email', async (req, res) => {
  try {
    // Create transporter configurations to test (Production Safe)
    const transporters = [
      {
        name: 'Primary Webmail (Creative Ethics)',
        config: {
          host: process.env.EMAIL_HOST,
          port: parseInt(process.env.EMAIL_PORT),
          secure: process.env.EMAIL_SECURE === 'true',
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASSWORD,
          },
          tls: {
            rejectUnauthorized: false,
            ciphers: 'SSLv3'
          }
        }
      },
      {
        name: 'Fallback Gmail',
        config: {
          host: process.env.FALLBACK_EMAIL_HOST,
          port: parseInt(process.env.FALLBACK_EMAIL_PORT),
          secure: process.env.FALLBACK_EMAIL_SECURE === 'true',
          auth: {
            user: process.env.FALLBACK_EMAIL_USER,
            pass: process.env.FALLBACK_EMAIL_PASSWORD,
          },
          tls: {
            rejectUnauthorized: false
          }
        }
      },
      {
        name: 'Alternative Webmail Config',
        config: {
          host: process.env.EMAIL_HOST,
          port: 587,
          secure: false,
          auth: {
            user: process.env.EMAIL_USER,
            pass: process.env.EMAIL_PASSWORD,
          },
          tls: {
            rejectUnauthorized: false
          }
        }
      }
    ];

    const results = [];

    for (const transporterConfig of transporters) {
      try {
        const transporter = nodemailer.createTransporter(transporterConfig.config);
        
        // Test connection
        const startTime = Date.now();
        await transporter.verify();
        const endTime = Date.now();
        
        results.push({
          name: transporterConfig.name,
          status: 'success',
          responseTime: `${endTime - startTime}ms`,
          message: 'Connection successful'
        });
      } catch (error) {
        results.push({
          name: transporterConfig.name,
          status: 'failed',
          error: error.message,
          code: error.code
        });
      }
    }

    // Test DNS resolution for Gmail
    const dns = require('dns').promises;
    let dnsResult = null;
    try {
      const addresses = await dns.resolve4('smtp.gmail.com');
      dnsResult = {
        status: 'success',
        addresses: addresses
      };
    } catch (dnsError) {
      dnsResult = {
        status: 'failed',
        error: dnsError.message
      };
    }

    res.json({
      timestamp: new Date().toISOString(),
      environment: {
        NODE_ENV: process.env.NODE_ENV,
        EMAIL_HOST: process.env.EMAIL_HOST,
        EMAIL_PORT: process.env.EMAIL_PORT,
        EMAIL_USER: process.env.EMAIL_USER ? 'configured' : 'not set',
        EMAIL_PASSWORD: process.env.EMAIL_PASSWORD ? 'configured' : 'not set'
      },
      dnsTest: dnsResult,
      transporterTests: results,
      recommendations: generateRecommendations(results)
    });

  } catch (error) {
    res.status(500).json({
      error: 'Email test failed',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

function generateRecommendations(results) {
  const recommendations = [];
  
  const successfulTransporters = results.filter(r => r.status === 'success');
  const failedTransporters = results.filter(r => r.status === 'failed');
  
  if (successfulTransporters.length === 0) {
    recommendations.push('All email services failed. Check your internet connection and firewall settings.');
    
    const authErrors = failedTransporters.filter(r => r.error && r.error.includes('auth'));
    if (authErrors.length > 0) {
      recommendations.push('Authentication errors detected. Verify EMAIL_USER and EMAIL_PASSWORD are correct.');
      recommendations.push('For Gmail, ensure you are using an App Password, not your regular password.');
    }
    
    const connectionErrors = failedTransporters.filter(r => r.error && (r.error.includes('ECONNREFUSED') || r.error.includes('timeout')));
    if (connectionErrors.length > 0) {
      recommendations.push('Connection errors detected. Check if port 587 or 465 is blocked by your firewall.');
      recommendations.push('Try using a different SMTP service or contact your hosting provider.');
    }
  } else {
    recommendations.push(`${successfulTransporters.length} email service(s) working correctly.`);
    recommendations.push(`Consider using: ${successfulTransporters.map(t => t.name).join(', ')}`);
  }
  
  return recommendations;
}

// Get mock emails for debugging
router.get('/mock-emails', (req, res) => {
  try {
    const sentEmails = mockEmailService.getSentEmails();
    const lastEmail = mockEmailService.getLastEmail();
    
    res.json({
      totalEmails: sentEmails.length,
      lastEmail: lastEmail,
      allEmails: sentEmails.map(email => ({
        to: email.to,
        subject: email.subject,
        timestamp: email.timestamp,
        messageId: email.messageId,
        hasVerificationLink: email.html && email.html.includes('verify')
      }))
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get mock emails',
      message: error.message
    });
  }
});

// Clear mock emails
router.delete('/mock-emails', (req, res) => {
  try {
    mockEmailService.clearSentEmails();
    res.json({ message: 'Mock emails cleared successfully' });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to clear mock emails',
      message: error.message
    });
  }
});

// Create a test user for debugging
router.post('/create-test-user', async (req, res) => {
  try {
    const { email, password, fullName } = req.body;
    
    if (!email || !password || !fullName) {
      return res.status(400).json({
        success: false,
        error: 'Email, password, and fullName are required'
      });
    }
    
    const { pool } = require('../db');
    const bcrypt = require('bcrypt');
    
    // Check if user already exists
    const [existingUser] = await pool.execute(
      'SELECT id, email FROM users WHERE email = ?',
      [email]
    );
    
    if (existingUser.length > 0) {
      return res.json({
        success: false,
        message: 'User already exists',
        userId: existingUser[0].id
      });
    }
    
    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    
    // Create user
    const [result] = await pool.execute(
      `INSERT INTO users (email, password, full_name, email_confirmed, created_at, updated_at) 
       VALUES (?, ?, ?, TRUE, NOW(), NOW())`,
      [email, hashedPassword, fullName]
    );
    
    // Create profile
    await pool.execute(
      `INSERT INTO user_profiles (user_id, phone_number, address, created_at, updated_at) 
       VALUES (?, '', '', NOW(), NOW())`,
      [result.insertId]
    );
    
    res.json({
      success: true,
      message: 'Test user created successfully',
      userId: result.insertId,
      email: email
    });
    
  } catch (error) {
    logger.error('Create test user error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to create test user',
      message: error.message
    });
  }
});

// Test forgot password functionality
router.post('/test-forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email is required for testing'
      });
    }
    
    // Import required services
    const { findUserByEmail, createPasswordResetOTP } = require('../services/verificationService');
    const { sendPasswordResetOTPEmail } = require('../services/emailService');
    const bcrypt = require('bcrypt');
    
    // Check if user exists
    const user = await findUserByEmail(email);
    if (!user) {
      return res.json({
        success: false,
        message: 'User not found',
        testResult: 'User does not exist in database'
      });
    }
    
    // Test OTP generation
    const testPassword = 'TestPassword123';
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(testPassword, salt);
    
    const otp = await createPasswordResetOTP(user.id, hashedPassword);
    
    // Test email sending
    let emailResult = null;
    try {
      await sendPasswordResetOTPEmail(email, otp, user.id);
      emailResult = 'Email sent successfully';
    } catch (emailError) {
      emailResult = `Email failed: ${emailError.message}`;
    }
    
    res.json({
      success: true,
      message: 'Forgot password test completed',
      testResults: {
        userExists: true,
        userId: user.id,
        otpGenerated: !!otp,
        otp: process.env.NODE_ENV === 'development' ? otp : 'Hidden in production',
        emailResult: emailResult
      }
    });
    
  } catch (error) {
    logger.error('Test forgot password error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Test failed',
      message: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Send a test email directly (Production Safe)
router.post('/send-test-email', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email address is required'
      });
    }
    
    const nodemailer = require('nodemailer');
    const logger = require('../utils/logger');
    
    // Create transporter with current environment settings
    const transporter = nodemailer.createTransporter({
      host: process.env.EMAIL_HOST,
      port: parseInt(process.env.EMAIL_PORT),
      secure: process.env.EMAIL_SECURE === 'true',
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
      logger: true,
      debug: true
    });
    
    // Test connection first
    logger.dev('Testing SMTP connection...');
    await transporter.verify();
    logger.dev('SMTP connection verified successfully');
    
    // Send test email
    const mailOptions = {
      from: `"Real Estate App Test" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: '🧪 Test Email - Real Estate App',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #007AFF;">✅ Email Service Test</h2>
          <p>This is a test email from your Real Estate App.</p>
          <p><strong>Sent at:</strong> ${new Date().toLocaleString()}</p>
          <p><strong>From:</strong> ${process.env.EMAIL_HOST}:${process.env.EMAIL_PORT}</p>
          <p><strong>Using:</strong> ${process.env.EMAIL_USER}</p>
          <p>If you received this email, your email service is working correctly! 🎉</p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
          <p style="color: #999; font-size: 12px;">Real Estate App - Email Service Test</p>
        </div>
      `,
      text: `Email Service Test - Real Estate App\n\nThis is a test email sent at ${new Date().toLocaleString()}\n\nIf you received this, your email service is working!`
    };
    
    const result = await transporter.sendMail(mailOptions);
    
    logger.dev('Test email sent successfully:', result.messageId);
    
    res.json({
      success: true,
      message: 'Test email sent successfully',
      messageId: result.messageId,
      response: result.response,
      timestamp: new Date().toISOString()
    });
    
  } catch (error) {
    logger.error('Test email error:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to send test email',
      message: error.message,
      code: error.code,
      command: error.command
    });
  }
});

module.exports = router;