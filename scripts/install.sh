#!/bin/sh
# 一条命令装好这个插件：构建 lib/ + 接进 dsh profile。
#
#   sh scripts/install.sh                 # 默认接进 desktop profile
#   sh scripts/install.sh --profile=web   # 指定 profile
#   sh scripts/install.sh --dry-run       # 只打印要做什么，一个字节都不改
#
# 做两件事（都可重复执行，已经做过的会跳过）：
#   1. npm install && npm run build —— lib/ 是构建产物，仓库里不带；
#   2. 接进 dsh profile：package.json 里加 link: 依赖 + 加进 dsh.profile.bundles
#      + 建 node_modules 符号链接（改前先备份 package.json）。
#
# 之后要重启一次 DeepSeek Harness：宿主启动时才扫描插件清单，热替换不重读。
set -eu

DRY_RUN=0
PROFILE_NAME=""
while [ $# -gt 0 ]; do
	case "$1" in
		--dry-run) DRY_RUN=1 ;;
		--profile) PROFILE_NAME="${2:-}"; shift ;;
		--profile=*) PROFILE_NAME="${1#*=}" ;;
		-h|--help)
			sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
			exit 0 ;;
		*)
			echo "未知参数：$1（-h 看用法）" >&2
			exit 2 ;;
	esac
	shift
done

DIR=$(cd "$(dirname "$0")/.." && pwd)
printf '插件目录: %s\n' "$DIR"
[ "$DRY_RUN" = 1 ] && printf '模式: --dry-run（只打印，不改任何文件）\n'
echo

# ---- 1. 构建 lib/ ----------------------------------------------------------
printf '1) 构建 lib/（src/*.ts → lib/*.js）\n'
if [ "$DRY_RUN" = 1 ]; then
	echo "   [dry-run] 会跑 npm install && npm run build"
elif ! command -v npm >/dev/null 2>&1; then
	echo "   ⚠ 没有 npm —— 需要 Node 22.6+ 才能构建（profile 直接加载 lib/）" >&2
	exit 1
else
	if (cd "$DIR" && npm install --no-audit --no-fund >/dev/null 2>&1 && npm run build >/dev/null 2>&1); then
		echo "   构建完成（先删掉 lib/ 再跑本脚本可强制重建）"
	else
		echo "   ⚠ 构建失败 —— profile 会加载不到 lib/index.js 与 lib/client.js" >&2
		exit 1
	fi
fi

# ---- 2. 接进 dsh profile ---------------------------------------------------
printf '\n2) 接进 dsh profile\n'
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
if [ -z "$PROFILE_NAME" ]; then
	# 优先挑已经装了本插件的 profile（多半就是你在用的那个），否则退回 desktop。
	for cand in "$DSH_HOME"/profiles/*/; do
		[ -f "$cand/package.json" ] || continue
		if grep -q '"dsh-delete-session"' "$cand/package.json" 2>/dev/null; then
			PROFILE_NAME=$(basename "$cand")
			break
		fi
	done
	[ -n "$PROFILE_NAME" ] || PROFILE_NAME=desktop
fi
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE_NAME"
if [ ! -f "$PROFILE_DIR/package.json" ]; then
	echo "   ⚠ 没有 ${PROFILE_DIR}/package.json —— 跳过（用 --profile=<名字> 指定，或手动安装）" >&2
	exit 0
fi
echo "   profile: ${PROFILE_NAME}（${PROFILE_DIR}）"
if [ "$DRY_RUN" = 1 ]; then
	echo "   [dry-run] 会在 package.json 里加："
	echo "             dependencies.dsh-delete-session = link:${DIR}"
	echo "             dsh.profile.bundles += dsh-delete-session"
	echo "           并建符号链接 node_modules/dsh-delete-session → ${DIR}"
	exit 0
fi

python3 - "$PROFILE_DIR" "$DIR" <<'PY'
import json
import os
import shutil
import sys
import time
from pathlib import Path

profile, plugin = Path(sys.argv[1]), Path(sys.argv[2])
pkg_path = profile / "package.json"
pkg = json.loads(pkg_path.read_text(encoding="utf-8"))

dep_value = f"link:{plugin}"
changed = []
if pkg.setdefault("dependencies", {}).get("dsh-delete-session") != dep_value:
    pkg["dependencies"]["dsh-delete-session"] = dep_value
    changed.append("dependencies")
bundles = pkg.setdefault("dsh", {}).setdefault("profile", {}).setdefault("bundles", [])
if "dsh-delete-session" not in bundles:
    bundles.append("dsh-delete-session")
    changed.append("dsh.profile.bundles")

if changed:
    backup = pkg_path.with_name(f"package.json.bak-{time.strftime('%Y%m%d-%H%M%S')}")
    shutil.copy2(pkg_path, backup)
    pkg_path.write_text(json.dumps(pkg, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"   已写入 package.json（{'、'.join(changed)}），备份在 {backup.name}")
else:
    print("   package.json 里已经有了，跳过")

link = profile / "node_modules" / "dsh-delete-session"
link.parent.mkdir(parents=True, exist_ok=True)
# npm 的 link: 装出来的是相对链接，这里按解析后的真实路径比较，免得把等价链接误判成不一致。
if link.is_symlink() and os.path.realpath(link) == os.path.realpath(plugin):
    print("   符号链接已就绪")
elif link.exists() and not link.is_symlink():
    print(f"   ⚠ {link} 已存在且不是符号链接，没动它 —— 请手动确认", file=sys.stderr)
else:
    if link.is_symlink():
        link.unlink()
    link.symlink_to(plugin)
    print(f"   已建符号链接 node_modules/dsh-delete-session → {plugin}")
PY

cat <<'TXT'

还差一件事：重启 DeepSeek Harness —— 宿主启动时才扫描插件清单（客户端半区同理）。
装好之后：设置 → 归档会话 是它的页面；已归档会话的 `...` 菜单里会多一行「删除会话」。

自检：npm run verify（类型检查 + 构建 + 292 条自测断言）。
TXT
