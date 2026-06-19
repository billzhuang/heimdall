# Stage 1: build
FROM node:22-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: runtime
FROM node:22-slim

# Install kubectl
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates && \
    KUBECTL_VERSION=$(curl -sL https://dl.k8s.io/release/stable.txt) && \
    curl -sLO "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/amd64/kubectl" && \
    chmod +x kubectl && mv kubectl /usr/local/bin/kubectl && \
    apt-get purge -y curl && apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy built artifact and production dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package*.json ./
RUN npm ci --omit=dev

# Run as non-root
RUN useradd --system --no-create-home heimdall && chown -R heimdall:heimdall /app
USER heimdall

# Runtime env vars (provide at container start, not baked in)
ENV NODE_ENV=production

EXPOSE 3000

CMD ["node", "dist/server.mjs"]
