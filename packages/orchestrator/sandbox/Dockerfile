# SANDBOX_VERSION equals @cloudflare/sandbox in packages/orchestrator, whose Files helper runs sandbox-shim.
# Each image is pinned by digest and each download by checksum. Renovate bumps both halves of a pair
# together. It finds a download by the comment above it, and pin-sha256.sh writes its checksum.
ARG SANDBOX_VERSION=1.0.3
ARG SANDBOX_DIGEST=sha256:fc1740c3cba26461f0ab1771287c84018ab2cca43a70ebb823087c85d780aaec
ARG BUN_TAG=1.4.4-slim
ARG BUN_DIGEST=sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4
ARG NODE_TAG=24.22.1-bookworm-slim
ARG NODE_DIGEST=sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c
# renovate: datasource=github-releases depName=gh packageName=cli/cli
ARG GH_VERSION=2.103.3
ARG GH_URL=https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz
ARG GH_SHA256=4c806978ffce1cec70853302a56d70ac6da4f19bae7adca4e1a8ab00633dd91d
# renovate: datasource=github-releases depName=rtk packageName=rtk-ai/rtk
ARG RTK_VERSION=1.1.0
ARG RTK_URL=https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/rtk-oss-x86_64-unknown-linux-musl.tar.gz
ARG RTK_SHA256=4dec94a64035e08189ae82fd5408fe4ae9ae27a665fc07e3e3ec3c4c2d8e8a3e
# renovate: datasource=npm depName=ntn
ARG NTN_VERSION=0.23.25
ARG NTN_URL=https://ntn.dev/releases/v${NTN_VERSION}/ntn-x86_64-unknown-linux-musl.tar.gz
ARG NTN_SHA256=99faf81af403553b66d0f06a466ba6ba6b0e2708fb6b8f1eac2cf7ad1d5db47f

# Stage 1: the only thing taken from Cloudflare's image is sandbox-shim.
FROM docker.io/cloudflare/sandbox:${SANDBOX_VERSION}@${SANDBOX_DIGEST} AS sandbox-shim

# The bun binary comes from the official image, so the pin follows the repo's own version.
FROM docker.io/oven/bun:${BUN_TAG}@${BUN_DIGEST} AS bun

# Stage 2: our own base. Node runs claude-agent-acp. bash and git run the startup
# script. The rest is tooling for the coding agents.
# Cloudflare Containers run linux/amd64, so every download names that architecture.
FROM docker.io/node:${NODE_TAG}@${NODE_DIGEST}
ARG GH_VERSION
ARG GH_URL
ARG GH_SHA256
ARG RTK_URL
ARG RTK_SHA256
ARG NTN_URL
ARG NTN_SHA256
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git file jq lsof unzip ripgrep python3 \
  && rm -rf /var/lib/apt/lists/*

# The GitHub CLI.
RUN cd /tmp \
  && curl -fsSLo gh.tar.gz "${GH_URL}" \
  && echo "${GH_SHA256}  gh.tar.gz" | sha256sum --check \
  && tar -xzf gh.tar.gz --strip-components=2 -C /usr/local/bin "gh_${GH_VERSION}_linux_amd64/bin/gh" \
  && rm gh.tar.gz

# The coding agent harnesses, at the versions and hashes of the lockfile. OpenCode's install
# script runs the binary it picks, which hangs in an emulated build, so the binary is linked here.
COPY packages/orchestrator/sandbox/agents/package.json packages/orchestrator/sandbox/agents/package-lock.json /opt/agents/
RUN cd /opt/agents \
  && npm ci --ignore-scripts \
  && npm cache clean --force \
  && rm -rf node_modules/@opencode/cli-linux-x64-* \
  && ln -s /opt/agents/node_modules/.bin/claude-agent-acp /opt/agents/node_modules/@opencode/cli-linux-x64/bin/opencode /usr/local/bin/

# rtk-oss, the Apache-2.0 edition of rtk. The default rtk build adds BUSL-1.1 code.
RUN cd /tmp \
  && curl -fsSLo rtk.tar.gz "${RTK_URL}" \
  && echo "${RTK_SHA256}  rtk.tar.gz" | sha256sum --check \
  && tar -xzf rtk.tar.gz -C /usr/local/bin rtk \
  && rm rtk.tar.gz

# The Notion CLI, for tasks whose pages live on Notion.
RUN cd /tmp \
  && curl -fsSLo ntn.tar.gz "${NTN_URL}" \
  && echo "${NTN_SHA256}  ntn.tar.gz" | sha256sum --check \
  && tar -xzf ntn.tar.gz --strip-components=1 -C /usr/local/bin ntn-x86_64-unknown-linux-musl/ntn \
  && rm ntn.tar.gz

# Copy sandbox-shim, bridge, and bun
COPY --from=sandbox-shim /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
COPY --chmod=0755 packages/sandbox-bridge/dist/artfct-bridge /usr/local/bin/artfct-bridge
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s bun /usr/local/bin/bunx
COPY LICENSE NOTICE packages/orchestrator/sandbox/NOTICES.md /usr/share/doc/artfct/

# Everything runs as the unprivileged user of the node image.
RUN mkdir -p /workspace && chown node:node /workspace
USER node
ENV HOME=/home/node
WORKDIR /workspace
# The Durable Object runs every command through exec, so the container only has to stay up.
ENTRYPOINT ["sleep", "infinity"]
