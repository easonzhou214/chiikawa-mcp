#!/usr/bin/env bash
set -euo pipefail

NAME="${CHIIKAWA_NAME:?缺少 CHIIKAWA_NAME}"
PERSONA="${CHIIKAWA_PERSONA:-}"

if [ -z "$PERSONA" ]; then
  if [ "${1:-}" = "detect" ]; then exit 0; fi
  printf '未指定人格模板，无事可做\n' >&2
  exit 1
fi
[ -f "$PERSONA" ] || { printf '找不到人格模板：%s\n' "$PERSONA" >&2; exit 1; }

SRC="$(cd "$(dirname "$PERSONA")" && pwd)/$(basename "$PERSONA")"
BASENAME="$(basename "$SRC")"
LEGACY_OPEN="<!-- >>> ${NAME} 资料库 · 人格锚（install.sh 写入，撤销请跑 --uninstall） >>>"
LEGACY_CLOSE="<!-- <<< ${NAME} 资料库 · 人格锚 <<<"
MARK_OPEN="$LEGACY_OPEN -->"
MARK_CLOSE="$LEGACY_CLOSE -->"

ROOT=""; AGENTS=""; LEGACY_COPY=""
setup_for() {
  ROOT="$(cd "$1" 2>/dev/null && pwd)" || { printf '目标项目不存在：%s\n' "$1" >&2; return 1; }
  AGENTS="$ROOT/AGENTS.md"
  LEGACY_COPY=""
  if [ -f "$AGENTS" ] && [ "$SRC" != "$ROOT/.${NAME}/${BASENAME}" ] &&
    managed_block | grep -qxF "<!-- persona: .${NAME}/${BASENAME} -->"; then
    LEGACY_COPY="$ROOT/.${NAME}/${BASENAME}"
  fi
}

managed_block() {
  awk -v opened="$MARK_OPEN" -v closed="$MARK_CLOSE" -v old_opened="$LEGACY_OPEN" -v old_closed="$LEGACY_CLOSE" '
    $0 == opened || $0 == old_opened { inside = 1 }
    inside { print }
    $0 == closed || $0 == old_closed { inside = 0 }
  ' "$AGENTS"
}

remove_legacy_copy() {
  if [ -n "$LEGACY_COPY" ]; then
    if [ -f "$LEGACY_COPY" ]; then
      rm -f "$LEGACY_COPY"
      printf '  已删除旧人格副本：%s\n' "$LEGACY_COPY"
    fi
    rmdir "$(dirname "$LEGACY_COPY")" 2>/dev/null || true
  fi
}

strip_block() {
  local target="$1" temporary
  temporary="$(mktemp)"
  awk -v opened="$MARK_OPEN" -v closed="$MARK_CLOSE" -v old_opened="$LEGACY_OPEN" -v old_closed="$LEGACY_CLOSE" '
    $0 == opened || $0 == old_opened { pending_blank = 0; skip = 1; next }
    skip { if ($0 == closed || $0 == old_closed) skip = 0; next }
    /^$/ { if (pending_blank) print ""; pending_blank = 1; next }
    {
      if (pending_blank) { print ""; pending_blank = 0 }
      print
    }
    END { if (pending_blank) print "" }
  ' "$target" > "$temporary"

  if [ -n "$(tr -d '[:space:]' < "$temporary")" ]; then
    cat "$temporary" > "$target"
    rm -f "$temporary"
  else
    rm -f "$temporary" "$target"
    printf '  剥离后文件为空，已连同该文件一并删除\n'
  fi
}

block() {
  printf '%s\n' "$MARK_OPEN"
  cat "$SRC"
  if [ -s "$SRC" ] && [ "$(tail -c1 "$SRC" | wc -l | tr -d ' ')" = "0" ]; then
    printf '\n'
  fi
  printf '%s\n' "$MARK_CLOSE"
}

# 注入的是「身份」，而目标项目自己的规则里常有一条跟说话方式有关的约定
# （表情、语气、语言、角色扮演）。两条指令并存时，谁在后面谁更强势，
# 结果是一个项目里同时存在互斥要求。这里只做「点名」不做判断：
# 命中不等于冲突，等于「这行该由人看一眼」。
#
# 注意别把「图片表情」也当成冲突：人格禁的是 emoji／颜文字这类字符拼出来的
# 表情，工程自己的表情图库是明确放行的。所以提示语要说准，否则会把人引去
# 删掉一条其实不冲突的规则。
CONFLICT_RE='(emoji|emote|颜文字|表情|persona|人格|扮演|口癖|语气|说话方式|default language|默认使用中文|默认中文)'

conflict_hits() {
  [ -f "$AGENTS" ] || return 0
  awk -v o="$MARK_OPEN" -v c="$MARK_CLOSE" -v oo="$LEGACY_OPEN" -v oc="$LEGACY_CLOSE" '
    $0 == o || $0 == oo { inside = 1; next }
    inside { if ($0 == c || $0 == oc) inside = 0; next }
    { print NR "\t" $0 }
  ' "$AGENTS" | grep -iE "$CONFLICT_RE" || true
}

