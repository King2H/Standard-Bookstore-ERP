FROM node:20-alpine

WORKDIR /app

# Copy workspace manifests
COPY package.json ./
COPY packages/shared/package.json ./packages/shared/
COPY apps/api/package.json ./apps/api/

# Install all dependencies (tsx, typescript, node-pg-migrate are devDeps in apps/api)
RUN npm install --workspace=apps/api --workspace=packages/shared

# Copy source files
COPY tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY apps/api ./apps/api

# Make startup script executable
RUN chmod +x /app/apps/api/start.sh

EXPOSE 3000

# Run migrations then start server
CMD ["/bin/sh", "/app/apps/api/start.sh"]
