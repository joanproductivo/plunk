#!/bin/sh
set -e

# Optimized URL Replacement Script
# Uses pre-generated manifests to avoid expensive find+grep operations at runtime

replace_urls_in_app() {
  local app=$1
  local app_dir=$2

  echo "📝 Replacing URLs in $app build files..."

  # Define placeholder URLs (built into the app at compile time)
  local PLACEHOLDER_API="https://next-api.useplunk.com"
  local PLACEHOLDER_DASHBOARD="https://next-app.useplunk.com"
  local PLACEHOLDER_LANDING="https://www.useplunk.com"
  local PLACEHOLDER_WIKI="https://docs.useplunk.com"

  # Use pre-generated manifest instead of scanning all files
  local manifest_file="$app_dir/.next/url-manifest.txt"

  if [ ! -f "$manifest_file" ]; then
    echo "   ⚠️  Warning: Manifest file not found at $manifest_file"
    echo "   This suggests the build process didn't complete correctly."
    echo "   Falling back to runtime file scanning (slower)..."

    # Fallback to old method if manifest doesn't exist
    local temp_file_list="/tmp/replace_urls_${app}.txt"
    find "$app_dir/.next" -type f \( -name "*.js" -o -name "*.json" -o -name "*.html" -o -name "*.rsc" \) \
      -exec grep -l -E "$PLACEHOLDER_API|$PLACEHOLDER_DASHBOARD|$PLACEHOLDER_LANDING|$PLACEHOLDER_WIKI" {} \; \
      2>/dev/null > "$temp_file_list" || true
    manifest_file="$temp_file_list"
  fi

  # Count files from manifest
  local file_count=$(wc -l < "$manifest_file" | tr -d ' ')
  echo "   📊 Processing $file_count files from manifest"

  if [ "$file_count" -gt 0 ]; then
    # Process files line by line
    # The manifest now contains RELATIVE paths (e.g., .next/static/chunks/abc.js)
    # We just need to prepend the app_dir
    
    cat "$manifest_file" | while IFS= read -r rel_path; do
      # Construct full runtime path
      runtime_path="$app_dir/$rel_path"
      
      if [ -f "$runtime_path" ]; then
        sed -e "s|$PLACEHOLDER_API|$API_URI|g" \
            -e "s|$PLACEHOLDER_DASHBOARD|$DASHBOARD_URI|g" \
            -e "s|$PLACEHOLDER_LANDING|$LANDING_URI|g" \
            -e "s|$PLACEHOLDER_WIKI|$WIKI_URI|g" \
            "$runtime_path" > "${runtime_path}.tmp" && mv "${runtime_path}.tmp" "$runtime_path"
      fi
    done

    echo "   ✅ Successfully replaced URLs in files"
  else
    echo "   ℹ️  No files found with placeholder URLs"
  fi

  # Process sitemap and robots.txt from manifest
  echo "   🗺️  Processing sitemap and robots.txt..."
  local sitemap_manifest="$app_dir/.next/sitemap-manifest.txt"

  if [ -f "$sitemap_manifest" ]; then
    while IFS= read -r rel_path; do
      # Manifest contains relative paths, just prepend app_dir
      runtime_sitemap_path="$app_dir/$rel_path"
      
      if [ -f "$runtime_sitemap_path" ]; then
        sed -e "s|$PLACEHOLDER_API|$API_URI|g" \
            -e "s|$PLACEHOLDER_DASHBOARD|$DASHBOARD_URI|g" \
            -e "s|$PLACEHOLDER_LANDING|$LANDING_URI|g" \
            -e "s|$PLACEHOLDER_WIKI|$WIKI_URI|g" \
            "$runtime_sitemap_path" > "${runtime_sitemap_path}.tmp" && mv "${runtime_sitemap_path}.tmp" "$runtime_sitemap_path"
      fi
    done < "$sitemap_manifest"
  else
    # Fallback to finding sitemaps at runtime
    find "$app_dir/public" -type f \( -name "sitemap*.xml" -o -name "robots.txt" \) 2>/dev/null | while IFS= read -r sitemap_file; do
      if [ -f "$sitemap_file" ]; then
        sed -e "s|$PLACEHOLDER_API|$API_URI|g" \
            -e "s|$PLACEHOLDER_DASHBOARD|$DASHBOARD_URI|g" \
            -e "s|$PLACEHOLDER_LANDING|$LANDING_URI|g" \
            -e "s|$PLACEHOLDER_WIKI|$WIKI_URI|g" \
            "$sitemap_file" > "${sitemap_file}.tmp" && mv "${sitemap_file}.tmp" "$sitemap_file"
      fi
    done
  fi

  # Generate .env file for server-side Next.js standalone
  cat > "$app_dir/.env" << EOF
# Runtime environment configuration
# Generated at container startup from environment variables
API_URI=${API_URI}
DASHBOARD_URI=${DASHBOARD_URI}
LANDING_URI=${LANDING_URI}
WIKI_URI=${WIKI_URI}
EOF

  echo "✅ URL replacement complete for $app"
}

# Export the function so it can be sourced by other scripts
if [ "$1" != "" ]; then
  # If called directly with arguments, execute the function
  replace_urls_in_app "$1" "$2"
fi
