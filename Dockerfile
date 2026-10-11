# ============================================================
# 后端镜像：多阶段构建（builder 编译 TS，runtime 只带产物）
# ============================================================
FROM node:20-bookworm-slim AS builder

WORKDIR /app

# 先装依赖，利用 Docker 层缓存
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

# 再拷源码并编译
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# ---------- 运行阶段 ----------
FROM node:20-bookworm-slim AS runtime

ENV NODE_ENV=production
WORKDIR /app

# better-sqlite3 是原生模块：复制已编译好的 node_modules，避免运行阶段重新编译
COPY package.json package-lock.json* ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

# 数据库目录（docker-compose 挂载卷）
RUN mkdir -p /app/data
ENV DATABASE_PATH=/app/data/sales-agent.db

EXPOSE 3000

# 启动前自动建表 + seed（幂等），然后启动 HTTP 服务
CMD ["sh", "-c", "node dist/db/init-db.js && node dist/index.js"]
