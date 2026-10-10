#!/usr/bin/env bash
set -euo pipefail

#
# 宿主专用适配器 —— 处理用 TOML 表 [mcp_servers.<名字>] 登记服务的宿主配置。
#
# ⚠️ 本文件属于 adapters/，是资料库包中允许出现具体宿主路径的地方。
#    中立核心（README.md / persona/ / skill/ / mcp/ / install.sh）不得引用本文件的内容。
#
# 子命令：detect | installed <配置> | plan <配置> | apply <配置> | remove <配置>
#
# 「installed」的判定是**值也对**，不只是「标记在」。否则工程换了路径之后，
# 配置里那行死路径会被当成「无需改动」，重跑安装也修不回来。
#

NAME="${CHIIKAWA_NAME:?缺少 CHIIKAWA_NAME}"
NODE_BIN="${CHIIKAWA_NODE:?缺少 CHIIKAWA_NODE}"
SERVER="${CHIIKAWA_SERVER:?缺少 CHIIKAWA_SERVER}"

MARK_OPEN="# >>> ${NAME} 资料库（install.sh 写入，撤销请跑 --uninstall） >>>"
MARK_CLOSE="# <<< ${NAME} 资料库 <<<"

# ── 已探明的宿主配置位置 ────────────────────────────────────
# 增补宿主只需在这里追加一行，其余逻辑不用改。
CANDIDATES=(
  "$HOME/.codex/config.toml"
)

toml_escape() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }

CMD_LINE="command = \"$(toml_escape "$NODE_BIN")\""
ARG_LINE="args = [\"$(toml_escape "$SERVER")\"]"
# 以前这里会写一行 type = "stdio"。实测宿主（codex 0.159）把它当成无法识别的
# 配置项并每次启动都告警：`mcp_servers.chiikawa.type` is ignored —— 收益是零、
# 噪音 +1，所以不再写。stdio 是这类登记的唯一形态，不写也不会被误读。
# 注意：老的登记里可能还留着这一行，installed/status 不检查它，重跑一次安装
# 就会整段重写成不带它的形式。
TABLE_HEADER="[mcp_servers.${NAME}]"

# 带标记的那一份是首选写法；但**不带标记的登记也算本服务的**。
# 少了这层识别，一段没有标记的登记会被判成「没有本服务」：撤不掉、也
# 不会提示内容过期。这类登记是早期版本或手工粘贴留下的，实测真实机器上就有。
has_marker()  { [ -f "$1" ] && grep -qxF "$MARK_OPEN" "$1"; }
has_table()   { [ -f "$1" ] && grep -qxF "$TABLE_HEADER" "$1"; }
has_registration() { has_marker "$1" || has_table "$1"; }

# 值也对，才算「内容一致」—— 否则工程换了位置，旧路径会被当成无需改动
values_current() {
  [ -f "$1" ] || return 1
  grep -qF "$CMD_LINE" "$1" && grep -qF "$ARG_LINE" "$1"
}

block() {
  printf '\n%s\n' "$MARK_OPEN"
  printf '%s\n' "$TABLE_HEADER"
  printf '%s\n' "$CMD_LINE"
  printf '%s\n' "$ARG_LINE"
  printf '%s\n' "$MARK_CLOSE"
}

