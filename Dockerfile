# Multi-stage Dockerfile for Plunk
# Creates a single image for self-hosting: API, worker and web dashboard behind nginx.
# The landing page, the docs and the SMTP relay are not built or shipped.
# Use SERVICE environment variable to specify which service to run

# ============================================
# Stage 1: Dependencies (All dependencies for building)
# ============================================
# Use build platform (AMD64) to install dependencies, avoiding QEMU issues
FROM --platform=$BUILDPLATFORM node:24-slim AS deps
ARG TARGETPLATFORM
ARG BUILDPLATFORM
WORKDIR /app

# Install curl for health checks
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

# Enable Corepack and set Yarn version
RUN corepack enable && corepack prepare yarn@4.9.1 --activate

# Copy Yarn configuration and release
COPY .yarnrc.yml ./
COPY .yarn/releases ./.yarn/releases

# Copy package files for dependency installation
COPY package.json yarn.lock ./

# Copy workspace package.json files
# Every workspace listed in the root package.json must be present here, even if
# it is never built or run in the image: `yarn install --immutable` re-resolves
# the whole workspace graph and fails if a manifest is missing, because the
# lockfile it produces would differ from the committed one.
COPY apps/api/package.json ./apps/api/
COPY apps/mcp/package.json ./apps/mcp/
COPY apps/smtp/package.json ./apps/smtp/
COPY apps/web/package.json ./apps/web/
COPY apps/landing/package.json ./apps/landing/
COPY apps/wiki/package.json ./apps/wiki/
COPY packages/db/package.json ./packages/db/
COPY packages/ui/package.json ./packages/ui/
COPY packages/shared/package.json ./packages/shared/
COPY packages/types/package.json ./packages/types/
COPY packages/email/package.json ./packages/email/
COPY packages/typescript-config/package.json ./packages/typescript-config/
COPY packages/eslint-config/package.json ./packages/eslint-config/

# Copy wiki source files for postinstall script (fumadocs-mdx)
COPY apps/wiki/content ./apps/wiki/content
COPY apps/wiki/lib ./apps/wiki/lib
COPY apps/wiki/source.config.ts ./apps/wiki/source.config.ts
COPY apps/wiki/mdx-components.tsx ./apps/wiki/mdx-components.tsx
COPY apps/wiki/next.config.mjs ./apps/wiki/next.config.mjs
COPY apps/wiki/tsconfig.json ./apps/wiki/tsconfig.json

# Install dependencies (runs on build platform, fetches binaries for target platform)
# Use cache mounts for Yarn cache to speed up dependency installation
RUN --mount=type=cache,target=/root/.yarn/berry/cache,sharing=locked \
    --mount=type=cache,target=/root/.cache/yarn,sharing=locked \
    echo "Building on $BUILDPLATFORM for $TARGETPLATFORM" && \
    yarn install --immutable

# ============================================
# Stage 1b: Production Dependencies for the API
# ============================================
# Install only production dependencies needed for the API and worker
FROM --platform=$BUILDPLATFORM node:24-slim AS prod-deps
ARG TARGETPLATFORM
ARG BUILDPLATFORM
WORKDIR /app

# Enable Corepack and set Yarn version
RUN corepack enable && corepack prepare yarn@4.9.1 --activate

# Copy Yarn configuration
COPY .yarnrc.yml ./
COPY .yarn/releases ./.yarn/releases

# Copy all package.json files (needed for workspace resolution)
COPY package.json yarn.lock ./
COPY apps/api/package.json ./apps/api/
COPY packages/db/package.json ./packages/db/
COPY packages/shared/package.json ./packages/shared/
COPY packages/types/package.json ./packages/types/
COPY packages/email/package.json ./packages/email/

# Install ONLY production dependencies for api and its workspace dependencies
# This excludes devDependencies and unneeded workspaces (web, landing, wiki, smtp, ui)
RUN --mount=type=cache,target=/root/.yarn/berry/cache,sharing=locked \
    --mount=type=cache,target=/root/.cache/yarn,sharing=locked \
    echo "Installing production dependencies for API on $BUILDPLATFORM for $TARGETPLATFORM" && \
    yarn workspaces focus api --production

# ============================================
# Stage 2: Builder
# ============================================
# Builder runs on target platform to generate platform-specific artifacts
FROM node:24-slim AS builder
ARG TARGETPLATFORM

