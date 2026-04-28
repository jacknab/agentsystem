#!/bin/bash

# ==============================================================================
# PBX Terminal VPS Setup Script
# Works on Ubuntu 20.04/22.04+ and Debian
# ==============================================================================

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}====================================================${NC}"
echo -e "${BLUE}       PBX TERMINAL VPS AUTO-INSTALLER             ${NC}"
echo -e "${BLUE}====================================================${NC}"

# 1. Check for root
if [ "$EUID" -ne 0 ]; then
  echo -e "${RED}Please run as root or with sudo${NC}"
  exit 1
fi

# 2. Update System
echo -e "${BLUE}[1/7] Updating system packages...${NC}"
apt-get update && apt-get upgrade -y

# 3. Install Basics
echo -e "${BLUE}[2/7] Installing build essentials and curl...${NC}"
apt-get install -y build-essential curl git python3

# 4. Install Node.js (Latest LTS)
echo -e "${BLUE}[3/7] Installing Node.js 20.x...${NC}"
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Verify Node installation
NODE_VER=$(node -v)
echo -e "${GREEN}Node.js installed: $NODE_VER${NC}"

# 5. Install Process Manager (PM2)
echo -e "${BLUE}[4/7] Installing PM2 and TSX...${NC}"
npm install -g pm2 tsx

# 6. Prepare Project
echo -e "${BLUE}[5/7] Installing project dependencies...${NC}"
npm install

echo -e "${BLUE}[6/7] Building frontend...${NC}"
npm run build

# 7. Environment Setup
if [ ! -f .env ]; then
  echo -e "${BLUE}[7/7] Creating template .env file...${NC}"
  cat <<EOT >> .env
# Twilio Credentials
TWILIO_ACCOUNT_SID=ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX
TWILIO_AUTH_TOKEN=your_auth_token_here

# Application URL (CRITICAL for webhooks)
# Replace with your public IP or Domain
APP_URL=http://$(curl -s ifconfig.me):3000

# Optional config
HOLD_MUSIC_URL=http://twimlets.com/holdmusic?Bucket=com.twilio.music.classical
EOT
  echo -e "${GREEN}.env created. PLEASE EDIT IT with your real credentials!${NC}"
else
  echo -e "${GREEN}.env already exists, skipping creation.${NC}"
fi

echo -e "${BLUE}====================================================${NC}"
echo -e "${GREEN}SETUP COMPLETE!${NC}"
echo -e "Follow these steps to start your terminal:"
echo -e ""
echo -e "1. ${BLUE}nano .env${NC}  <- Add your Twilio SID/Token and APP_URL"
echo -e "2. ${BLUE}pm2 start server.ts --interpreter tsx --name pbx-terminal${NC}"
echo -e "3. ${BLUE}pm2 save && pm2 startup${NC}"
echo -e ""
echo -e "Your app will be running at ${GREEN}http://$(curl -s ifconfig.me):3000${NC}"
echo -e "Don't forget to open port 3000 in your firewall: ${BLUE}ufw allow 3000${NC}"
echo -e "${BLUE}====================================================${NC}"
