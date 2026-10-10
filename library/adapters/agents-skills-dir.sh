#!/usr/bin/env bash
set -euo pipefail

#
# 宿主专用适配器 —— 按「技能目录约定」登记方法说明。
#
# ⚠️ 本文件属于 adapters/，允许出现具体宿主路径。
#
# 为什么是目录而不是配置项：
#   方法说明的**发现**靠目录位置，不靠配置文件登记。把技能目录放进约定的
#   父目录下，宿主扫描时自然就发现了；配置文件里那条同名条目是**禁用开关**
#   （默认启用），拿它当登记入口是无效的。
#
# 为什么是软链接而不是复制：
#   复制会留一份副本，源文件改了副本不会跟着变 —— 资料库最怕的不是慢，是答错。
#   软链接指向源目录，改完即生效；撤销时删链接，源目录一个字都不动。
#
# 子命令：detect | installed <登记位> | plan <登记位> | apply <登记位> | remove <登记位>
#

NAME="${CHIIKAWA_NAME:?缺少 CHIIKAWA_NAME}"
SKILL_MD="${CHIIKAWA_SKILL:-}"

if [ -z "$SKILL_MD" ]; then
  # 没指定方法说明（--no-skill）——不是错误，只是无事可做。
  # detect 静默返回「无位置」，让调用方直接跳过。
  [ "${1:-}" = "detect" ] || printf '未指定方法说明，无事可做\n' >&2
  exit 1
fi
[ -f "$SKILL_MD" ] || { printf '找不到方法说明：%s\n' "$SKILL_MD" >&2; exit 1; }

# 技能目录 = 存放 SKILL.md 的那一层。整目录挂过去，因为它是一个整体。
SRC_DIR="$(cd "$(dirname "$SKILL_MD")" && pwd)"

# 技能标识取自方法说明自己的 frontmatter，单一事实来源。
# 目录名不必跟它一致（宿主不要求），但保持一致最不容易出错。
skill_id() {
  local n
  n="$(sed -n 's/^name:[[:space:]]*//p' "$SKILL_MD" | head -1 | tr -d '\r' | sed "s/^[\"']//; s/[\"']$//")"
  if [ -n "$n" ]; then printf '%s' "$n"; else printf '%s' "$NAME"; fi
}

# 约定位置：用户级（对所有仓库生效）。可用 CHIIKAWA_SKILLS_ROOT 指到项目级。
DEST_ROOT="${CHIIKAWA_SKILLS_ROOT:-$HOME/.agents/skills}"
DEST="$DEST_ROOT/$(skill_id)"

case "${1:-}" in

  detect)
    # 已挂过（好撤销），或源在（好安装）—— 两者有一个就输出登记位。
    if [ -L "$DEST" ] || [ -f "$SKILL_MD" ]; then
      printf '%s\n' "$DEST"
    fi
    ;;

  status)
    # 退出码：0=一致，1=已登记但指向别处或悬空，3=没有本服务
    if [ ! -L "$DEST" ]; then
      printf '无登记\t%s\n' "$DEST"
      exit 3
    fi
    if [ "$(readlink "$DEST")" = "$SRC_DIR" ]; then
      printf '一致\t%s → %s\n' "$DEST" "$SRC_DIR"
      exit 0
    fi
    printf '指向别处\t%s → %s（应为 %s）\n' "$DEST" "$(readlink "$DEST")" "$SRC_DIR"
    exit 1
    ;;

  installed)
    # 「已登记」= 链接在**且指向当前这一份**。工程换了位置之后旧链接会悬空，
    # 那时这里返回非 0，让 apply 去把它修好，而不是当成「无需改动」放着不管。
    [ -L "$DEST" ] && [ "$(readlink "$DEST")" = "$SRC_DIR" ]
    ;;

  plan)
    printf '%s\n' "把方法说明挂到宿主会扫描的目录下（软链接，不复制）："
    printf '  → %s\n' "$SRC_DIR"
    printf '%s\n' ""
    if [ -L "$DEST" ]; then
      printf '%s\n' "（该位置已有软链接，指向 $(readlink "$DEST")）"
    elif [ -e "$DEST" ]; then
      printf '%s\n' "（该位置已被一个非软链接的东西占着，需要你先处理——本脚本不会覆盖它）"
    fi
    printf '%s\n' "（撤销时只删这条链接；源目录不动。）"
    ;;

  apply)
    if [ -L "$DEST" ]; then
      tgt="$(readlink "$DEST")"
      if [ "$tgt" = "$SRC_DIR" ]; then
        printf '  已存在同样的软链接，跳过\n'
        exit 0
      fi
      if [ ! -e "$DEST" ]; then
        # 悬空链接：目标不在了（多半是工程被挪过位置）。替换它不会伤到任何东西。
        printf '  替换悬空软链接（原指向 %s）\n' "$tgt"
        rm -f "$DEST"
      else
        printf '  该位置已有软链接且指向别处：%s\n  先跑 --uninstall，或手动处理后再装。\n' "$tgt" >&2
        exit 1
      fi
    elif [ -e "$DEST" ]; then
      printf '  该位置已存在且不是软链接：%s\n  本脚本不会覆盖它，请先手动处理。\n' "$DEST" >&2
      exit 1
    fi

    mkdir -p "$DEST_ROOT"
    ln -s "$SRC_DIR" "$DEST"
    printf '  已挂载：%s → %s\n' "$DEST" "$SRC_DIR"
    ;;

  remove)
    # 只删得掉软链接。真实目录、真实文件一律不碰。
    if [ ! -L "$DEST" ]; then
      printf '  该位置不是本服务创建的软链接，不动它\n' >&2
      exit 1
    fi
    rm -f "$DEST"
    printf '  已卸载：%s\n' "$DEST"

    # 收掉因此变空的目录。rmdir 对非空目录必然失败，所以「有别人的东西」
    # 这一条天然安全；同时绝不出 $HOME，免得把项目目录也收进去。
    d="$DEST_ROOT"
    while [ -n "$d" ] && [ "$d" != "$HOME" ] && [ "$d" != "/" ]; do
      case "$d" in "$HOME"/*) ;; *) break ;; esac
      rmdir "$d" 2>/dev/null || break
      printf '  空目录已收：%s\n' "$d"
      d="$(dirname "$d")"
    done
    ;;

  *)
    printf '用法：%s {detect|installed|plan|apply|remove} [登记位]\n' "$0" >&2
    exit 2
    ;;

esac
