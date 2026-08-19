name: Update GitHub Engineering Metrics

on:
  workflow_dispatch:

  schedule:
    - cron: "17 0 * * *"

permissions:
  contents: write

concurrency:
  group: personal-github-metrics
  cancel-in-progress: true

jobs:
  generate:
    runs-on: ubuntu-latest
    timeout-minutes: 10

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: "24"

      - name: Generate Personal GitHub Metrics
        env:
          GH_TOKEN: ${{ secrets.STATS_TOKEN }}
          GH_USERNAME: ZAKI-MUHAMAD-FADILAH
        run: node .github/scripts/generate-metrics.mjs

      - name: Commit Metrics
        run: |
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"

          git add profile/stats.svg profile/top-langs.svg

          if git diff --cached --quiet; then
            echo "Metrics unchanged."
            exit 0
          fi

          git commit -m "chore: update personal GitHub metrics"
          git push
