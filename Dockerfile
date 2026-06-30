FROM node:24-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    fonts-liberation \
    fluxbox \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libpango-1.0-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    novnc \
    websockify \
    x11vnc \
    xvfb \
    xdg-utils \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm install
RUN npx playwright install chromium

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0
ENV DATA_DIR=/data
ENV MPP_PROFILE_DIR=/data/mpp-chrome-profile

EXPOSE 8787
VOLUME ["/data"]
CMD ["npm", "start"]
