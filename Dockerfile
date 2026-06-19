# Stage 1: build
# Pin to immutable digest; update intentionally when pulling in base-image security patches.
FROM node:22-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2 AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# Stage 2: runtime
FROM node:22-slim@sha256:d9f850096136edbc402debdd8729579a288aac64574ada0ff4db26b6ae58b0b2

# Install kubectl: detect arch, fetch binary + SHA-256, verify before install.
# Install helm: fetch the official install script and run it (pinned to latest stable).
RUN apt-get update && \
    apt-get install -y --no-install-recommends curl ca-certificates && \
    KUBECTL_VERSION=$(curl --fail -sL https://dl.k8s.io/release/stable.txt) && \
    ARCH=$(dpkg --print-architecture) && \
    curl --fail -sLO "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl" && \
    curl --fail -sLO "https://dl.k8s.io/release/${KUBECTL_VERSION}/bin/linux/${ARCH}/kubectl.sha256" && \
    echo "$(cat kubectl.sha256)  kubectl" | sha256sum --check && \
    chmod +x kubectl && mv kubectl /usr/local/bin/kubectl && \
    rm kubectl.sha256 && \
    HELM_VERSION=v3.17.3 && \
    curl --fail -sLO "https://get.helm.sh/helm-${HELM_VERSION}-linux-${ARCH}.tar.gz" && \
    curl --fail -sLO "https://get.helm.sh/helm-${HELM_VERSION}-linux-${ARCH}.tar.gz.sha256sum" && \
    sha256sum --check "helm-${HELM_VERSION}-linux-${ARCH}.tar.gz.sha256sum" && \
    tar -zxf "helm-${HELM_VERSION}-linux-${ARCH}.tar.gz" && \
    mv "linux-${ARCH}/helm" /usr/local/bin/helm && \
    rm -rf "helm-${HELM_VERSION}-linux-${ARCH}.tar.gz" "helm-${HELM_VERSION}-linux-${ARCH}.tar.gz.sha256sum" "linux-${ARCH}" && \
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

# Copy the default tool config so Docker deployments respect the repo's settings.
# To override at runtime, either:
#   • Mount a custom file: -v /host/heimdall.config.yaml:/app/heimdall.config.yaml
#   • Point to a different path: -e HEIMDALL_CONFIG=/config/heimdall.config.yaml
COPY --from=builder /app/heimdall.config.yaml ./

# Run as non-root
RUN useradd --system --no-create-home heimdall && chown -R heimdall:heimdall /app
USER heimdall

EXPOSE 3000

CMD ["node", "dist/server.mjs"]
