#!/bin/sh
# Build the static site and publish out/ to the gh-pages branch (GitHub Pages
# serves that branch). Usage: npm run deploy
set -e
cd "$(dirname "$0")/.."
BASE_PATH=/op1-loops npm run build:pages
cd out
rm -rf .git
git init -q -b gh-pages
git add -A
git commit -q -m "Publish the site"
git push -f "$(git -C .. remote get-url origin)" gh-pages
rm -rf .git
