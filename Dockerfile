FROM node:22-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

FROM debian:bookworm-slim AS proton-bridge

ARG TARGETARCH
ARG PROTON_BRIDGE_VERSION=3.26.0
ARG PROTON_BRIDGE_SHA256=c076872522ce2f0facd0e64764d7d588b3a1ed213ff3acd25386b51e8a1f02e8
ARG PROTON_BRIDGE_SOURCE_SHA256=5b19c63989d4efa05d3b05044be4718e4854b879c57419c837d1aca179661939

RUN mkdir -p /out \
  && if [ "$TARGETARCH" = "amd64" ]; then \
    apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl --fail --location --proto '=https' --tlsv1.2 \
      --output /tmp/proton-bridge.deb \
      "https://github.com/ProtonMail/proton-bridge/releases/download/v${PROTON_BRIDGE_VERSION}/protonmail-bridge_${PROTON_BRIDGE_VERSION}-1_amd64.deb" \
    && curl --fail --location --proto '=https' --tlsv1.2 \
      --output /tmp/proton-bridge-source.tar.gz \
      "https://github.com/ProtonMail/proton-bridge/archive/refs/tags/v${PROTON_BRIDGE_VERSION}.tar.gz" \
    && printf '%s  %s\n' "$PROTON_BRIDGE_SHA256" /tmp/proton-bridge.deb | sha256sum --check --strict \
    && printf '%s  %s\n' "$PROTON_BRIDGE_SOURCE_SHA256" /tmp/proton-bridge-source.tar.gz | sha256sum --check --strict \
    && dpkg-deb --extract /tmp/proton-bridge.deb /tmp/proton-bridge \
    && install -m 0755 /tmp/proton-bridge/usr/lib/protonmail/bridge/bridge /out/proton-bridge \
    && install -m 0644 /tmp/proton-bridge/usr/share/doc/protonmail/bridge/LICENSE /out/PROTON-BRIDGE-LICENSE \
    && install -m 0644 /tmp/proton-bridge-source.tar.gz /out/PROTON-BRIDGE-SOURCE.tar.gz; \
  fi

FROM node:22-slim AS runtime

WORKDIR /app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/package-lock.json ./package-lock.json
COPY --from=proton-bridge /out/ /usr/local/libexec/
COPY --chmod=755 src/proton/bridge_controller.py ./dist/proton/bridge_controller.py

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    dumb-init \
    gnupg \
    libfido2-1 \
    libglib2.0-0 \
    libsecret-1-0 \
    pass \
    python3 \
  && rm -rf /var/lib/apt/lists/* \
  && rm -rf \
    /usr/local/lib/node_modules/npm \
    /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm \
    /usr/local/bin/npx \
    /usr/local/bin/corepack \
    /usr/local/bin/yarn \
    /usr/local/bin/yarnpkg \
    /opt/yarn-v1.22.22 \
  && mkdir -p /data \
  && chown node:node /data
COPY --chmod=755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
VOLUME ["/data"]

ENV NODE_ENV=production
ENV PROTON_BRIDGE_BINARY=/usr/local/libexec/proton-bridge \
  PROTON_BRIDGE_CONTROLLER_SCRIPT=/app/dist/proton/bridge_controller.py \
  PROTON_BRIDGE_DATA_PATH=/data/proton-bridge \
  PROTON_BRIDGE_PYTHON=/usr/bin/python3 \
  PROTON_BRIDGE_VERSION=3.26.0
EXPOSE 6981

USER node
HEALTHCHECK --interval=15s --timeout=3s --start-period=15s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:6981/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["dumb-init", "--", "docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
