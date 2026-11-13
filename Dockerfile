# syntax=docker/dockerfile:1
# pi-boxd 持久化多 Agent 管理台
FROM node:24-slim

# 容器内不走宿主代理（apt 和 npm 都受影响）；用国内镜像
ENV HTTP_PROXY= HTTPS_PROXY= http_proxy= https_proxy= NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1

# 基础工具
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates git \
      curl wget jq python3 \
 && rm -rf /var/lib/apt/lists/*

# pi-boxd：分步 COPY 减少 npm install 缓存失效
COPY pi-boxd/package.json pi-boxd/package-lock.json /home/pi-boxd/app/
WORKDIR /home/pi-boxd/app
RUN npm config set registry https://registry.npmmirror.com && npm install --omit=dev --no-audit --no-fund
COPY pi-boxd/src/ /home/pi-boxd/app/src/
COPY pi-boxd/web/ /home/pi-boxd/app/web/
# 文档随镜像分发：元项目助理靠它做「自省」（读自己的实现），必须可在容器内读到。
# README 面向人，docs/ 面向 agent（架构索引 + 能力变更日志）。
COPY README.md /home/pi-boxd/app/README.md
COPY docs/ /home/pi-boxd/app/docs/
# 元项目 seed（首启由 entrypoint 复制到 /home/agent/.pi/agent/meta/）
COPY pi-boxd/seed/ /home/pi-boxd/seed/

# msg-hub（stdio 版消息渠道 MCP）：构建期从独立仓库拉取最新源码内置到镜像。
# msg-hub 在 iridesc/msg-hub 独立开源迭代，pi-box 只在打包时取最新版（不 vendor）。
# MSG_HUB_REF 可指定分支/标签/commit；离线或内网构建可用 --build-arg MSG_HUB_REPO=<镜像地址>。
ARG MSG_HUB_REPO=https://github.com/iridesc/msg-hub.git
ARG MSG_HUB_REF=main
RUN set -eu; \
    git clone --depth 1 --branch "$MSG_HUB_REF" "$MSG_HUB_REPO" /opt/msg-hub; \
    rm -rf /opt/msg-hub/.git /opt/msg-hub/data /opt/msg-hub/tests \
           /opt/msg-hub/Dockerfile /opt/msg-hub/compose.yaml /opt/msg-hub/.github; \
    python3 -c "import sys; sys.path.insert(0, '/opt/msg-hub/src'); import msg_hub; print('[build] msg-hub', msg_hub.__version__)"; \
    python3 -c "import sys; sys.path.insert(0, '/opt/msg-hub/src'); from msg_hub.settings import Settings; from msg_hub.service import Hub; print('[build] msg-hub 类型:', [t['type'] for t in Hub(Settings()).types()])"

# rootless 容器（podman）中 root 即宿主机当前用户，bind mount 目录天然可写。
ENV HOME=/home/agent

# pi-boxd 数据目录（持久卷挂载到这里）
ENV PI_BOXD_DATA_DIR=/home/agent/.pi-boxd
ENV PI_BOXD_WEB_DIR=/home/pi-boxd/app/web
# 工作区（项目根，挂载）
ENV PI_BOX_WORKSPACE=/workspace
ENV PORT=8790

# 工作区（挂载）与入口
WORKDIR /workspace
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh \
 && mkdir -p /workspace /home/agent/.pi-boxd /home/agent/.pi/agent

EXPOSE 8790

ENTRYPOINT ["/entrypoint.sh"]
