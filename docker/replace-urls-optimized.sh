#!/bin/sh
set -e

# Optimized URL Replacement Script
# Uses a pre-generated manifest to avoid expensive find+grep operations at runtime

# replace_urls_in_app <app> <app_dir>: the static export lives in <app_dir>/out and the
# manifest generated at build time in <app_dir>/url-manifest.txt
replace_urls_in_app() {
  local app=$1
  local app_dir=$2
  local out_dir="$app_dir/out"

  echo "📝 Replacing URLs in $app build files..."

  # Define placeholder URLs (built into the app at compile time)
  local PLACEHOLDER_API="https://next-api.useplunk.com"
  local PLACEHOLDER_DASHBOARD="https://next-app.useplunk.com"
  local PLACEHOLDER_LANDING="https://www.useplunk.com"
  local PLACEHOLDER_WIKI="https://docs.useplunk.com"

  # Use pre-generated manifest instead of scanning all files
  local manifest_file="$app_dir/url-manifest.txt"

  if [ ! -f "$manifest_file" ]; then
    echo "   ⚠️  Warning: Manifest file not found at $manifest_file"
    echo "   This suggests the build process didn't complete correctly."
    echo "   Falling back to runtime file scanning (slower)..."

    # Same list as the build-time manifest: paths relative to the export
    local temp_file_list="/tmp/replace_urls_${app}.txt"
    (cd "$out_dir" && find . -type f \
      -exec grep -l -E "$PLACEHOLDER_API|$PLACEHOLDER_DASHBOARD|$PLACEHOLDER_LANDING|$PLACEHOLDER_WIKI" {} \;) \
      2>/dev/null | sed 's|^\./||' > "$temp_file_list" || true
    manifest_file="$temp_file_list"
  fi

  # Count files from manifest
  local file_count=$(wc -l < "$manifest_file" | tr -d ' ')
  echo "   📊 Processing $file_count files from manifest"

  if [ "$file_count" -gt 0 ]; then
    # The manifest contains paths relative to the export (e.g. _next/static/chunks/abc.js, sitemap.xml)
    cat "$manifest_file" | while IFS= read -r rel_path; do
      # Construct full runtime path
      runtime_path="$out_dir/$rel_path"

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

  # A failed write inside the loop does not stop the script, so check the result: a dashboard
  # still pointing at the placeholders cannot reach this installation's API
  if grep -rqE "$PLACEHOLDER_API|$PLACEHOLDER_DASHBOARD|$PLACEHOLDER_LANDING|$PLACEHOLDER_WIKI" "$out_dir"; then
    echo "❌ ERROR: placeholder URLs are still present in $out_dir"
    exit 1
  fi

  echo "✅ URL replacement complete for $app"
}

# Export the function so it can be sourced by other scripts
if [ "$1" != "" ]; then
  # If called directly with arguments, execute the function
  replace_urls_in_app "$1" "$2"
fi