# Build-time arguments for URL configuration
# These are only used during the build process, as placeholders baked into the web build
# Runtime URLs are configured via *_DOMAIN and USE_HTTPS environment variables at container startup
ARG API_URI=https://next-api.useplunk.com
ARG DASHBOARD_URI=https://next-app.useplunk.com
ARG LANDING_URI=https://www.useplunk.com
ARG WIKI_URI=https://docs.useplunk.com

WORKDIR /app

# Install OpenSSL for Prisma
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

# Enable Corepack and set Yarn version
RUN corepack enable && corepack prepare yarn@4.9.1 --activate

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/.yarn ./.yarn
COPY --from=deps /app/.yarnrc.yml ./
COPY --from=deps /app/package.json ./
COPY --from=deps /app/yarn.lock ./

# ============================================
# OPTIMIZATION: Copy and build in layers for better Docker cache utilization
# Docker will only rebuild from the first changed layer, not everything
# ============================================

# Copy root config files needed for Turbo
COPY turbo.json ./

# Copy manifest generation script
COPY docker/generate-url-manifest.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/generate-url-manifest.sh

# Step 1: Copy and build shared packages (these change less frequently)
# Shared packages are dependencies for apps, so build them first.
#
# Note on @plunk/mcp: despite the name it lives in apps/, and no stage copies
# apps/mcp source into the builder, so the "@plunk/*" filter below never matches
# it. Do not "fix" this with an explicit --filter="!@plunk/mcp" — turbo errors
# with "No package found with name" when a negative filter names a workspace
# that is not on disk. The MCP server is an stdio binary users run via
# `npx @plunk/mcp`; it is published to npm by npm-publish.yml, not shipped here.
COPY packages ./packages
RUN yarn workspace @plunk/db db:generate
RUN --mount=type=cache,target=/app/.turbo,sharing=locked \
    API_URI=${API_URI} \
    DASHBOARD_URI=${DASHBOARD_URI} \
    LANDING_URI=${LANDING_URI} \
    WIKI_URI=${WIKI_URI} \
    NEXT_PUBLIC_API_URI=${API_URI} \
    NEXT_PUBLIC_DASHBOARD_URI=${DASHBOARD_URI} \
    NEXT_PUBLIC_LANDING_URI=${LANDING_URI} \
    NEXT_PUBLIC_WIKI_URI=${WIKI_URI} \
    yarn turbo build --filter="@plunk/*"

# Step 2: Copy and build API (backend services)
COPY apps/api ./apps/api
RUN --mount=type=cache,target=/app/.turbo,sharing=locked \
    API_URI=${API_URI} \
    DASHBOARD_URI=${DASHBOARD_URI} \
    LANDING_URI=${LANDING_URI} \
    WIKI_URI=${WIKI_URI} \
    NEXT_PUBLIC_API_URI=${API_URI} \
    NEXT_PUBLIC_DASHBOARD_URI=${DASHBOARD_URI} \
    NEXT_PUBLIC_LANDING_URI=${LANDING_URI} \
    NEXT_PUBLIC_WIKI_URI=${WIKI_URI} \
    yarn turbo build --filter=api

# Step 3: Copy and build Web dashboard
COPY apps/web ./apps/web
RUN --mount=type=cache,target=/app/.turbo,sharing=locked \
    API_URI=${API_URI} \
    DASHBOARD_URI=${DASHBOARD_URI} \
    LANDING_URI=${LANDING_URI} \
    WIKI_URI=${WIKI_URI} \
    NEXT_PUBLIC_API_URI=${API_URI} \
    NEXT_PUBLIC_DASHBOARD_URI=${DASHBOARD_URI} \
    NEXT_PUBLIC_LANDING_URI=${LANDING_URI} \
    NEXT_PUBLIC_WIKI_URI=${WIKI_URI} \
    yarn turbo build --filter=web
# Generate sitemap for web
RUN NEXT_PUBLIC_DASHBOARD_URI=${DASHBOARD_URI} yarn workspace web sitemap
# Generate URL replacement manifest for web (build-time optimization)
RUN generate-url-manifest.sh web /app/apps/web

# Copy any remaining root files (if needed)
COPY . .

# Ensure directories exist (create empty ones if build didn't generate them)
RUN mkdir -p \
    apps/web/public \
    apps/web/.next/standalone

# ============================================
# Stage 3: Production Runtime
# ============================================
FROM node:24-alpine AS runner
ARG TARGETPLATFORM
ARG BUILDPLATFORM
WORKDIR /app

# Install OpenSSL for Prisma, curl for health checks, nginx, and gettext (for envsubst)
RUN apk add --no-cache openssl curl nginx gettext

