const axios = require('axios');
const crypto = require('crypto');

const FB_API_VERSION = 'v24.0';
const FB_DATASET_ID = process.env.FB_DATASET_ID || '1165262032225591'; // Updated to match Meta's guide

// Helper to normalise an access token value that may have been pasted as a full URL
function extractToken(raw) {
  if (!raw) return null;
  try {
    const asStr = String(raw);
    const m = asStr.match(/[?&]access_token=([^&]+)/);
    if (m && m[1]) return decodeURIComponent(m[1]);
    return asStr;
  } catch (e) {
    return null;
  }
}

const FB_RAW_ACCESS = process.env.FB_ACCESS_TOKEN || process.env.FB_PAGE_ACCESS_TOKEN || process.env.FB_ACCESS_TOKEN_URL;
const FB_ACCESS_TOKEN = extractToken(FB_RAW_ACCESS);
const FB_ENDPOINT_BASE = `https://graph.facebook.com/${FB_API_VERSION}/${FB_DATASET_ID}/events`;

// Hash function for PII
function hashPII(value) {
  if (!value) return null;
  return crypto.createHash('sha256').update(value.toLowerCase().trim()).digest('hex');
}

// Send lead status change event to Facebook Conversions API
async function sendLeadEvent(lead, oldStatus, newStatus) {
  try {
    if (!FB_ACCESS_TOKEN) {
      console.warn('Facebook access token not configured, skipping event send');
      return;
    }

    // Only send if status actually changed
    if (oldStatus === newStatus) return;

    // Prepare user data
    const userData = {};

    // Lead ID (Meta's lead ID if available, otherwise our internal ID)
    if (lead.platform_id) {
      userData.lead_id = lead.platform_id;
    }

    // Hashed email
    if (lead.email) {
      userData.em = [hashPII(lead.email)];
    }

    // Hashed phone
    if (lead.phone) {
      userData.ph = [hashPII(lead.phone.replace(/[^0-9]/g, ''))]; // Remove non-digits
    }

    // Skip if no user data
    if (Object.keys(userData).length === 0) {
      console.warn('No user data available for lead event, skipping');
      return;
    }

    // Prepare payload according to Meta's guide
    const payload = {
      data: [{
        action_source: 'system_generated',
        event_name: 'Lead',
        event_time: Math.floor(Date.now() / 1000),
        user_data: userData,
        custom_data: {
          event_source: 'crm',
          lead_event_source: 'Real Estate CRM',
          lead_status: newStatus,
          previous_status: oldStatus
        }
      }]
    };

    // Build request URL with access token and optional appsecret_proof
    const token = FB_ACCESS_TOKEN;
    if (!token) {
      console.warn('Facebook access token not configured or could not be parsed, skipping event send');
      return;
    }

    // Compute appsecret_proof when app secret exists (recommended)
    let appsecret_proof = null;
    const appSecret = process.env.FB_APP_SECRET;
    if (appSecret) {
      // If someone accidentally pasted a URL into FB_APP_SECRET, warn
      if (String(appSecret).includes('graph.facebook.com') || String(appSecret).startsWith('http')) {
        console.warn('FB_APP_SECRET looks like a URL — set it to the Meta App Secret string, not a URL');
      }
      try {
        appsecret_proof = crypto.createHmac('sha256', String(appSecret)).update(String(token)).digest('hex');
      } catch (e) {
        console.warn('Unable to compute appsecret_proof:', e.message);
        appsecret_proof = null;
      }
    }

    const url = `${FB_ENDPOINT_BASE}?access_token=${encodeURIComponent(token)}${appsecret_proof ? '&appsecret_proof=' + encodeURIComponent(appsecret_proof) : ''}`;
    const response = await axios.post(url, payload, { headers: { 'Content-Type': 'application/json' } });

    console.log('Facebook lead event sent successfully:', {
      lead_id: lead.id,
      status_change: `${oldStatus} -> ${newStatus}`,
      fb_response: response.data
    });

    return response.data;

  } catch (error) {
    console.error('Error sending lead event to Facebook:', error.response?.data || error.message);
    // Don't throw - we don't want to break the lead update
  }
}

module.exports = {
  sendLeadEvent
};
