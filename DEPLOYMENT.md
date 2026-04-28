# PBX Dashboard Setup Guide (VPS Deployment)

This guide provides step-by-step instructions for deploying your PBX Monitor & Simulator on a private VPS (e.g., DigitalOcean, Linode, AWS).

## 1. Automated Setup (Recommended)

If you are using a clean Ubuntu or Debian VPS, you can use the automated setup script:

```bash
chmod +x vps-setup.sh
sudo ./vps-setup.sh
```

This script will install Node.js, PM2, and all project dependencies.

## 2. Prerequisites (Manual)
*   **npm**: v9 or higher.
*   **A Public Domain or IP**: Required for Twilio to send webhooks.
*   **Twilio Account**: With a Phone Number and API credentials.

## 2. Environment Configuration

Create a `.env` file in the root directory of your project:

```env
# Twilio Credentials
TWILIO_ACCOUNT_SID=your_sid_here
TWILIO_AUTH_TOKEN=your_token_here

# Application URL (CRITICAL for webhooks)
# Use your domain or public IP (e.g., https://pbx.example.com)
APP_URL=https://your-public-domain.com

# Optional: Custom Hold Music
HOLD_MUSIC_URL=http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical
```

## 3. Installation

1.  **Clone/Upload** your project files to the VPS.
2.  Install dependencies:
    ```bash
    npm install
    ```
3.  Build the frontend:
    ```bash
    npm run build
    ```

## 4. Running the Server

### Production Mode (using PM2 recommended)
We recommend using **PM2** to keep the server running 24/7.

1.  Install PM2: `npm install -g pm2`
2.  Start the app:
    ```bash
    pm2 start server.ts --interpreter tsx --name pbx-dashboard
    ```

### Manual Start
```bash
npx tsx server.ts
```
The server binds to port `3000` by default.

## 5. Network & Firewall

*   Ensure port `3000` is open on your VPS firewall (e.g., `ufw allow 3000`).
*   **Reverse Proxy (Highly Recommended)**: Use Nginx to handle SSL and proxy traffic to port 3000.

### Example Nginx Config:
```nginx
server {
    listen 80;
    server_name pbx.yourdomain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## 6. Twilio Integration

Once your server is live and reachable at `https://your-domain.com`:

1.  Log in to the **Twilio Console**.
2.  Go to **Phone Numbers** > **Manage** > **Active Numbers**.
3.  Click on your number.
4.  Find the **Voice & Fax** section.
5.  Under **"A CALL COMES IN"**:
    *   Select **Webhook**.
    *   URL: `https://your-domain.com/twilio/inbound`
    *   Method: **HTTP POST**.
6.  Save changes.

## 7. Dashboard Hotkeys

The dashboard is optimized for keyboard usage:
*   `Enter`: Focus command bar.
*   `A`: Accept/Answer call.
*   `H`: Put on Hold / Transfer to Phone Menu.
*   `T`: Transfer to Agent.
*   `R`: Reset active call.
*   `ESC`: Global Reset / Clear UI.
*   `` ` `` (Backtick): Toggle Debug/Simulator controls.
