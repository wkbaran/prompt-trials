# Control app + promptfoo viewer in one image. See docker/compose.example.yaml for the volumes it expects.
FROM node:26 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:26-slim
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json tsconfig.json ./
COPY src src
# The app writes a generated config next to each suite's own when it starts a run.
COPY --chown=node:node suites suites
RUN mkdir -p recordings fixtures output cases .promptfoo && chown node:node recordings fixtures output cases .promptfoo
USER node
ENV HOST=0.0.0.0 PORT=5180 VIEWER_PORT=15500 PRIVATE_CASES_DIR=/app/cases
EXPOSE 5180 15500
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5180)+'/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/app/server.ts"]
