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
# 元项目 seed（首启由 entrypoint 复制到 /home/agent/.pi/agent/meta/）
COPY pi-boxd/seed/ /home/pi-boxd/seed/

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
