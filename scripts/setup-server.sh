#!/bin/sh
# Paper test server, bound to this machine by default, RCON with a generated password.
# Set SERVER_IP=0.0.0.0 to let the bot (or players) on another machine join, and ONLINE_MODE=true
# to require real Mojang/Microsoft accounts. Running this means you accept the Minecraft EULA
# (https://aka.ms/MinecraftEULA).
set -e
cd "$(dirname "$0")/../server"
VERSION="${MC_VERSION:-1.21.4}"
if [ ! -f paper.jar ]; then
  URL=$(curl -s "https://fill.papermc.io/v3/projects/paper/versions/$VERSION/builds" \
    | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const b=JSON.parse(d);const s=b.find(x=>x.channel==="STABLE")||b[0];console.log(s.downloads["server:default"].url)})')
  curl -sL -o paper.jar "$URL"
fi
[ -f .rcon_password ] || (openssl rand -hex 12 > .rcon_password && chmod 600 .rcon_password)
echo "eula=true" > eula.txt
cat > server.properties <<PROPS
online-mode=${ONLINE_MODE:-false}
server-ip=${SERVER_IP:-127.0.0.1}
server-port=${SERVER_PORT:-25565}
spawn-protection=0
difficulty=easy
gamemode=survival
level-seed=${SEED:-layacraft}
view-distance=8
simulation-distance=8
max-players=4
enable-rcon=true
rcon.port=25575
rcon.password=$(cat .rcon_password)
broadcast-rcon-to-ops=false
PROPS
echo "Server ready. Start it with: npm run server"
