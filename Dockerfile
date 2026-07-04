# Multi-stage Dockerfile for LangGraph.js Agent Service

# Stage 1: Build the application
FROM node:20-bookworm AS builder

# Set working directory
WORKDIR /usr/src/app

# Copy dependency manifests
COPY package*.json ./

# Install all dependencies (including devDependencies for compilation) and build native modules from source
RUN npm ci --build-from-source

# Copy TypeScript configuration and source files
COPY tsconfig.json ./
COPY src/ ./src/

# Compile TypeScript to JavaScript (outputs to dist/)
RUN npm run build

# Prune development dependencies to keep production footprint minimal
RUN npm prune --production

# Stage 2: Production runtime image
FROM node:20-bookworm-slim AS runner

# Set environment to production
ENV NODE_ENV=production
ENV PORT=8080

WORKDIR /usr/src/app

# Copy runtime files and package configuration
COPY --from=builder /usr/src/app/package*.json ./
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/dist ./dist

# Expose port 8080 as configured in the AWS terraform settings
EXPOSE 8080

# Start the REST API server by default
CMD ["node", "dist/server.js"]
