#!/usr/bin/env bash
# 国服与国际服鱼类候选目录同步：只下载数据并调用已存在的转换器，不执行上游脚本。
set -euo pipefail
: "${GH_TOKEN:?Missing GitHub read token}"
if [[ "${DRY_RUN:-0}" != "1" ]]; then
  : "${CLOUDFLARE_API_TOKEN:?Missing Cloudflare deployment token}"
  : "${CLOUDFLARE_ACCOUNT_ID:?Missing Cloudflare account ID}"
fi
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
sha_global=$(gh api repos/icykoneko/ff14-fish-tracker-app/commits/master --jq '.sha')
sha_cn=$(gh api repos/thewakingsands/ffxiv-datamining-cn/commits/master --jq '.sha')
if [[ ! "$sha_global" =~ ^[a-f0-9]{40}$ || ! "$sha_cn" =~ ^[a-f0-9]{40}$ ]]; then
  echo "上游版本 SHA 非法，停止导入" >&2; exit 1
fi
download() {
  curl --fail --silent --show-error --location --retry 3 --max-time 120 \
    --output "$1" "https://raw.githubusercontent.com/$2/$3"
  test -s "$1"
}
download "$tmp/data.js" "icykoneko/ff14-fish-tracker-app" "$sha_global/js/app/data.js"
for sheet in Item FishParameter Weather FishingSpot PlaceName; do
  download "$tmp/$sheet.csv" "thewakingsands/ffxiv-datamining-cn" "$sha_cn/$sheet.csv"
done
node scripts/prepare-fish-tracker-import.mjs "$tmp/data.js" global "$sha_global" "$tmp/global.json"
node scripts/prepare-fish-cn-import.mjs "$tmp/global.json" "$tmp/data.js" \
  "$tmp/Item.csv" "$tmp/FishParameter.csv" "$tmp/Weather.csv" \
  "$tmp/FishingSpot.csv" "$tmp/PlaceName.csv" "$sha_cn" "$tmp/cn.json"
node --experimental-strip-types scripts/prepare-fish-import.mjs "$tmp/cn.json" "$tmp/cn.sql"
node --experimental-strip-types scripts/prepare-fish-import.mjs "$tmp/global.json" "$tmp/global.sql"
if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "两个区服数据转换和完整 Schema 校验通过（dry-run，未连接 Cloudflare）"
  exit 0
fi
# 小批量幂等 upsert；若失败，中断并保留线上已有目录。下次运行可重试汇聚。
for region in cn global; do
  split -l 150 -d -a 3 --additional-suffix=.sql "$tmp/$region.sql" "$tmp/$region-"
  for file in "$tmp/$region-"*.sql; do
    pnpm exec wrangler d1 execute DB --remote --env production --file "$file"
  done
  echo "$region 鱼类目录导入完毕，来源规则：$sha_global；国服表：$sha_cn"
done