report_conflicts() {
  local hits
  hits="$(conflict_hits)"
  [ -n "$hits" ] || return 0
  printf '\n    这段人格会追加到文件末尾，而该文件里已有这些规矩可能和它冲突，请自己确认：\n'
  printf '%s\n' "$hits" | while IFS="$(printf '\t')" read -r n text; do
    printf '      · 第 %s 行：%s\n' "$n" "$text"
  done
  printf '      （人格要求：不出现库外事物、不用 emoji 和颜文字这类字符表情；\n'
  printf '        图片表情不在此列——工程自己的表情玩法照旧，不必为了注入去删它。）\n'
}

case "${1:-}" in
  detect)
    target="${CHIIKAWA_TARGET_PROJECT:-}"
    if [ -n "$target" ] && [ -d "$target" ]; then
      ( cd "$target" && pwd )
      exit 0
    fi
    # 人格锚是项目级的，没有「用户级登记位」这种东西 —— 所以盘点时必须有人
    # 告诉它去哪儿找。CHIIKAWA_VERIFY_ROOTS 就是这个用途：对每个给定路径，
    # 报出它自己和它的一级子目录里带本资料库标记的那几个。
    # 不传就什么都不报（保持「安装时不指定 --into 就不参与」的原语义）。
    if [ -n "${CHIIKAWA_VERIFY_ROOTS:-}" ]; then
      old_ifs="$IFS"; IFS=:
      for root in $CHIIKAWA_VERIFY_ROOTS; do
        IFS="$old_ifs"
        [ -d "$root" ] || continue
        root="$(cd "$root" && pwd)"
        for proj in "$root" "$root"/*; do
          [ -d "$proj" ] || continue
          [ -f "$proj/AGENTS.md" ] || continue
          grep -qxF -e "$MARK_OPEN" -e "$LEGACY_OPEN" "$proj/AGENTS.md" || continue
          printf '%s\n' "$proj"
        done
      done
      IFS="$old_ifs"
    fi
    ;;

  status)
    setup_for "${2:?}" || exit 1
    if [ ! -f "$AGENTS" ]; then
      printf '缺失\t%s\n' "$AGENTS"
      exit 3
    fi
    if ! grep -qxF -e "$MARK_OPEN" -e "$LEGACY_OPEN" "$AGENTS"; then
      printf '无标记段\t%s\n' "$AGENTS"
      exit 3
    fi
    if cmp -s <(managed_block) <(block); then
      printf '一致\t%s\n' "$AGENTS"
      exit 0
    fi
    printf '过期\t%s\n' "$AGENTS"
    exit 1
    ;;

  installed)
    setup_for "${2:?}" || exit 1
    [ -f "$AGENTS" ] || exit 1
    cmp -s <(managed_block) <(block)
    ;;

  plan)
    setup_for "${2:?}" || exit 1
    printf '把人格正文直接注入目标项目：%s\n' "$ROOT"
    printf '    · 人格模板：%s\n' "$SRC"
    if [ -f "$AGENTS" ]; then
      if grep -qxF -e "$MARK_OPEN" -e "$LEGACY_OPEN" "$AGENTS"; then
        printf '    ~ AGENTS.md（替换本资料库的旧段）\n'
      else
        printf '    ~ AGENTS.md（追加正文，保留已有内容）\n'
      fi
    else
      printf '    + AGENTS.md（新建）\n'
    fi
    if [ -n "$LEGACY_COPY" ] && [ -f "$LEGACY_COPY" ]; then
      printf '    - %s（删除旧副本，并清理变空的目录）\n' "${LEGACY_COPY#$ROOT/}"
    fi
    report_conflicts
    block
    printf '\n%s\n' '（撤销时摘掉这一整段；若文件因此变空则一并删除。）'
    ;;

  apply)
    setup_for "${2:?}" || exit 1
    if [ -f "$AGENTS" ] && grep -qxF -e "$MARK_OPEN" -e "$LEGACY_OPEN" "$AGENTS"; then
      strip_block "$AGENTS"
    fi
    if [ -s "$AGENTS" ] && [ "$(tail -c1 "$AGENTS" | wc -l | tr -d ' ')" = "0" ]; then
      printf '\n' >> "$AGENTS"
    fi
    printf '\n' >> "$AGENTS"
    block >> "$AGENTS"
    remove_legacy_copy
    ;;

  remove)
    setup_for "${2:?}" || exit 1
    [ -f "$AGENTS" ] || exit 1
    grep -qxF -e "$MARK_OPEN" -e "$LEGACY_OPEN" "$AGENTS" || exit 1
    strip_block "$AGENTS"
    remove_legacy_copy
    ;;

  *)
    printf '用法：%s {detect|status|installed|plan|apply|remove} [项目根]\n' "$0" >&2
    printf '  status 的退出码：0=与模板一致，1=已注入但过期，3=没有本资料库的段\n' >&2
    exit 2
    ;;
esac
