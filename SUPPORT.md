# Twilio Voice SDK Configuration Guide

To enable WebRTC audio (streaming calls directly to your browser), you need to configure the Voice API credentials in your `.env` file.

## 1. Create a Voice API Key
1. Log in to the [Twilio Console](https://console.twilio.com/).
2. Go to **Account** > **API Keys & Tokens**.
3. Click **Create API Key**.
4. Give it a name (e.g., "Browser Agent App").
5. Set the type to **Standard**.
6. **IMPORTANT**: Copy the **SID** (this is your `TWILIO_VOICE_API_KEY`) and the **Secret** (this is your `TWILIO_VOICE_API_SECRET`). You will not be able to see the Secret again.

## 2. Update Environment Variables
Add these to your environment configuration:
- `TWILIO_VOICE_API_KEY`: The SID starts with `SK...`
- `TWILIO_VOICE_API_SECRET`: The Secret string provided.

## 3. Configure TwiML App (Optional but Recommended)
For incoming calls to work correctly with this code:
1. Go to **Voice** > **Manage** > **TwiML Apps**.
2. Create a new TwiML App.
3. Set the **Request URL** to `https://<YOUR_APP_URL>/api/voice/inbound`.
4. Assign this TwiML App to your Twilio Phone Number in the number's configuration page.
