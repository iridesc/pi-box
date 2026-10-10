# Pi + pi-boxd 常驻容器，容器内 cron 驱动周期任务
# 镜像里同时预装 pi CLI（供 cron 调用）和 pi-boxd（多 agent 管理台）
FROM node:24-slim

# 容器内不走宿主代理（apt 和 npm 都受影响）；用国内镜像
ENV HTTP_PROXY= HTTPS_PROXY= http_proxy= https_proxy= NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1

# 基础工具
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      cron ca-certificates git \
      curl wget jq python3 \
 && rm -rf /var/lib/apt/lists/*

# 预装 pi 本体（供 cron 调用，生成会话）
RUN npm config set registry https://registry.npmmirror.com
RUN npm install -g @earendil-works/pi-coding-agent

# pi-boxd：分步 COPY 减少 npm install 缓存失效
COPY pi-boxd/package.json pi-boxd/package-lock.json /home/pi-boxd/app/
WORKDIR /home/pi-boxd/app
RUN npm config set registry https://registry.npmmirror.com && npm install --omit=dev --no-audit --no-fund
COPY pi-boxd/src/ /home/pi-boxd/app/src/
COPY pi-boxd/web/ /home/pi-boxd/app/web/

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
COPY bin/pi-job /usr/local/bin/pi-job
COPY bin/pi-run /usr/local/bin/pi-run
# 通用系统提示词模板 + cron-jobs skill（首启时由 entrypoint 安装）
COPY system-prompt/ /opt/pi-box/
COPY skills/ /opt/pi-box/skills/
RUN chmod +x /entrypoint.sh /usr/local/bin/pi-job /usr/local/bin/pi-run \
 && mkdir -p /workspace/.cron/logs /workspace/.pi /home/agent/.pi-boxd

EXPOSE 8790

ENTRYPOINT ["/entrypoint.sh"]
