# Stage 1: build
FROM node:22-slim AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: runtime
FROM node:22-slim

# Install kubectl: detect arch, fetch binary + SHA-256, verify before install
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates && \
    KUBECTL_VERSION=$(curl --fail -sL https://dl.k8s.io/release/stable.txt) && \
    ARCH=$(dpkg --print-architecture) && \
    curl --fail -sLO "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl" && \
    curl --fail -sLO "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl.sha256" && \
    echo "$(cat kubectl.sha256)  kubectl" | sha256sum --check && \
    chmod +x kubectl && mv kubectl /usr/local/bin/kubectl && \
    rm kubectl.sha256 && \
    apt-get purge -y curl && apt-get autoremove -y && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production deps before copying dist — package*.json changes less often,
# so this layer is cache-stable across source-only rebuilds.
COPY --from=builder /app/package*.json ./
ENV NODE_ENV=production
RUN npm ci --omit=dev

# Copy built artifact (changes on every source build)
COPY --from=builder /app/dist ./dist

# Run as non-root
RUN useradd --system --no-create-home heimdall && chown -R heimdall:heimdall /app
USER heimdall

EXPOSE 3000

CMD ["node", "dist/server.mjs"]
