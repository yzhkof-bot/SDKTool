# @kingsdk/server —— web 形态部署镜像。
#
# 构建产物（dist/server + dist/web + viewer/templates）打进镜像，
# 以 mode=web 启动：屏蔽一切碰服务器本机文件系统的能力，只接受蓝盾制品 + 上传。
#
# 用法：
#   npm run build            # 先在本机产出 dist/ 与 packages/viewer/templates
#   docker build -t kingsdk-web .
#   docker run -p 7790:7790 \
#     -v /path/to/pipelines.config.json:/app/pipelines.config.json:ro \
#     kingsdk-web

FROM node:20-slim

WORKDIR /app

# 仅拷运行所需产物（server 自包含 bundle + web 静态资源 + viewer 模板）
COPY dist/server ./dist/server
COPY dist/web ./dist/web
COPY packages/viewer/templates ./packages/viewer/templates

ENV NODE_ENV=production
# web 静态资源目录（server 静态托管它）；配置文件路径可用 -e 覆盖
ENV SDKTOOL_STATIC_DIR=/app/dist/web
ENV SDKTOOL_PIPELINES_CONFIG=/app/pipelines.config.json

EXPOSE 7790

# mode=web + 绑所有网卡；HEALTHCHECK 走 /healthz
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "require('http').get('http://127.0.0.1:7790/healthz',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "dist/server/main.cjs", "--mode", "web", "--host", "0.0.0.0", "--port", "7790"]
