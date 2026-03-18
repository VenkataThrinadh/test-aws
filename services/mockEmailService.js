const logger = require('../utils/logger');

/**
 * Mock email service for development/testing when SMTP is not available
 */
class MockEmailService {
  constructor() {
    this.sentEmails = [];
  }

  async sendEmail(options) {
    const mockEmail = {
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
      timestamp: new Date().toISOString(),
      messageId: `mock-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    };

    this.sentEmails.push(mockEmail);

    // Log the email details
    console.log('\n📧 MOCK EMAIL SENT:');
    console.log('To:', options.to);
    console.log('Subject:', options.subject);
    console.log('Message ID:', mockEmail.messageId);
    console.log('Timestamp:', mockEmail.timestamp);
    
    // Extract verification link if present
    const verificationMatch = options.html.match(/href="([^"]*verify[^"]*)"/i);
    if (verificationMatch) {
      console.log('🔗 Verification Link:', verificationMatch[1]);
    }
    
    console.log('─'.repeat(50));

    return {
      messageId: mockEmail.messageId,
      response: 'Mock email sent successfully',
      accepted: [options.to],
      rejected: [],
      pending: [],
      envelope: {
        from: 'mock@example.com',
        to: [options.to]
      }
    };
  }

  async verify() {
    // Always return success for mock service
    return true;
  }

  getSentEmails() {
    return this.sentEmails;
  }

  getLastEmail() {
    return this.sentEmails[this.sentEmails.length - 1] || null;
  }

  clearSentEmails() {
    this.sentEmails = [];
  }
}

module.exports = new MockEmailService();