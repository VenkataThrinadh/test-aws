// Pre-compiled email template for faster sending
const createOptimizedVerificationTemplate = (email, token, userId, baseUrl, apiUrl) => {
  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9f9f9;">
      <div style="background-color: #ffffff; padding: 30px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #007AFF; margin: 0; font-size: 28px;">🏡 Real Estate App</h1>
          <p style="color: #666; margin: 10px 0 0 0; font-size: 16px;">Welcome to your property journey! [v2.0-optimized]</p>
        </div>
        
        <div style="background: linear-gradient(135deg, #007AFF 0%, #0056D3 100%); color: white; padding: 25px; border-radius: 8px; text-align: center; margin: 20px 0;">
          <h2 style="margin: 0 0 15px 0; font-size: 24px;">Complete Your Registration</h2>
          <p style="margin: 0; font-size: 16px; opacity: 0.9;">Choose your preferred verification method below</p>
        </div>
        
        <!-- Primary Verification Buttons -->
        <div style="text-align: center; margin: 30px 0;">
          <!-- Web Verification Button -->
          <a href="${apiUrl}/api/auth/verify-email?token=${token}&userId=${userId}" 
             style="background-color: #007AFF; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-size: 16px; font-weight: 600; display: inline-block; box-shadow: 0 4px 12px rgba(0, 122, 255, 0.3); margin: 5px 10px;">
            🌐 Verify via Web
          </a>
          
          <!-- Mobile Verification Button -->
          <a href="${apiUrl}/api/auth/verify-mobile?token=${token}&userId=${userId}&email=${encodeURIComponent(email)}" 
             style="background-color: #34C759; color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-size: 16px; font-weight: 600; display: inline-block; box-shadow: 0 4px 12px rgba(52, 199, 89, 0.3); margin: 5px 10px;">
            📱 Verify via Mobile
          </a>
        </div>
        
        <!-- Enhanced Verification Options -->
        <div style="background-color: #f8f9fa; padding: 25px; border-radius: 8px; margin: 20px 0;">
          <h3 style="color: #333; margin: 0 0 20px 0; font-size: 18px; text-align: center;">📱 All Verification Methods</h3>
          
          <!-- Method 1: Web Browser -->
          <div style="background: white; padding: 15px; border-radius: 6px; margin-bottom: 15px; border-left: 4px solid #007AFF;">
            <div style="display: flex; align-items: center; margin-bottom: 8px;">
              <span style="font-size: 20px; margin-right: 10px;">🌐</span>
              <strong style="color: #333; font-size: 16px;">Web Browser (Desktop/Laptop)</strong>
            </div>
            <p style="margin: 5px 0; color: #666; font-size: 14px;">Click the "Verify via Web" button above or use this direct link:</p>
            <a href="${apiUrl}/api/auth/verify-email?token=${token}&userId=${userId}" 
               style="color: #007AFF; font-size: 14px; word-break: break-all;">
              ${apiUrl}/api/auth/verify-email?token=${token}&userId=${userId}
            </a>
          </div>
          
          <!-- Method 2: Mobile Verification -->
          <div style="background: white; padding: 15px; border-radius: 6px; margin-bottom: 15px; border-left: 4px solid #34C759;">
            <div style="display: flex; align-items: center; margin-bottom: 8px;">
              <span style="font-size: 20px; margin-right: 10px;">📱</span>
              <strong style="color: #333; font-size: 16px;">Mobile Verification (Any Device)</strong>
            </div>
            <p style="margin: 5px 0; color: #666; font-size: 14px;">Click "Verify via Mobile" to verify and automatically open the app:</p>
            <a href="${apiUrl}/api/auth/verify-mobile?token=${token}&userId=${userId}&email=${encodeURIComponent(email)}" 
               style="color: #34C759; font-size: 14px; word-break: break-all;">
              Mobile Verification Link
            </a>
          </div>
          
          <!-- Method 3: Direct App Link -->
          <div style="background: white; padding: 15px; border-radius: 6px; margin-bottom: 15px; border-left: 4px solid #FF9500;">
            <div style="display: flex; align-items: center; margin-bottom: 8px;">
              <span style="font-size: 20px; margin-right: 10px;">📲</span>
              <strong style="color: #333; font-size: 16px;">Open Directly in App</strong>
            </div>
            <p style="margin: 5px 0; color: #666; font-size: 14px;">If you have the app installed, tap here to verify:</p>
            <a href="realestate://verify-email?token=${token}&userId=${userId}" 
               style="color: #FF9500; font-size: 14px;">
              Open in Real Estate App
            </a>
          </div>
          
          <!-- Method 4: Manual Copy -->
          <div style="background: white; padding: 15px; border-radius: 6px; border-left: 4px solid #8E8E93;">
            <div style="display: flex; align-items: center; margin-bottom: 8px;">
              <span style="font-size: 20px; margin-right: 10px;">📋</span>
              <strong style="color: #333; font-size: 16px;">Manual Copy & Paste</strong>
            </div>
            <p style="margin: 5px 0; color: #666; font-size: 14px;">Copy and paste this link in any browser:</p>
            <code style="background: #e9ecef; padding: 8px; border-radius: 4px; font-size: 12px; display: block; margin-top: 5px; word-break: break-all; color: #495057;">
              ${apiUrl}/api/auth/verify-email?token=${token}&userId=${userId}
            </code>
          </div>
        </div>
        
        <!-- How Mobile Verification Works -->
        <div style="background: linear-gradient(135deg, #34C759 0%, #30B955 100%); color: white; padding: 20px; border-radius: 8px; margin: 20px 0;">
          <h3 style="margin: 0 0 15px 0; font-size: 18px; text-align: center;">📱 How Mobile Verification Works</h3>
          <div style="text-align: left;">
            <p style="margin: 8px 0; font-size: 14px; opacity: 0.95;">
              <strong>1.</strong> Click "Verify via Mobile" button above
            </p>
            <p style="margin: 8px 0; font-size: 14px; opacity: 0.95;">
              <strong>2.</strong> Your email will be automatically verified
            </p>
            <p style="margin: 8px 0; font-size: 14px; opacity: 0.95;">
              <strong>3.</strong> You'll be redirected to open the mobile app
            </p>
            <p style="margin: 8px 0; font-size: 14px; opacity: 0.95;">
              <strong>4.</strong> If app isn't installed, you'll see download options
            </p>
          </div>
        </div>
        
        <div style="border-top: 2px solid #f0f0f0; padding-top: 20px; margin-top: 30px;">
          <p style="color: #666; font-size: 14px; margin: 0 0 10px 0;">
            <strong>⏰ Important:</strong> This verification link expires in 24 hours.
          </p>
          <p style="color: #666; font-size: 14px; margin: 0 0 10px 0;">
            <strong>📧 Email sent to:</strong> ${email}
          </p>
          <p style="color: #666; font-size: 14px; margin: 0 0 10px 0;">
            <strong>🔒 Security:</strong> Both verification methods are equally secure and will confirm your email address.
          </p>
          <p style="color: #666; font-size: 14px; margin: 0;">
            If you didn't create this account, please ignore this email.
          </p>
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

module.exports = { createOptimizedVerificationTemplate };