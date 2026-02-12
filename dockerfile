FROM docker.m.daocloud.io/library/node:22-trixie AS executor-build

WORKDIR /opt/executor

COPY executor/package*.json ./
RUN npm ci

COPY executor/tsconfig.json ./tsconfig.json
COPY executor/src ./src

RUN npm run build && npm prune --omit=dev

FROM docker.m.daocloud.io/library/node:22-trixie

ARG DEBIAN_FRONTEND=noninteractive
ARG APT_MIRROR=mirrors.aliyun.com
ARG TTYD_VERSION=1.7.7

ENV TZ=Asia/Shanghai \
  LANG=C.UTF-8 \
  LC_ALL=C.UTF-8 \
  NONINTERACTIVE=1 \
  UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple \
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
  SASS_BINARY_SITE=https://npmmirror.com/mirrors/node-sass/ \
  PHANTOMJS_CDNURL=https://npmmirror.com/mirrors/phantomjs/ \
  SHARP_BINARY_HOST=https://npmmirror.com/mirrors/sharp \
  SHARP_LIBVIPS_BINARY_HOST=https://npmmirror.com/mirrors/sharp-libvips


# -----------------------
# 1) 大陆 apt 源 + 基础依赖 + 中文字体 + 时区
# -----------------------
RUN set -eux; \
  if [ -f /etc/apt/sources.list ]; then \
  sed -i "s|http://deb.debian.org|http://${APT_MIRROR}|g; s|http://security.debian.org|http://${APT_MIRROR}|g" /etc/apt/sources.list; \
  fi; \
  if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
  sed -i "s|http://deb.debian.org|http://${APT_MIRROR}|g; s|http://security.debian.org|http://${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
  fi; \
  apt-get update; \
  apt-get install -y --no-install-recommends \
  ca-certificates curl wget gnupg dirmngr \
  tzdata locales \
  bash git file zip 7zip sqlite3 jq ripgrep \
  procps \
  pandoc nano vim chromium \
  fontconfig \
  graphicsmagick dos2unix ffmpeg htop gettext default-mysql-client postgresql-client tree \
  tmux \
  fonts-noto-cjk fonts-noto-color-emoji fonts-wqy-zenhei fonts-wqy-microhei fonts-arphic-ukai fonts-arphic-uming \
  python3 python3-pip python3-venv \
  build-essential pkg-config \
  texlive-xetex texlive-lang-chinese texlive-fonts-recommended; \
  ln -snf /usr/share/zoneinfo/${TZ} /etc/localtime; \
  echo ${TZ} > /etc/timezone; \
  rm -rf /var/lib/apt/lists/*

# -----------------------
# 1.5) 安装 ttyd (binary release)
# -----------------------
RUN set -eux; \
  arch="$(dpkg --print-architecture)"; \
  case "${arch}" in \
  amd64) ttyd_arch="x86_64" ;; \
  arm64) ttyd_arch="aarch64" ;; \
  armhf) ttyd_arch="armhf" ;; \
  i386) ttyd_arch="i686" ;; \
  s390x) ttyd_arch="s390x" ;; \
  *) echo "Unsupported arch: ${arch}" >&2; exit 1 ;; \
  esac; \
  curl -fsSL -o "/tmp/ttyd.${ttyd_arch}" "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${ttyd_arch}"; \
  curl -fsSL -o /tmp/SHA256SUMS "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/SHA256SUMS"; \
  (cd /tmp && grep "ttyd.${ttyd_arch}$" SHA256SUMS | sha256sum -c -); \
  install -m 0755 "/tmp/ttyd.${ttyd_arch}" /usr/local/bin/ttyd; \
  rm -f "/tmp/ttyd.${ttyd_arch}" /tmp/SHA256SUMS

# -----------------------
# 2) npm 镜像 + 常用工具
# -----------------------
RUN set -eux; \
  npm config -g set registry https://registry.npmmirror.com; \
  npm install -g npm@latest pnpm

# -----------------------
# 3) pip 镜像 + 安装 uv
# -----------------------
RUN set -eux; \
  python3 -m pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple; \
  python3 -m pip config set global.trusted-host pypi.tuna.tsinghua.edu.cn; \
  python3 -m pip install --no-cache-dir -U uv --break-system-packages


# -----------------------
# 4) 安装 opencode
# -----------------------
RUN set -eux; \
  npm i -g @anthropic-ai/claude-code@latest @google/gemini-cli@latest @qwen-code/qwen-code@latest @openai/codex@latest opencode-ai@latest

# -----------------------
# -----------------------
# 5) .bashrc Proxy & Color
# -----------------------
RUN { \
  echo 'export HTTP_PROXY="http://mihomo:7890"'; \
  echo 'export HTTPS_PROXY="http://mihomo:7890"'; \
  echo 'export ALL_PROXY="socks5://mihomo:7890"'; \
  echo 'export http_proxy="http://mihomo:7890"'; \
  echo 'export https_proxy="http://mihomo:7890"'; \
  echo 'export all_proxy="socks5://mihomo:7890"'; \
  echo 'export TERM=xterm-256color'; \
  echo "alias ls='ls --color=auto'"; \
  echo "alias grep='grep --color=auto'"; \
  echo "alias ll='ls -al'"; \
  echo "export PS1='\[\033[01;32m\]\u@\h\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]\$ '"; \
  } >> /root/.bashrc

# -----------------------
# 5.5) 设置中文为系统默认字体
# -----------------------
RUN cat > /etc/fonts/local.conf <<'EOF'
<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <alias>
    <family>sans-serif</family>
    <prefer>
      <family>Noto Sans CJK SC</family>
      <family>WenQuanYi Zen Hei</family>
      <family>WenQuanYi Micro Hei</family>
      <family>AR PL UKai CN</family>
      <family>AR PL UMing CN</family>
      <family>DejaVu Sans</family>
      <family>Noto Color Emoji</family>
    </prefer>
  </alias>
  <alias>
    <family>serif</family>
    <prefer>
      <family>Noto Serif CJK SC</family>
      <family>AR PL UMing CN</family>
      <family>DejaVu Serif</family>
      <family>Noto Color Emoji</family>
    </prefer>
  </alias>
  <alias>
    <family>monospace</family>
    <prefer>
      <family>Noto Sans Mono CJK SC</family>
      <family>WenQuanYi Zen Hei Mono</family>
      <family>DejaVu Sans Mono</family>
      <family>Noto Color Emoji</family>
    </prefer>
  </alias>
</fontconfig>
EOF

# -----------------------
# 6) 集成 executor 服务运行时
# -----------------------
COPY --from=executor-build /opt/executor/package.json /opt/executor/package.json
COPY --from=executor-build /opt/executor/package-lock.json /opt/executor/package-lock.json
COPY --from=executor-build /opt/executor/node_modules /opt/executor/node_modules
COPY --from=executor-build /opt/executor/dist /opt/executor/dist

WORKDIR /opt/executor

EXPOSE 8090

CMD ["node", "dist/server.js"]
