#!/bin/bash

# ==============================================================================
# PBX Terminal Production Setup Script
# Target: Ubuntu 20.04/22.04/24.04
# Domain: dogeblast.win
# = : 144.202.74.210
# ==============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}====================================================${NC}"
echo -e "${BLUE}       PBX TERMINAL PRODUCTION AUTO-INSTALLER      ${NC}"
echo -e "${BLUE}====================================================${NC}"

# 1. Check for root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Please run as root or with sudo. Try: sudo bash setup.sh${NC}"
  exit 1
fi

DOMAIN="dogeblast.win"
EMAIL="jacknabvoip@gmail.com" # Taken from metadata

# 2. Update System
echo -e "${BLUE}[1/9] Updating system packages...${NC}"
apt-get update && apt-get upgrade -y

# 3. Install Basics & Nginx
echo -e "${BLUE}[2/9] Installing dependencies (Nginx, Certbot, Git, Curl)...${NC}"
apt-get install -y build-essential curl git python3 nginx certbot python3-certbot-nginx ufw

# 4. Install Node.js (Latest LTS)
echo -e "${BLUE}[3/9] Installing Node.js 20.x...${NC}"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# 5. Install Process Manager (PM2)
echo -e "${BLUE}[4/9] Installing PM2 and TSX...${NC}"
npm install -g pm2 tsx

# 6. Prepare Project
echo -e "${BLUE}[5/9] Installing project dependencies...${NC}"
npm install

echo -e "${BLUE}[6/9] Building for production...${NC}"
# Set production environment for the build
export NODE_ENV=production
npm run build

# 7. Nginx Configuration (Optional/Manual)
echo -e "${YELLOW}[7/9] Checking Nginx configuration...${NC}"
if [ -f /etc/nginx/sites-available/$DOMAIN ]; then
  echo -e "${GREEN}Nginx config for $DOMAIN already exists. Skipping overwrite.${NC}"
  echo -e "Make sure it proxies to http://localhost:3000"
else
  echo -e "${BLUE}Creating Nginx reverse proxy config...${NC}"
  cat <<EOF > /etc/nginx/sites-available/$DOMAIN
server {
    listen 80;
    server_name $DOMAIN;
    return 301 https://\$host\$request_uri;
}

server {
    listen 443 ssl;
    server_name $DOMAIN;

    # Note: Using standard Let's Encrypt paths - adjust if yours are different
    ssl_certificate /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host \$host;
        proxy_cache_bypass \$http_upgrade;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
  ln -sf /etc/nginx/sites-available/$DOMAIN /etc/nginx/sites-enabled/
  nginx -t && systemctl restart nginx
fi

# 8. Firewall Setup
echo -e "${BLUE}[8/9] Setting up firewall (UFW)...${NC}"
ufw allow 'Nginx Full' || true
ufw allow ssh || true

# 9. Skip Certbot (User already has SSL)
echo -e "${GREEN}[9/9] SSL is already configured. Skipping Certbot.${NC}"

# Final Environment Setup
if [ ! -f .env ]; then
  echo -e "${BLUE}[9/9] Creating .env from template...${NC}"
  cp .env.example .env
  echo -e "${GREEN}.env created. Please update it with your actual Twilio keys.${NC}"
else
  echo -e "${GREEN}.env already exists, skipping copy.${NC}"
fi

echo -e "${BLUE}====================================================${NC}"
echo -e "${GREEN}SETUP COMPLETE!${NC}"
echo -e "${BLUE}====================================================${NC}"
echo -e "Follow these final steps:"
echo -e ""
echo -e "1. Edit your credentials: ${YELLOW}nano .env${NC}"
echo -e "   - TWILIO_ACCOUNT_SID=..."
echo -e "   - TWILIO_AUTH_TOKEN=..."
echo -e "   - TWILIO_VOICE_API_KEY=..."
echo -e "   - TWILIO_VOICE_API_SECRET=..."
echo -e "   - TWILIO_TWIML_APP_SID=AP8f818388ea26560e8443da8e75a870cd"
echo -e "   - TWILIO_PHONE_NUMBER=..."
echo -e "   - APP_URL=https://$DOMAIN"
echo -e ""
echo -e "2. Start the application:"
echo -e "   ${GREEN}pm2 start server.ts --interpreter tsx --name pbx-terminal${NC}"
echo -e ""
echo -e "3. Ensure persistence on reboot:"
echo -e "   ${GREEN}pm2 save && pm2 startup${NC}"
echo -e ""
echo -e "Access your app at: ${GREEN}https://$DOMAIN${NC}"
echo -e "${BLUE}====================================================${NC}"
