# 容器內：解開產物到 tmpfs，跑指定腳本
cd /run2189 && tar -xzf /out/nexus-agent-0.0.0-linux-arm64.tar.gz
export R=/run2189/nexus-agent-0.0.0-linux-arm64 B=/run2189/b
export WIRE=$(ls -d $R/node_modules/.pnpm/@nexus+wire*/node_modules/@nexus/wire)/lib/index.js
mkdir -p $B /run2189/mcpdir; cp /h/*.mjs /run2189/; cp /h/mcp-fake.mjs /run2189/mcpdir/; cd /run2189; exec node "$@"
