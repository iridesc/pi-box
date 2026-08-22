# Pi + pi-web 常驻容器，容器内 cron 驱动周期任务
# 镜像里同时预装 pi CLI（供 cron 调用）和 pi-web（Web 界面）
FROM node:24-slim

# 基础工具：cron 定时任务；git pi 常用工具；
# curl/wget/jq/python3 网络请求与数据处理（agent 与脚本任务常用）；
# procps(ps/pgrep) netcat 端口检查 dnsutils(dig) iputils-ping 网络排查
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      cron ca-certificates git \
      curl wget jq python3 \
      procps netcat-openbsd dnsutils iputils-ping \
 && rm -rf /var/lib/apt/lists/*

# 预装 pi 本体与 pi-web
RUN npm install -g @earendil-works/pi-coding-agent @agegr/pi-web

# rootless 容器（podman）中 root 即宿主机当前用户，bind mount 目录天然可写。
# 若在 rootful Docker 下使用，建议自行加回非 root 用户并处理挂载属主。
ENV HOME=/home/agent

# 工作区（挂载）与入口
WORKDIR /workspace
COPY entrypoint.sh /entrypoint.sh
COPY bin/pi-job /usr/local/bin/pi-job
COPY bin/pi-run /usr/local/bin/pi-run
# 通用系统提示词模板 + cron-jobs skill（首启时由 entrypoint 安装）
COPY system-prompt/ /opt/pi-box/
COPY skills/ /opt/pi-box/skills/
RUN chmod +x /entrypoint.sh /usr/local/bin/pi-job /usr/local/bin/pi-run \
 && mkdir -p /workspace/.cron/logs /workspace/.pi

ENTRYPOINT ["/entrypoint.sh"]
