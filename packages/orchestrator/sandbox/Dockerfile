# The Sandbox SDK checks SANDBOX_VERSION against @cloudflare/sandbox in packages/orchestrator.
# Each image is pinned by digest and each download by checksum. Renovate bumps both halves of a pair
# together. It finds a download by the comment above it, and pin-sha256.sh writes its checksum.
ARG SANDBOX_VERSION=0.12.11
ARG SANDBOX_DIGEST=sha256:3406de01c37e24b92042afba3a1288fb3fd63fa0cf7784775bce7b7f1ddcc1fc
ARG BUN_TAG=1.4.3-slim
ARG BUN_DIGEST=sha256:14a223fa35747ec728bce300ef85888bc5f7958164d15bbba6a54b22b52a3288
ARG NODE_TAG=24.21.0-bookworm-slim
ARG NODE_DIGEST=sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
# renovate: datasource=github-releases depName=gh packageName=cli/cli
ARG GH_VERSION=2.102.0
ARG GH_URL=https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz
ARG GH_SHA256=bb766f710eef8ede859c18578c72c327597cd4c8a85b06001b1f3843c6019386
# renovate: datasource=github-releases depName=rtk packageName=rtk-ai/rtk
ARG RTK_VERSION=1.0.1
ARG RTK_URL=https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/rtk-oss-x86_64-unknown-linux-musl.tar.gz
ARG RTK_SHA256=a44e8ffc43981100b4ddf1710399a1649a6c874591aa6d0c0727fe6cbd983c41
# renovate: datasource=npm depName=ntn
ARG NTN_VERSION=0.23.19
ARG NTN_URL=https://ntn.dev/releases/v${NTN_VERSION}/ntn-x86_64-unknown-linux-musl.tar.gz
ARG NTN_SHA256=8ba9ea63981d82265428607df1b5c08c541afec40f7d156a2ac7fabcd06d4ce0

# Stage 1: the only thing taken from Cloudflare's image is the control server.
FROM docker.io/cloudflare/sandbox:${SANDBOX_VERSION}@${SANDBOX_DIGEST} AS sandbox-server

# The bun binary comes from the official image, so the pin follows the repo's own version.
FROM docker.io/oven/bun:${BUN_TAG}@${BUN_DIGEST} AS bun

# Stage 2: our own base. Node runs claude-agent-acp. bash, git, and file serve
# the control server. The rest is tooling for the coding agents.
# Cloudflare Containers run linux/amd64, so every download names that architecture.
FROM docker.io/node:${NODE_TAG}@${NODE_DIGEST}
ARG SANDBOX_VERSION
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
