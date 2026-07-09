#!/bin/bash
# Run this once in Git Bash from the website folder:
#   cd "C:\Users\kyleh\OneDrive\Documents\LLC\Cleaning\code\website"
#   bash setup-github.sh

set -e

echo "=== Pullman Home Cleaning - GitHub Setup ==="

# 1. Init repo
git init
git branch -M main
git config user.email "kylehebbeler@gmail.com"
git config user.name "Kyle Hebbeler"

# 2. Stage everything
git add -A
git status

# 3. Initial commit
git commit -m "Initial commit: website + email automation functions"

echo ""
echo "=== Git repo ready! ==="
echo ""
echo "Next steps:"
echo "  1. Create a new private repo on GitHub named: pullman-home-cleaning"
echo "     (go to https://github.com/new — make it Private, no README)"
echo "  2. Copy the repo URL (e.g. https://github.com/YOUR_USERNAME/pullman-home-cleaning.git)"
echo "  3. Run these two commands (replace URL with yours):"
echo ""
echo "     git remote add origin https://github.com/YOUR_USERNAME/pullman-home-cleaning.git"
echo "     git push -u origin main"
echo ""
echo "  4. Come back and tell Claude you pushed -- we'll add the secrets next."
