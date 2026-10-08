# The Sandbox SDK checks SANDBOX_VERSION against @cloudflare/sandbox in packages/orchestrator.
# Each image is pinned by digest and each download by checksum. Bump both halves of a pair together.
ARG SANDBOX_VERSION=0.12.10
ARG SANDBOX_DIGEST=sha256:35c932d3e5b35f28d350800cf00551cac46dfe28274afb54e16325b8d8f560d1
ARG BUN_VERSION=1.4.2
ARG BUN_DIGEST=sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61
ARG NODE_VERSION=24.21.0
ARG NODE_DIGEST=sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ARG GH_VERSION=2.102.0
ARG GH_SHA256=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386
ARG RTK_VERSION=0.50.0
ARG RTK_SHA256=bc2b8902b0d9c796c82ef45f16ae2307e17757afeca5ee156235a3dc7bda5f89
ARG NTN_VERSION=0.23.13
ARG NTN_SHA256=af9f8ee86001547343838eddfd0ed24c6b09eae4ca4d32d5441f5d99aa7730c6

# Stage 1: the only thing taken from Cloudflare's image is the control server.
FROM docker.io/cloudflare/sandbox:${SANDBOX_VERSION}@${SANDBOX_DIGEST} AS sandbox-server

# The bun binary comes from the official image, so the pin follows the repo's own version.
FROM docker.io/oven/bun:${BUN_VERSION}-slim@${BUN_DIGEST} AS bun

# Stage 2: our own base. Node runs claude-agent-acp. bash, git, and file serve
# the control server. The rest is tooling for the coding agents.
# Cloudflare Containers run linux/amd64, so every download names that architecture.
FROM docker.io/node:${NODE_VERSION}-bookworm-slim@${NODE_DIGEST}
ARG SANDBOX_VERSION
ARG GH_VERSION
ARG GH_SHA256
ARG RTK_VERSION
ARG RTK_SHA256
ARG NTN_VERSION
ARG NTN_SHA256
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git file jq lsof unzip ripgrep python3 \
  && rm -rf /var/lib/apt/lists/*

# The GitHub CLI.
RUN cd /tmp \
  && GH_ASSET=gh_${GH_VERSION}_linux_amd64.tar.gz \
  && curl -fsSLO "https://github.com/cli/cli/releases/download/v${GH_VERSION}/${GH_ASSET}" \
  && echo "${GH_SHA256}  ${GH_ASSET}" | sha256sum --check \
  && tar -xzf "${GH_ASSET}" --strip-components=2 -C /usr/local/bin "gh_${GH_VERSION}_linux_amd64/bin/gh" \
  && rm "${GH_ASSET}"

# The coding agent harnesses, at the versions and hashes of the lockfile. OpenCode's install
# script runs the binary it picks, which hangs in an emulated build, so the binary is linked here.
COPY packages/orchestrator/sandbox/agents/package.json packages/orchestrator/sandbox/agents/package-lock.json /opt/agents/
RUN cd /opt/agents \
  && npm ci --ignore-scripts \
  && npm cache clean --force \
  && rm -rf node_modules/@opencode/cli-linux-x64-* \
  && ln -s /opt/agents/node_modules/.bin/claude-agent-acp /opt/agents/node_modules/@opencode/cli-linux-x64/bin/opencode /usr/local/bin/

RUN cd /tmp \
  && RTK_ASSET=rtk-x86_64-unknown-linux-musl.tar.gz \
  && curl -fsSLO "https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/${RTK_ASSET}" \
  && echo "${RTK_SHA256}  ${RTK_ASSET}" | sha256sum --check \
  && tar -xzf "${RTK_ASSET}" -C /usr/local/bin rtk \
  && rm "${RTK_ASSET}"

# The Notion CLI, for tasks whose pages live on Notion.
RUN cd /tmp \
  && NTN_ASSET=ntn-x86_64-unknown-linux-musl.tar.gz \
  && curl -fsSLO "https://ntn.dev/releases/v${NTN_VERSION}/${NTN_ASSET}" \
  && echo "${NTN_SHA256}  ${NTN_ASSET}" | sha256sum --check \
  && tar -xzf "${NTN_ASSET}" --strip-components=1 -C /usr/local/bin ntn-x86_64-unknown-linux-musl/ntn \
  && rm "${NTN_ASSET}"

# Copy sandbox, bridge, and bun
COPY --from=sandbox-server /container-server/sandbox /sandbox
COPY --chmod=0755 packages/sandbox-bridge/dist/artfct-bridge /usr/local/bin/artfct-bridge
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s bun /usr/local/bin/bunx
COPY LICENSE NOTICE packages/orchestrator/sandbox/NOTICES.md /usr/share/doc/artfct/

# The SDK reads SANDBOX_VERSION. The interpreter pools need files we do not ship.
ENV SANDBOX_VERSION=${SANDBOX_VERSION} \
    PYTHON_POOL_MIN_SIZE=0 \
    JAVASCRIPT_POOL_MIN_SIZE=0 \
    TYPESCRIPT_POOL_MIN_SIZE=0
# Everything runs as the unprivileged user of the node image.
RUN mkdir -p /workspace && chown node:node /workspace
USER node
ENV HOME=/home/node
WORKDIR /workspace
EXPOSE 3000
ENTRYPOINT ["/sandbox"]
