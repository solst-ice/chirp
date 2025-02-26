#!/bin/bash

# Clean build folders
echo "Cleaning previous build artifacts..."
rm -rf dist
rm -rf node_modules/.vite

# Build the project
echo "Building project..."
npm run build

# Create a .nojekyll file to prevent GitHub Pages from ignoring files that begin with an underscore
echo "Adding .nojekyll file..."
touch dist/.nojekyll

# Deploy to GitHub Pages
echo "Deploying to GitHub Pages..."
npx gh-pages -d dist --dotfiles

echo "Deployment complete! Your site should be available at https://solst-ice.github.io/chirp" 