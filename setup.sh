#!/bin/bash
set -e

echo "=== WB Parser Service Setup ==="

# Update system
apt-get update -y
apt-get install -y curl git

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

# Install Playwright dependencies
npx playwright install-deps chromium

# Clone and setup
cd /opt
rm -rf wb-parser-service
git clone https://github.com/sergio1811x/wb-parser-service.git
cd wb-parser-service
npm install
npx playwright install chromium

# Create systemd service
cat > /etc/systemd/system/wb-parser.service << 'UNIT'
[Unit]
Description=WB Parser Service
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/wb-parser-service
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=PORT=3001
Environment=SECRET=cardzip-wb-2024

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable wb-parser
systemctl start wb-parser

echo ""
echo "=== DONE ==="
echo "Service running on port 3001"
echo "Test: curl http://localhost:3001/health"
