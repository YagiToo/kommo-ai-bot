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
