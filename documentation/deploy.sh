#!/usr/bin/env bash
#
# Publish documentation/site/ to GitHub Pages.
#
# WHY A SEPARATE BRANCH. The site is build output. Committing it to main would put a
# rendered copy of every page next to its source, so a reviewer reading the diff sees the
# same prose twice and cannot tell which one is authored. gh-pages is an orphan branch:
# no shared history, nothing of it reaches main, and it can be force-pushed freely because
# it holds nothing that is not regenerable from documentation/pages/.
#
# Run: bash documentation/deploy.sh
set -euo pipefail

cd "$(dirname "$0")/.."
SITE="documentation/site"
BRANCH="gh-pages"

command -v gh >/dev/null || { echo "  gh CLI not found"; exit 1; }
gh auth status >/dev/null 2>&1 || { echo "  gh is not authenticated"; exit 1; }

echo "  building"
node documentation/build.mjs

[ -f "$SITE/index.html" ] || { echo "  $SITE/index.html missing, build produced nothing"; exit 1; }
PAGES=$(find "$SITE" -name '*.html' | wc -l)
echo "  $PAGES html files"

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
OWNER=${REPO%%/*}
NAME=${REPO##*/}
URL="https://${OWNER}.github.io/${NAME}/"

# A worktree rather than a branch switch: the working tree stays exactly as it is, so this
# is safe to run with uncommitted work in progress, which is the normal state during an
# event.
TMP=$(mktemp -d)
trap 'git worktree remove --force "$TMP" 2>/dev/null || true; rm -rf "$TMP"' EXIT

if git show-ref --quiet "refs/heads/$BRANCH"; then
  git worktree add --force "$TMP" "$BRANCH" >/dev/null
else
  git worktree add --force --detach "$TMP" >/dev/null
  git -C "$TMP" checkout --orphan "$BRANCH" >/dev/null 2>&1
fi

# Clear the worktree without touching .git, then copy the fresh build in.
find "$TMP" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
cp -r "$SITE"/. "$TMP"/
touch "$TMP/.nojekyll"

git -C "$TMP" add -A
if git -C "$TMP" diff --cached --quiet; then
  echo "  no change to publish"
else
  # No AI attribution, ever, on any branch of this repository.
  git -C "$TMP" commit -q -m "docs: publish the Orma documentation site"
  git -C "$TMP" push -q --force origin "$BRANCH"
  echo "  pushed $BRANCH"
fi

# Enabling Pages is idempotent and fails harmlessly when it is already on.
gh api -X POST "repos/$REPO/pages" -f "source[branch]=$BRANCH" -f "source[path]=/" >/dev/null 2>&1 \
  && echo "  Pages enabled on $BRANCH" \
  || echo "  Pages already configured, or needs enabling by hand in Settings > Pages"

echo ""
echo "  $URL"
echo "  First publish can take a minute or two to go live."
