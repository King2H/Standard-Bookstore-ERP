FROM node:20-alpine

WORKDIR /app

# Copy workspace root package files
COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/

# Install dependencies
RUN npm install --workspace=apps/api --workspace=packages/shared

# Copy source
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

WORKDIR /app/apps/api

EXPOSE 3000

CMD ["npx", "tsx", "src/server.ts"]
