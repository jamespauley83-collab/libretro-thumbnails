FROM node:22-slim

RUN apt-get update -qq && apt-get install -y -qq git >/dev/null && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js submodule-sync.js ./
COPY public/ ./public/
COPY .gitmodules ./

# Keep only the catalogue in Git; no source history or thumbnail data is copied.
# The sync manager registers a selected system's gitlink on its first download.
RUN git init && \
    git config user.email "app@local" && \
    git config user.name "app" && \
    git add .gitmodules && \
    git commit -q -m "init"

ENV PORT=3000
ENV SYNC_INTERVAL=1800
EXPOSE 3000

CMD ["node", "server.js"]
