FROM docker.m.daocloud.io/library/node:22-trixie

ARG DEBIAN_FRONTEND=noninteractive
ARG APT_MIRROR=mirrors.aliyun.com

ENV TZ=Asia/Shanghai \
  LANG=C.UTF-8 \
  LC_ALL=C.UTF-8 \
  NONINTERACTIVE=1 \
  HOMEBREW_NO_ANALYTICS=1 \
  HOMEBREW_NO_AUTO_UPDATE=1 \
  UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple \
  ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
  SASS_BINARY_SITE=https://npmmirror.com/mirrors/node-sass/ \
  PHANTOMJS_CDNURL=https://npmmirror.com/mirrors/phantomjs/ \
  SHARP_BINARY_HOST=https://npmmirror.com/mirrors/sharp \
  SHARP_LIBVIPS_BINARY_HOST=https://npmmirror.com/mirrors/sharp-libvips \
  HOMEBREW_BREW_GIT_REMOTE=http://mirrors.tuna.tsinghua.edu.cn/git/homebrew/brew.git \
  HOMEBREW_CORE_GIT_REMOTE=http://mirrors.tuna.tsinghua.edu.cn/git/homebrew/homebrew-core.git \
  HOMEBREW_API_DOMAIN=http://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/api \
  HOMEBREW_BOTTLE_DOMAIN=http://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles \
  HOMEBREW_PIP_INDEX_URL=https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple \
  HOMEBREW_INSTALL_FROM_API=1


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
  fonts-noto-cjk fonts-wqy-zenhei fonts-wqy-microhei fonts-arphic-ukai fonts-arphic-uming \
  openssh-server cron \
  python3 python3-pip python3-venv \
  default-jre default-jdk maven \
  build-essential pkg-config; \
  ln -snf /usr/share/zoneinfo/${TZ} /etc/localtime; \
  echo ${TZ} > /etc/timezone; \
  rm -rf /var/lib/apt/lists/*

# -----------------------
# 2) npm 镜像 + 常用工具
# -----------------------
RUN set -eux; \
  npm config -g set registry https://registry.npmmirror.com; \
  npm install -g npm@latest pnpm

# -----------------------
# 3) Maven 镜像
# -----------------------
RUN mkdir -p /root/.m2; \
  cat > /root/.m2/settings.xml <<'EOF'
<settings xmlns="http://maven.apache.org/SETTINGS/1.0.0"
          xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
          xsi:schemaLocation="http://maven.apache.org/SETTINGS/1.0.0 https://maven.apache.org/xsd/settings-1.0.0.xsd">
  <mirrors>
    <mirror>
      <id>aliyunmaven</id>
      <mirrorOf>*</mirrorOf>
      <name>Aliyun Maven Mirror</name>
      <url>https://maven.aliyun.com/repository/public</url>
    </mirror>
  </mirrors>
</settings>
EOF

# -----------------------
# 4) pip 镜像 + 安装 uv
# -----------------------
RUN set -eux; \
  python3 -m pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple; \
  python3 -m pip config set global.trusted-host pypi.tuna.tsinghua.edu.cn; \
  python3 -m pip install --no-cache-dir -U uv --break-system-packages


# -----------------------
# 5) 安装 opencode
# -----------------------
RUN set -eux; \
  npm i -g @anthropic-ai/claude-code@latest @google/gemini-cli@latest @qwen-code/qwen-code@latest @openai/codex@latest \
  npm install -g opencode-ai openclaw --registry=https://registry.npmjs.org

# -----------------------
# -----------------------
# 6) .bashrc Proxy & Color
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
# 6.5) 设置中文为系统默认字体
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
    </prefer>
  </alias>
  <alias>
    <family>serif</family>
    <prefer>
      <family>Noto Serif CJK SC</family>
      <family>AR PL UMing CN</family>
      <family>DejaVu Serif</family>
    </prefer>
  </alias>
  <alias>
    <family>monospace</family>
    <prefer>
      <family>Noto Sans Mono CJK SC</family>
      <family>WenQuanYi Zen Hei Mono</family>
      <family>DejaVu Sans Mono</family>
    </prefer>
  </alias>
</fontconfig>
EOF

# -----------------------
# 7) sshd 配置 (构建阶段完成)
# -----------------------
RUN set -eux; \
  sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config; \
  sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config; \
  sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config; \
  mkdir -p /var/run/sshd; \
  ssh-keygen -A

# -----------------------
# 8) 入口脚本
# -----------------------
RUN cat > /usr/local/bin/start-opencode <<'EOF'
#!/bin/bash
set -e

/usr/sbin/cron
/usr/sbin/sshd
exec opencode web --port 4096 --hostname 0.0.0.0
EOF
RUN chmod +x /usr/local/bin/start-opencode

RUN cat > /usr/local/bin/update-opencode <<'EOF'
#!/bin/bash
set -e

npm i -g @anthropic-ai/claude-code@latest @google/gemini-cli@latest @qwen-code/qwen-code@latest @openai/codex@latest
npm install -g opencode-ai openclaw --registry=https://registry.npmjs.org
EOF
RUN chmod +x /usr/local/bin/update-opencode

RUN cat > /etc/cron.d/opencode-update <<'EOF'
# 每天 03:00 自动更新 opencode
0 3 * * * root /usr/local/bin/update-opencode >> /var/log/opencode-update.log 2>&1
EOF
RUN chmod 0644 /etc/cron.d/opencode-update

# -----------------------
# 9) /root 外部挂载目录
# -----------------------
VOLUME ["/root"]
WORKDIR /root

EXPOSE 4096 22

CMD ["/usr/local/bin/start-opencode"]
