# 容器里跑的是中继（WebSocket + 控制台页）。
# MCP 服务走 stdio，必须与 AI 客户端同机启动，不适合放进容器。
FROM oven/bun:latest

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json tsup.config.ts ./
COPY src ./src

# 中继端口；控制台页在 http://127.0.0.1:3055/
ENV PORT=3055
EXPOSE 3055

CMD ["bun", "run", "src/socket.ts"]
