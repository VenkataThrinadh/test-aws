const { sendVerificationEmail } = require('../services/emailService');

(async () => {
  try {
    const res = await sendVerificationEmail('devtest@example.com', 'TESTTOKEN123', '999');
    console.log('SEND_RESULT:', res && res.messageId ? res.messageId : res);
  } catch (err) {
    console.error('SEND_ERR:', err && err.message ? err.message : err);
    process.exit(1);
  }
})();
