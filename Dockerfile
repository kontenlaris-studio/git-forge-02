# Git Forge — a from-scratch GitHub-compatible forge (git smart HTTP, REST v3,
# GraphQL v4, MCP) in pure TypeScript with zero dependencies.
# Node 24 runs the TypeScript sources directly (type stripping), so there is
# no install or build step.
FROM node:24-alpine

WORKDIR /app
COPY . .

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.ts"]
