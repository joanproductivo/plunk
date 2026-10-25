#!/bin/sh
set -e

# Nginx Setup Script for Plunk
# Configures nginx reverse proxy with subdomain-based routing

echo "🔧 Configuring nginx reverse proxy..."

NGINX_CONFIG_DIR="/etc/nginx"
NGINX_CONF_D="${NGINX_CONFIG_DIR}/conf.d"

# Create nginx directories if they don't exist
mkdir -p "${NGINX_CONF_D}"

echo "🌐 Using subdomain-based routing"

# Set defaults if not provided
export API_DOMAIN="${API_DOMAIN:-api.localhost}"
export DASHBOARD_DOMAIN="${DASHBOARD_DOMAIN:-app.localhost}"
export LANDING_DOMAIN="${LANDING_DOMAIN:-www.localhost}"
export WIKI_DOMAIN="${WIKI_DOMAIN:-docs.localhost}"
export NGINX_PORT="${NGINX_PORT:-80}"
export USE_HTTPS="${USE_HTTPS:-false}"

# Determine protocol based on USE_HTTPS
if [ "$USE_HTTPS" = "true" ]; then
    PROTOCOL="https"
else
    PROTOCOL="http"
fi

# Validate required environment variables
if [ -z "$API_DOMAIN" ] || [ -z "$DASHBOARD_DOMAIN" ] || [ -z "$LANDING_DOMAIN" ]; then
    echo "⚠️  Warning: Some domain variables are not set. Using defaults."
    echo "   API_DOMAIN=${API_DOMAIN}"
    echo "   DASHBOARD_DOMAIN=${DASHBOARD_DOMAIN}"
    echo "   LANDING_DOMAIN=${LANDING_DOMAIN}"
    echo "   WIKI_DOMAIN=${WIKI_DOMAIN}"
fi

# Auto-configure API URIs based on domains and protocol
export API_URI="${API_URI:-${PROTOCOL}://${API_DOMAIN}}"
export DASHBOARD_URI="${DASHBOARD_URI:-${PROTOCOL}://${DASHBOARD_DOMAIN}}"
export LANDING_URI="${LANDING_URI:-${PROTOCOL}://${LANDING_DOMAIN}}"
export WIKI_URI="${WIKI_URI:-${PROTOCOL}://${WIKI_DOMAIN}}"

# Generate nginx configuration from template
echo "📝 Generating nginx configuration..."

envsubst '${NGINX_PORT} ${API_DOMAIN} ${DASHBOARD_DOMAIN}' \
    < /app/docker/nginx/nginx.conf.template \
    > "${NGINX_CONF_D}/plunk.conf"

# Always create nginx.conf (overwrite default from package)
cat > "${NGINX_CONFIG_DIR}/nginx.conf" << 'EOF'
worker_processes auto;
error_log /var/log/nginx/error.log warn;
pid /run/nginx/nginx.pid;

events {
    worker_connections 1024;
}

http {
    include /etc/nginx/mime.types;
    default_type application/octet-stream;

    log_format main '$remote_addr - $remote_user [$time_local] "$request" '
                    '$status $body_bytes_sent "$http_referer" '
                    '"$http_user_agent" "$http_x_forwarded_for"';

    access_log /var/log/nginx/access.log main;

    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    types_hash_max_size 2048;
    server_names_hash_bucket_size 128;

    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml text/javascript application/json application/javascript application/xml+rss application/rss+xml font/truetype font/opentype application/vnd.ms-fontobject image/svg+xml;

    # Include server configurations
    include /etc/nginx/conf.d/*.conf;
}
EOF

# Stop the container on an invalid configuration: under PM2 a broken nginx would just
# keep restarting while the API and worker run unreachable behind it
if ! nginx -t; then
    echo "❌ ERROR: invalid nginx configuration (see above)"
    exit 1
fi

echo "✅ Nginx configuration complete!"
echo "   Config file: ${NGINX_CONF_D}/plunk.conf"
echo "   API Domain: ${API_DOMAIN}"
echo "   Dashboard Domain: ${DASHBOARD_DOMAIN}"
