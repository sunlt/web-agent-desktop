#!/bin/bash
set -e

# Configuration
APT_MIRROR="mirrors.aliyun.com"
TZ="Asia/Shanghai"
DEBIAN_FRONTEND="noninteractive"

# Determine if we need sudo
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
    SUDO="sudo"
fi

echo "Initializing WSL2 Debian environment..."

# -----------------------
# 1) 大陆 apt 源 + 基础依赖 + 中文字体 + 时区
# -----------------------
echo "Setting up APT sources and installing base packages..."

# Backup original sources
if [ ! -f /etc/apt/sources.list.bak ]; then
    $SUDO cp /etc/apt/sources.list /etc/apt/sources.list.bak
fi
if [ -f /etc/apt/sources.list.d/debian.sources ] && [ ! -f /etc/apt/sources.list.d/debian.sources.bak ]; then
    $SUDO cp /etc/apt/sources.list.d/debian.sources /etc/apt/sources.list.d/debian.sources.bak
fi

# Update sources to mirror
if [ -f /etc/apt/sources.list ]; then
    $SUDO sed -i "s|http://deb.debian.org|http://${APT_MIRROR}|g; s|http://security.debian.org|http://${APT_MIRROR}|g" /etc/apt/sources.list
fi
if [ -f /etc/apt/sources.list.d/debian.sources ]; then
    $SUDO sed -i "s|http://deb.debian.org|http://${APT_MIRROR}|g; s|http://security.debian.org|http://${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources
fi

# Update and install packages
$SUDO apt-get update
$SUDO DEBIAN_FRONTEND=${DEBIAN_FRONTEND} apt-get install -y --no-install-recommends \
    ca-certificates curl wget gnupg dirmngr \
    tzdata locales \
    bash git file zip 7zip sqlite3 jq ripgrep \
    procps \
    pandoc nano vim chromium \
    fontconfig \
    graphicsmagick dos2unix ffmpeg htop gettext default-mysql-client postgresql-client tree \
    fonts-noto-cjk fonts-wqy-zenhei fonts-wqy-microhei fonts-arphic-ukai fonts-arphic-uming \
    cron \
    python3 python3-pip python3-venv \
    default-jre default-jdk maven \
    build-essential pkg-config

# Configure Timezone
$SUDO ln -snf /usr/share/zoneinfo/${TZ} /etc/localtime
echo ${TZ} | $SUDO tee /etc/timezone

# -----------------------
# 2) npm 镜像 + 常用工具
# -----------------------
echo "Setting up NPM and tools..."
if ! command -v node &> /dev/null; then
    echo "Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | $SUDO -E bash -
    $SUDO apt-get install -y nodejs
fi

$SUDO npm config -g set registry https://registry.npmmirror.com
$SUDO npm install -g npm@latest pnpm

# -----------------------
# 3) Maven 镜像
# -----------------------
echo "Configuring Maven..."
mkdir -p ~/.m2
cat > ~/.m2/settings.xml <<'EOF'
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
echo "Configuring Pip and installing uv..."
python3 -m pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple
python3 -m pip config set global.trusted-host pypi.tuna.tsinghua.edu.cn
python3 -m pip install --no-cache-dir -U uv --break-system-packages

# -----------------------
# 5) 安装 AI CLI 工具
# -----------------------
echo "Installing AI CLI tools..."
$SUDO npm i -g @anthropic-ai/claude-code@latest @google/gemini-cli@latest @qwen-code/qwen-code@latest @openai/codex@latest

# -----------------------
# 6) .bashrc Proxy & Color
# -----------------------
echo "Configuring .bashrc..."
if ! grep -q "PS1=" ~/.bashrc; then
    cat >> ~/.bashrc <<'EOF'

export TERM=xterm-256color
alias ls='ls --color=auto'
alias grep='grep --color=auto'
alias ll='ls -al'
export PS1='\[\033[01;32m\]\u@\h\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]\$ '
# -----------------------------
EOF
fi

# -----------------------
# 6.5) 设置中文为系统默认字体
# -----------------------
echo "Configuring Fonts..."
$SUDO mkdir -p /etc/fonts
$SUDO tee /etc/fonts/local.conf > /dev/null <<'EOF'
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
# 8) 辅助脚本
# -----------------------
echo "Creating update-opencode script..."

# Update script
cat > ~/update-opencode.sh <<'EOF'
#!/bin/bash
set -e
npm i -g @anthropic-ai/claude-code@latest @google/gemini-cli@latest @qwen-code/qwen-code@latest @openai/codex@latest
EOF
chmod +x ~/update-opencode.sh

echo "Initialization complete!"
