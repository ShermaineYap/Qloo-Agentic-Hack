# TourSmith: one container serves the web app and runs the Qloo MCP harness.
# `qloo mcp` is a local stdio process, so it needs a long-running server
# (Railway, Render, Fly.io, a VM). Serverless functions are not supported.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
RUN npm install --global @qloo/qloo-harness@0.1.26 && qloo --version
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
EXPOSE 3000
CMD ["node", "server/index.js"]
