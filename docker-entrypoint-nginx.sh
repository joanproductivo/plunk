#!/bin/sh
set -e

# Nginx-enabled Docker Entrypoint for Plunk
# Starts all Plunk services with nginx reverse proxy

echo "🚀 Starting Plunk with Nginx reverse proxy..."
echo "📦 Service: ${SERVICE:-all}"

# Only run with SERVICE=all for nginx setup
if [ "$SERVICE" != "all" ]; then
    echo "⚠️  This nginx-enabled image only supports SERVICE=all"
    echo "   For individual services, use the standard Plunk image"
    exit 1
fi

# Run database migrations
echo "🗄️  Running database migrations..."
# Call Prisma binary directly for fastest startup (avoids Yarn workspace resolution and npx overhead)
# The Prisma client and schema are already available from the build
if ! /app/node_modules/.bin/prisma migrate deploy --schema=/app/packages/db/prisma/schema.prisma; then
  echo ""
  echo "❌ ERROR: Database migration failed!"
  echo "   The container cannot start with failed migrations."
  echo "   Please check:"
  echo "   1. DATABASE_URL is set correctly"
  echo "   2. Database server is accessible from this container"
  echo "   3. Database credentials are valid"
  echo "   4. Migration logs above for specific errors"
  echo ""
  exit 1
fi
echo "✅ Database migrations completed successfully"

# Setup nginx configuration and source it to get env vars
. /app/docker/nginx/setup-nginx.sh

# Verify environment variables are set
echo "🔍 Domain configuration:"
echo "   API_DOMAIN=${API_DOMAIN}"
echo "   DASHBOARD_DOMAIN=${DASHBOARD_DOMAIN}"
echo "   LANDING_DOMAIN=${LANDING_DOMAIN}"
echo "   WIKI_DOMAIN=${WIKI_DOMAIN}"
echo "   USE_HTTPS=${USE_HTTPS}"
echo ""
echo "🔗 Generated URIs:"
echo "   API_URI=${API_URI}"
echo "   DASHBOARD_URI=${DASHBOARD_URI}"
echo "   LANDING_URI=${LANDING_URI}"
echo "   WIKI_URI=${WIKI_URI}"

echo ""
echo "ℹ️  URLs are generated at runtime from domain configuration"
echo "   To use custom domains, set these environment variables:"
echo "   API_DOMAIN=api.example.com"
echo "   DASHBOARD_DOMAIN=app.example.com"
echo "   LANDING_DOMAIN=www.example.com"
echo "   WIKI_DOMAIN=docs.example.com"
echo "   USE_HTTPS=true"

# Source the optimized URL replacement script
. /app/docker/replace-urls-optimized.sh

# Replace URLs in the web dashboard using optimized function
# This uses pre-generated manifests from build time instead of scanning all files
replace_urls_in_app "web" "/app/apps/web/.next/standalone/apps/web"

echo "📋 Starting services with PM2..."

# Create PM2 ecosystem file with environment variables
cat > /tmp/ecosystem.config.js << PMEOF
module.exports = {
  apps: [
    {
      name: 'nginx',
      script: 'nginx',
      args: '-g "daemon off;"',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false
    },
    {
      name: 'api',
      script: '/app/apps/api/dist/app.js',
      cwd: '/app',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 8080,
        API_URI: '${API_URI}',
        DASHBOARD_URI: '${DASHBOARD_URI}',
        LANDING_URI: '${LANDING_URI}',
        WIKI_URI: '${WIKI_URI}'
      }
    },
    {
      name: 'worker',
      script: '/app/apps/api/dist/jobs/worker.js',
      cwd: '/app',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
        API_URI: '${API_URI}',
        DASHBOARD_URI: '${DASHBOARD_URI}',
        LANDING_URI: '${LANDING_URI}',
        WIKI_URI: '${WIKI_URI}'
      }
    },
    {
      name: 'web',
      script: 'apps/web/server.js',
      cwd: '/app/apps/web/.next/standalone',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: 'production',
        PORT: 3000,
        HOSTNAME: '0.0.0.0',
        API_URI: '${API_URI}',
        DASHBOARD_URI: '${DASHBOARD_URI}',
        LANDING_URI: '${LANDING_URI}',
        WIKI_URI: '${WIKI_URI}'
      }
    }
  ]
};
PMEOF

# Display configuration summary
echo ""
echo "✅ Configuration complete!"
echo ""
echo "🌐 Your Plunk instance will be available at:"
echo "   API: http://${API_DOMAIN}"
echo "   Dashboard: http://${DASHBOARD_DOMAIN}"
echo ""
echo "🚀 Starting all services..."
echo ""

# Start all services with PM2
exec pm2-runtime start /tmp/ecosystem.config.js