# Install PM2 globally for process management
# Use cache mount and specific version to prevent hangs
RUN --mount=type=cache,target=/root/.npm \
    npm install -g pm2@7.0.4 --prefer-offline --no-audit

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 plunk

# Create nginx directories and set permissions
RUN mkdir -p /var/log/nginx /var/lib/nginx /run/nginx && \
    chown -R plunk:nodejs /var/log/nginx /var/lib/nginx /run/nginx /etc/nginx

# ============================================
# Copy the API service with minimal dependencies
# ============================================

# Copy built API service (API and worker)
COPY --from=builder --chown=plunk:nodejs /app/apps/api/dist ./apps/api/dist

# Copy ONLY production dependencies for the API (excludes dev deps and frontend packages)
COPY --from=prod-deps --chown=plunk:nodejs /app/node_modules ./node_modules

# Copy Prisma client from builder (includes generated client with correct platform binaries)
COPY --from=builder --chown=plunk:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=plunk:nodejs /app/node_modules/@prisma ./node_modules/@prisma

# Copy only the shared packages that are built (not source files)
# These are needed by the API at runtime
COPY --from=builder --chown=plunk:nodejs /app/packages/db/dist ./packages/db/dist
COPY --from=builder --chown=plunk:nodejs /app/packages/db/package.json ./packages/db/package.json
COPY --from=builder --chown=plunk:nodejs /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=plunk:nodejs /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=builder --chown=plunk:nodejs /app/packages/email/dist ./packages/email/dist
COPY --from=builder --chown=plunk:nodejs /app/packages/email/package.json ./packages/email/package.json
COPY --from=builder --chown=plunk:nodejs /app/packages/types/dist ./packages/types/dist
COPY --from=builder --chown=plunk:nodejs /app/packages/types/package.json ./packages/types/package.json

# Copy Prisma schema (needed for migrations at runtime)
COPY --from=builder --chown=plunk:nodejs /app/packages/db/prisma ./packages/db/prisma

# Copy root package.json and workspace config (needed for yarn workspace commands in entrypoint)
COPY --from=builder --chown=plunk:nodejs /app/package.json ./
COPY --from=prod-deps --chown=plunk:nodejs /app/.yarnrc.yml ./
COPY --from=prod-deps --chown=plunk:nodejs /app/.yarn ./.yarn
COPY --from=prod-deps --chown=plunk:nodejs /app/yarn.lock ./

# Copy API package.json file
COPY --from=builder --chown=plunk:nodejs /app/apps/api/package.json ./apps/api/

# ============================================
# Copy the Next.js web dashboard with its standalone build
# ============================================
# Next.js standalone mode bundles all dependencies internally, so we don't need
# to copy node_modules for it - it's completely self-contained

# Web app - standalone build with static assets
COPY --from=builder --chown=plunk:nodejs /app/apps/web/.next/standalone ./apps/web/.next/standalone
COPY --from=builder --chown=plunk:nodejs /app/apps/web/public ./apps/web/.next/standalone/apps/web/public
COPY --from=builder --chown=plunk:nodejs /app/apps/web/.next/static ./apps/web/.next/standalone/apps/web/.next/static
# Copy URL replacement manifests to standalone directory
COPY --from=builder --chown=plunk:nodejs /app/apps/web/.next/url-manifest.txt ./apps/web/.next/standalone/apps/web/.next/url-manifest.txt
COPY --from=builder --chown=plunk:nodejs /app/apps/web/.next/sitemap-manifest.txt ./apps/web/.next/standalone/apps/web/.next/sitemap-manifest.txt

# ============================================
# Copy runtime configuration
# ============================================

# Copy nginx configuration templates and setup script
COPY --chown=plunk:nodejs docker/nginx/ /app/docker/nginx/
RUN chmod +x /app/docker/nginx/setup-nginx.sh

# Copy optimized URL replacement script
COPY --chown=plunk:nodejs docker/replace-urls-optimized.sh /app/docker/
RUN chmod +x /app/docker/replace-urls-optimized.sh

# Copy entrypoint script
COPY --chown=plunk:nodejs docker-entrypoint-nginx.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint-nginx.sh

USER plunk

# Expose nginx port (default 80)
EXPOSE 80

# Health check through nginx
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:${NGINX_PORT:-80}/ || exit 1

# Default to running all services via entrypoint
ENV SERVICE=all

ENTRYPOINT ["docker-entrypoint-nginx.sh"]
