FROM node:20-alpine

WORKDIR /app

# Copy workspace manifests
COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/

# Install all dependencies including devDeps (tsx and typescript are devDeps)
RUN npm install --workspace=apps/api --workspace=packages/shared

# Copy source files
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

WORKDIR /app/apps/api

EXPOSE 3000

# Run TypeScript directly with tsx — tsx is hoisted to root node_modules by npm workspaces
CMD ["/app/node_modules/.bin/tsx", "src/server.ts"]
