const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const app = express();

app.use(express.json());

// Environment variables
const KEYS = {
  KOMMO_CLIENT_ID: process.env.KOMMO_CLIENT_ID,
  KOMMO_CLIENT_SECRET: process.env.KOMMO_CLIENT_SECRET,
  KOMMO_SUBDOMAIN: process.env.KOMMO_SUBDOMAIN,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  APIFY_API_TOKEN: process.env.APIFY_API_TOKEN
};

// Token storage
const TOKEN_FILE = 'kommo_token.txt';
let kommoAccessToken = null;

// Helper functions for token management
async function saveToken(token) {
  try {
    await fs.writeFile(TOKEN_FILE, token);
    console.log('✅ Kommo access token saved to file.');
  } catch (error) {
    console.error('Error saving token:', error);
  }
}

async function loadToken() {
  try {
    const token = await fs.readFile(TOKEN_FILE, 'utf8');
    console.log('✅ Kommo access token loaded from file.');
    return token;
  } catch (error) {
    console.log('ℹ️ No token file found. Needs authentication.');
    return null;
  }
}

// Load token on server start
(async () => {
  kommoAccessToken = await loadToken();
})();

// Routes
app.get('/auth', (req, res) => {
  const redirectUri = `https://${req.get('host')}/oauth`;
  const authUrl = `https://www.kommo.com/oauth?client_id=${KEYS.KOMMO_CLIENT_ID}&state=random_state&mode=post_message&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.send(`<a href="${authUrl}">Click HERE to Connect Your Kommo Account</a>`);
});

app.get('/oauth', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send('No code received');

  try {
    const redirectUri = `https://${req.get('host')}/oauth`;
    const response = await axios.post(`https://${KEYS.KOMMO_SUBDOMAIN}.kommo.com/oauth2/access_token`, {
      client_id: KEYS.KOMMO_CLIENT_ID,
      client_secret: KEYS.KOMMO_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: redirectUri
    });
    
    kommoAccessToken = response.data.access_token;
    await saveToken(kommoAccessToken);
    res.send('Kommo Connected Successfully! You can close this tab.');
  } catch (error) {
    console.error('Kommo Auth Error:', error.response?.data);
    res.send('Error connecting to Kommo. Please try again.');
  }
});

// Main webhook handler
app.post('/webhook', async (req, res) => {
  console.log('🔔 WEBHOOK RECEIVED');
  
  // Load token if not available
  if (!kommoAccessToken) {
    kommoAccessToken = await loadToken();
  }

  const message = req.body.message;
  if (!message || !message.text) return res.sendStatus(200);

  const chatId = message.chat.id;
  const userText = message.text;
  const userName = `${message.from.first_name} ${message.from.last_name || ''}`.trim();

  console.log('📩 User message:', userText);

  try {
    // 1. Get AI response
    let aiResponse = "Hello! I'm your real estate assistant. How can I help you?";
    try {
      const openaiResponse = await axios.post('https://api.openai.com/v1/chat/completions', {
        model: 'gpt-4o-mini',
        messages: [{
          role: 'user',
          content: `Respond as a friendly real estate agent to this message: "${userText}". Keep it short and helpful.`
        }]
      }, {
        headers: { 'Authorization': `Bearer ${KEYS.OPENAI_API_KEY}` }
      });
      aiResponse = openaiResponse.data.choices[0].message.content;
    } catch (error) {
      console.error('OpenAI Error:', error.response?.data);
    }

    // 2. Send response to user
    await axios.post(`https://api.telegram.org/bot${KEYS.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      chat_id: chatId,
      text: aiResponse
    });

    // 3. Save to Kommo if authenticated
    if (kommoAccessToken) {
      try {
        // Create contact
        const kommoContact = await axios.post(`https://${KEYS.KOMMO_SUBDOMAIN}.kommo.com/api/v4/contacts`, [{
          name: userName,
          custom_fields_values: [{
            field_code: 'PHONE',
            values: [{ value: message.from.id.toString() }]
          }]
        }], {
          headers: { 'Authorization': `Bearer ${kommoAccessToken}` }
        });

        const contactId = kommoContact.data._embedded.contacts[0].id;

        // Add note
        await axios.post(`https://${KEYS.KOMMO_SUBDOMAIN}.kommo.com/api/v4/events`, [{
          entity_id: contactId,
          note: `Telegram conversation:\nUser: ${userText}\nAI: ${aiResponse}`
        }], {
          headers: { 'Authorization': `Bearer ${kommoAccessToken}` }
        });

        // Create deal if keywords found
        if (userText.toLowerCase().includes('buy') || userText.toLowerCase().includes('interested')) {
          await axios.post(`https://${KEYS.KOMMO_SUBDOMAIN}.kommo.com/api/v4/leads`, [{
            name: `Telegram Lead: ${userName}`,
            pipeline_id: process.env.KOMMO_PIPELINE_ID || 123456,
            status_id: process.env.KOMMO_STATUS_ID || 1234567,
            _embedded: { contacts: [{ id: contactId }] }
          }], {
            headers: { 'Authorization': `Bearer ${kommoAccessToken}` }
          });
          console.log('✅ Deal created in Kommo');
        }

      } catch (kommoError) {
        console.error('Kommo API Error:', kommoError.response?.data);
        if (kommoError.response?.status === 401) {
          kommoAccessToken = null;
          await saveToken('');
        }
      }
    }

  } catch (error) {
    console.error('Unexpected error:', error);
  }

  res.sendStatus(200);
});

// Health check
app.get('/', (req, res) => {
  res.send('🤖 AI Real Estate Bot is running!');
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
  console.log('ℹ️  Make sure to:');
  console.log('1. Visit /auth to connect Kommo');
  console.log('2. Set Telegram webhook to /webhook');
});