# 摘掉无标记的表段：从表头删到下一个表头之前。TOML 里子表也以 [ 开头，
# 所以这个边界是安全的；本服务不写子表。
strip_table() {
  local cfg="$1" tmp
  tmp="$(mktemp)"
  awk -v hdr="$TABLE_HEADER" '
    $0 == hdr { dropping = 1; pending_blank = 0; next }
    dropping && /^\[/ { dropping = 0 }
    dropping { next }
    /^$/ { if (pending_blank) print ""; pending_blank = 1; next }
    { if (pending_blank) { print ""; pending_blank = 0 } print }
    END { if (pending_blank) print "" }
  ' "$cfg" > "$tmp"

  if [ -n "$(tr -d '[:space:]' < "$tmp")" ]; then
    cat "$tmp" > "$cfg"
    rm -f "$tmp"
  else
    rm -f "$tmp" "$cfg"
    printf '  剥离后文件为空，已连同该文件一并删除\n'
  fi
}

# 摘掉标记段。只认标记，不认别的。摘完什么都不剩就连文件一并删除
# —— 那说明这文件当初就是本适配器建的。
strip_block() {
  local cfg="$1" tmp
  tmp="$(mktemp)"
  awk -v o="$MARK_OPEN" -v c="$MARK_CLOSE" '
    $0 == o {
      # 丢弃紧贴标记之前的空行 —— 那是写入时自己加的
      pending_blank = 0
      skip = 1
      next
    }
    skip {
      if ($0 == c) skip = 0
      next
    }
    /^$/ {
      # 空行延迟一行输出，好让上面那条规则能把它收回去
      if (pending_blank) print ""
      pending_blank = 1
      next
    }
    {
      if (pending_blank) { print ""; pending_blank = 0 }
      print
    }
    END { if (pending_blank) print "" }
  ' "$cfg" > "$tmp"

  if [ -n "$(tr -d '[:space:]' < "$tmp")" ]; then
    cat "$tmp" > "$cfg"
    rm -f "$tmp"
  else
    rm -f "$tmp" "$cfg"
    printf '  剥离后文件为空，已连同该文件一并删除\n'
  fi
}

backup_if_asked() {
  if [ "${CHIIKAWA_BACKUP:-0}" = "1" ]; then
    cp -p "$1" "${1}.bak-$(date +%Y%m%d-%H%M%S)"
    printf '  已留副本（--backup 指定）\n'
  fi
}

case "${1:-}" in

  detect)
    for c in "${CANDIDATES[@]}"; do
      # 配置文件和父目录都可以由 apply 创建；全新机器上也必须返回路径。
      printf '%s\n' "$c"
    done
    ;;

  installed)
    cfg="${2:?}"
    # 带标记的段与无标记的表段都算「已登记」；值也得是当前这一份
    has_registration "$cfg" || exit 1
    values_current "$cfg" || exit 1
    ;;

  status)
    # 退出码：0=一致，1=有登记但内容过期，3=没有本服务
    cfg="${2:?}"
    if ! has_registration "$cfg"; then
      printf '无登记\t%s\n' "$cfg"
      exit 3
    fi
    if values_current "$cfg"; then
      if has_marker "$cfg"; then
        printf '一致\t%s\n' "$cfg"
      else
        printf '一致（但这一段没有标记，撤销时按表段整段摘）\t%s\n' "$cfg"
      fi
      exit 0
    fi
    printf '过期\t%s（登记里的路径与当前不一致）\n' "$cfg"
    exit 1
    ;;

  plan)
    cfg="${2:?}"
    if has_registration "$cfg"; then
      if values_current "$cfg"; then
        printf '%s\n' "已登记且内容一致，无需改动。"
        exit 0
      fi
      printf '%s\n' "已有本服务的段记录着别的路径，将整段替换为："
    elif [ -f "$cfg" ]; then
      printf '%s\n' "追加到文件末尾，不触碰任何已有内容："
    else
      printf '%s\n' "该文件还不存在，将新建（内容如下）："
    fi
    block
    printf '%s\n' ""
    printf '%s\n' "（只登记服务本身。方法说明由另一个适配器按目录约定登记——那才是它被发现的方式。）"
    ;;

  apply)
    cfg="${2:?}"

    if [ -f "$cfg" ]; then
      backup_if_asked "$cfg"

      # 已有本服务的登记（多半是工程换了位置留下的旧路径）—— 摘掉再写，
      # 否则会出现两份，而先出现的那份仍然指向旧路径。
      # 无标记的那种按表段摘，摘完补写上带标记的新段。
      if has_marker "$cfg"; then
        printf '  已有本服务的段，先摘掉旧的重写\n'
        strip_block "$cfg"
      elif has_table "$cfg"; then
        printf '  已有本服务的表段（没有标记，按表段摘除后重写）\n'
        strip_table "$cfg"
      fi
      if [ ! -f "$cfg" ]; then
        printf '  该文件本来只装着本服务，已重建：%s\n' "$cfg"
        mkdir -p "$(dirname "$cfg")"
        : > "$cfg"
      fi

      if [ -s "$cfg" ] && [ "$(tail -c1 "$cfg" | wc -l | tr -d ' ')" = "0" ]; then
        printf '\n' >> "$cfg"
      fi
    else
      printf '  该文件还不存在，新建：%s\n' "$cfg"
      mkdir -p "$(dirname "$cfg")"
      : > "$cfg"
    fi

    block >> "$cfg"
    ;;

  remove)
    cfg="${2:?}"
    [ -f "$cfg" ] || exit 1
    # 没留下过东西就没得撤 —— 用退出码表达，别谎报成功
    has_registration "$cfg" || exit 1

    backup_if_asked "$cfg"
    if has_marker "$cfg"; then
      strip_block "$cfg"
    else
      # 无标记的登记：按表段整段摘。这就是「登记还在、只是没标记」那条分支，
      # 只删 [mcp_servers.<名字>] 这一段，别的表和子表都不碰。
      printf '  该登记没有标记，按表段摘除\n'
      strip_table "$cfg"
    fi
    ;;

  *)
    printf '用法：%s {detect|status|installed|plan|apply|remove} [配置路径]\n' "$0" >&2
    printf '  status 的退出码：0=与当前一致，1=已登记但过期，3=没有本服务\n' >&2
    exit 2
    ;;

esac
