#!/bin/sh
set -e

# Generate URL Replacement Manifest
# This script runs at BUILD TIME, after `next build` has written the static export to <app_dir>/out.
# It checks that the export can be served as plain files by nginx, then lists the files that contain
# placeholder URLs so the container does not have to scan the whole export at startup.

APP_NAME=$1
APP_DIR=$2

if [ -z "$APP_NAME" ] || [ -z "$APP_DIR" ]; then
  echo "Usage: $0 <app_name> <app_dir>"
  echo "Example: $0 web /app/apps/web"
  exit 1
fi

OUT_DIR="$APP_DIR/out"
NEXT_DIR="$APP_DIR/.next"

if [ ! -d "$OUT_DIR" ]; then
  echo "❌ $OUT_DIR not found: $APP_NAME must be built with output: 'export'"
  exit 1
fi

echo "🔍 Checking that $APP_NAME can be served as a static export..."

# next build only warns about features a static export drops, so fail here instead:
# API routes, middleware and custom redirects/rewrites/headers would silently stop working,
# and nginx only resolves dynamic pages exported as <section>/[id].html
node -e '
const dir = process.argv[1];
const read = file => JSON.parse(require("fs").readFileSync(`${dir}/${file}`, "utf8"));
const problems = [];

const pages = Object.keys(read("server/pages-manifest.json"));
pages.filter(page => page === "/api" || page.startsWith("/api/")).forEach(page => problems.push(`API route ${page}`));

const middleware = read("server/middleware-manifest.json");
if (Object.keys(middleware.middleware || {}).length || Object.keys(middleware.functions || {}).length) {
  problems.push("middleware");
}

const routes = read("routes-manifest.json");
routes.redirects.filter(redirect => !redirect.internal).forEach(redirect => problems.push(`redirect ${redirect.source}`));
const rewrites = Array.isArray(routes.rewrites) ? routes.rewrites : Object.values(routes.rewrites).flat();
rewrites.forEach(rewrite => problems.push(`rewrite ${rewrite.source}`));
routes.headers.forEach(header => problems.push(`headers ${header.source}`));
routes.dynamicRoutes
  .filter(route => !/^\/[^/[\]]+\/\[id\]$/.test(route.page))
  .forEach(route => problems.push(`dynamic route ${route.page} (nginx only maps /<section>/[id])`));

if (problems.length) {
  console.error("❌ The static export would drop or break:");
  problems.forEach(problem => console.error(`   - ${problem}`));
  console.error("   Extend the dashboard rules in docker/nginx/nginx.conf.template or serve it with next start again.");
  process.exit(1);
}
' "$NEXT_DIR"

# Define placeholder URLs that will be replaced at runtime
PLACEHOLDER_API="https://next-api.useplunk.com"
PLACEHOLDER_DASHBOARD="https://next-app.useplunk.com"
PLACEHOLDER_LANDING="https://www.useplunk.com"
PLACEHOLDER_WIKI="https://docs.useplunk.com"

# Kept in .next, which git and Docker ignore, so a stray local copy can never replace it
MANIFEST_FILE="$NEXT_DIR/url-manifest.txt"

echo "🔍 Generating URL manifest for $APP_NAME..."

# Paths are relative to the export, which the image copies to <app_dir>/out
(cd "$OUT_DIR" && find . -type f \
  -exec grep -l -E "$PLACEHOLDER_API|$PLACEHOLDER_DASHBOARD|$PLACEHOLDER_LANDING|$PLACEHOLDER_WIKI" {} \;) \
  2>/dev/null | sed 's|^\./||' > "$MANIFEST_FILE" || true

FILE_COUNT=$(wc -l < "$MANIFEST_FILE" | tr -d ' ')

# The dashboard always calls the API through a placeholder URL: an empty manifest means
# the placeholders changed and the container would ship a dashboard pointing elsewhere
if [ "$FILE_COUNT" -eq 0 ]; then
  echo "❌ No file in $OUT_DIR contains a placeholder URL; check the build-time URIs"
  exit 1
fi

echo "✅ Generated manifest for $APP_NAME: $FILE_COUNT files need URL replacement"
echo "   Manifest saved to: $MANIFEST_FILE"

exit 0
