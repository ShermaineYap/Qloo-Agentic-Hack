# TourSmith: one container serves the web app and runs the Qloo MCP harness.
# `qloo mcp` is a local stdio process, so it needs a long-running container
# (Hugging Face Spaces, Render, Railway, Fly.io, a VM), not serverless.
FROM node:22-slim
ENV NODE_ENV=production
RUN npm install --global @qloo/qloo-harness@0.1.26 && qloo --version

# Run as the image's built-in non-root user (uid 1000, which Hugging Face
# Spaces requires) and keep every writable path inside its home.
USER node
ENV HOME=/home/node QLOO_HOME=/home/node/.qloo PORT=3000
WORKDIR /home/node/app
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --chown=node:node . .
EXPOSE 3000
CMD ["node", "server/index.js"]
