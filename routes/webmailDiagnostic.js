const express = require('express');
const router = express.Router();
const nodemailer = require('nodemailer');
const logger = require('../utils/logger');

// Webmail diagnostic endpoint specifically for Creative Ethics mail server
router.get('/webmail-diagnostic', async (req, res) => {
  try {
    const diagnosticResults = {
      timestamp: new Date().toISOString(),
      server: 'mail.cewealthzen.com',
      environment: process.env.NODE_ENV,
      tests: []
    };

    // Test 1: Basic DNS resolution
    try {
      const dns = require('dns').promises;
      const addresses = await dns.resolve4('mail.cewealthzen.com');
      diagnosticResults.tests.push({
        test: 'DNS Resolution',
        status: 'success',
        result: `Resolved to: ${addresses.join(', ')}`
      });
    } catch (dnsError) {
      diagnosticResults.tests.push({
        test: 'DNS Resolution',
        status: 'failed',
        error: dnsError.message
      });
    }

    // Test 2: Port 465 SSL connection
    try {
      const transporter465 = nodemailer.createTransporter({
        host: 'mail.cewealthzen.com',
        port: 465,
        secure: true,
        auth: {
          user: process.env.EMAIL_USER,
          pass: process.env.EMAIL_PASSWORD,
        },
        tls: {
          rejectUnauthorized: false,
          ciphers: 'SSLv3',
          secureProtocol: 'TLSv1_2_method'
        },
        connectionTimeout: 30000,
        greetingTimeout: 15000,
        socketTimeout: 30000,
      });

      await transporter465.verify();
      diagnosticResults.tests.push({
        test: 'Port 465 SSL Connection',
        status: 'success',
        result: 'Connection verified successfully'
      });
    } catch (error465) {
      diagnosticResults.tests.push({
        test: 'Port 465 SSL Connection',
        status: 'failed',
        error: error465.message,
        code: error465.code
      });
    }

    // Test 3: Port 587 TLS connection
    try {
      const transporter587 = nodemailer.createTransporter({
        host: 'mail.cewealthzen.com',
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
        connectionTimeout: 30000,
        greetingTimeout: 15000,
        socketTimeout: 30000,
      });

      await transporter587.verify();
      diagnosticResults.tests.push({
        test: 'Port 587 TLS Connection',
        status: 'success',
        result: 'Connection verified successfully'
      });
    } catch (error587) {
      diagnosticResults.tests.push({
        test: 'Port 587 TLS Connection',
        status: 'failed',
        error: error587.message,
        code: error587.code
      });
    }

    // Test 4: Gmail fallback connection
    try {
      const gmailTransporter = nodemailer.createTransporter({
        host: process.env.FALLBACK_EMAIL_HOST,
        port: parseInt(process.env.FALLBACK_EMAIL_PORT),
        secure: process.env.FALLBACK_EMAIL_SECURE === 'true',
        auth: {
          user: process.env.FALLBACK_EMAIL_USER,
          pass: process.env.FALLBACK_EMAIL_PASSWORD,
        },
        tls: {
          rejectUnauthorized: false
        },
        connectionTimeout: 20000,
        greetingTimeout: 10000,
        socketTimeout: 20000,
      });

      await gmailTransporter.verify();
      diagnosticResults.tests.push({
        test: 'Gmail Fallback Connection',
        status: 'success',
        result: 'Gmail fallback is working'
      });
    } catch (gmailError) {
      diagnosticResults.tests.push({
        test: 'Gmail Fallback Connection',
        status: 'failed',
        error: gmailError.message,
        code: gmailError.code
      });
    }

    // Generate recommendations based on test results
    const recommendations = [];
    const failedTests = diagnosticResults.tests.filter(t => t.status === 'failed');
    const successfulTests = diagnosticResults.tests.filter(t => t.status === 'success');

    if (failedTests.length === 0) {
      recommendations.push('✅ All email services are working correctly!');
    } else {
      if (failedTests.some(t => t.test.includes('DNS'))) {
        recommendations.push('🔍 DNS resolution failed - check if mail.cewealthzen.com is accessible from your server');
      }
      
      if (failedTests.some(t => t.error && t.error.includes('auth'))) {
        recommendations.push('🔐 Authentication failed - verify EMAIL_USER and EMAIL_PASSWORD in .env file');
        recommendations.push('📧 For webmail: ensure noreply@cewealthzen.com account exists and password is correct');
      }
      
      if (failedTests.some(t => t.error && (t.error.includes('ECONNREFUSED') || t.error.includes('timeout')))) {
        recommendations.push('🌐 Connection refused/timeout - webmail server may be blocking connections');
        recommendations.push('🔧 Try contacting your hosting provider about SMTP access');
        recommendations.push('📱 Consider using Gmail fallback for immediate solution');
      }
      
      if (successfulTests.some(t => t.test.includes('Gmail'))) {
        recommendations.push('✅ Gmail fallback is working - emails will be sent via Gmail if webmail fails');
      }
    }

    diagnosticResults.recommendations = recommendations;
    diagnosticResults.summary = {
      totalTests: diagnosticResults.tests.length,
      passed: successfulTests.length,
      failed: failedTests.length,
      overallStatus: failedTests.length === 0 ? 'healthy' : 'issues_detected'
    };

    res.json(diagnosticResults);

  } catch (error) {
    logger.error('Webmail diagnostic error:', error.message);
    res.status(500).json({
      error: 'Diagnostic failed',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Send a test email using the best available method
router.post('/send-webmail-test', async (req, res) => {
  try {
    const { email } = req.body;
    
    if (!email) {
      return res.status(400).json({
        success: false,
        error: 'Email address is required'
      });
    }

    // Import the email service
    const { sendEmail } = require('../services/emailService');
    
    const testEmailOptions = {
      to: email,
      subject: '🧪 Webmail Test - Real Estate App',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #007AFF;">✅ Webmail Test Successful!</h2>
          <p>This test email was sent from your Real Estate App backend running on:</p>
          <p><strong>Server:</strong> https://cewealthzen.com/</p>
          <p><strong>Sent at:</strong> ${new Date().toLocaleString()}</p>
          <p><strong>Email Service:</strong> Creative Ethics Webmail with Gmail Fallback</p>
          <div style="background-color: #e8f5e8; border: 1px solid #4caf50; border-radius: 8px; padding: 15px; margin: 20px 0;">
            <p style="margin: 0; color: #2e7d32;">
              🎉 <strong>Success!</strong> Your email service is working correctly.
            </p>
          </div>
          <p style="color: #666; font-size: 14px;">
            This confirms that registration and password reset emails should be delivered successfully.
          </p>
          <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
          <p style="color: #999; font-size: 12px;">Real Estate App - Webmail Test</p>
        </div>
      `,
      text: `Webmail Test - Real Estate App\n\nThis test email was sent successfully at ${new Date().toLocaleString()}\n\nYour email service is working correctly!`
    };

    const result = await sendEmail(testEmailOptions);
    
    res.json({
      success: true,
      message: 'Test email sent successfully',
      messageId: result.messageId,
      isMockEmail: result.isMockEmail || false,
      timestamp: new Date().toISOString(),
      sentTo: email
    });

  } catch (error) {
    logger.error('Webmail test email error:', error.message);
    res.status(500).json({
      success: false,
      error: 'Failed to send test email',
      message: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

module.exports = router;