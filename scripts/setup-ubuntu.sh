#!/usr/bin/env bash
set -euo pipefail

# Setup script for agmux on Ubuntu 24.04

echo "==> Installing system packages"
apt update
apt install -y build-essential tmux git curl

echo "==> Installing Node.js 22"
if command -v node &>/dev/null && [[ "$(node -v)" == v22.* ]]; then
  echo "    Node.js $(node -v) already installed"
else
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt install -y nodejs
fi

echo "==> Installing npm packages"
npm install

echo "==> Building"
npm run build

echo ""
echo "Done. Start with: npm start"
echo "Or for development: npm run app:watch"
