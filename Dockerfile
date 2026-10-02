FROM node:22-slim

RUN apt-get update -qq && apt-get install -y -qq git >/dev/null && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js submodule-sync.js ./
COPY public/ ./public/
COPY .gitmodules ./

# Initialise a git repo so the runtime submodule sync (git submodule update)
# can clone thumbnail collections on demand.
RUN git init && \
    git config user.email "app@local" && \
    git config user.name "app" && \
    git add -A && \
    git commit -q -m "init"

ENV PORT=3000
ENV SYNC_INTERVAL=1800
EXPOSE 3000

CMD ["node", "server.js"]
