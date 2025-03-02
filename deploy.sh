#!/bin/bash

# Exit on error
set -e

echo "===== CHIRP DEPLOYMENT SCRIPT ====="

# Clean build folders
echo "Cleaning previous build artifacts..."
rm -rf dist
rm -rf node_modules/.vite

# Install dependencies
echo "Making sure dependencies are up to date..."
npm install

# Check TypeScript files
echo "Checking TypeScript files..."
echo "TypeScript version: $(npx tsc --version)"
npx tsc --noEmit

if [ $? -ne 0 ]; then
  echo "TypeScript check failed. Please fix the errors above before deploying."
  exit 1
fi

# Build the project
echo "Building project..."
npm run build

if [ $? -ne 0 ]; then
  echo "Build failed. Please check the errors above."
  exit 1
fi

# Verify the build output
echo "Verifying build output..."
if [ ! -d "dist" ]; then
  echo "Error: 'dist' directory was not created during build."
  exit 1
fi

if [ ! -f "dist/index.html" ]; then
  echo "Error: 'dist/index.html' was not created during build."
  exit 1
fi

# Create a .nojekyll file to prevent GitHub Pages from ignoring files that begin with an underscore
echo "Adding .nojekyll file..."
touch dist/.nojekyll

# Create a simple 404.html that redirects to index.html
echo "Creating 404.html for SPA routing..."
cat > dist/404.html << EOL
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Chirp - Redirecting</title>
  <script>
    window.location.href = "/";
  </script>
</head>
<body>
  <p>Redirecting to main page...</p>
</body>
</html>
EOL

# Deploy to GitHub Pages
echo "Deploying to GitHub Pages..."
npx gh-pages -d dist --dotfiles

if [ $? -ne 0 ]; then
  echo "Deployment failed. Please check the errors above."
  exit 1
fi

echo "Deployment complete! Your site should be available at https://chirp.hex.dance"
echo "Note: It may take a few minutes for GitHub Pages to update." 