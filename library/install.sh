#!/usr/bin/env bash
set -euo pipefail

#
# 吉伊卡哇资料库 · 安装器（中立入口）
#
# 职责：检测运行时 → 校验数据 → 自检服务 → 调度适配器
# 本文件不出现任何具体宿主产品名。宿主专用的路径与格式一律在 adapters/ 下。
#
# 用法：
#   ./install.sh                    只打印计划，不写任何文件
#   ./install.sh --yes              按计划写入
#   ./install.sh --uninstall --yes  撤销写入
#   ./install.sh --print            只输出注册信息，供手工粘贴到任意宿主
#

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SELF_DIR/.." && pwd)"
DATA_DIR="$PROJECT_ROOT/js"
SERVER="$SELF_DIR/mcp/server.js"
SKILL_FILE="$SELF_DIR/skill/SKILL.md"
TRIGGER_FILE="$SELF_DIR/skill/resident-trigger.md"
PERSONA_FILE="$SELF_DIR/persona/usagi-persona.md"
ADAPTER_DIR="$SELF_DIR/adapters"
SERVER_NAME="chiikawa"

APPLY=0
PRINT_ONLY=0
PRINT_TRIGGER=0
UNINSTALL=0
BACKUP=0
WITH_SKILL=1
ONLY_HOST=""
TARGET_PROJECT=""
PERSONA_TOUCHED=0
VERIFY=0
VERIFY_ROOTS=()

# 人格锚由哪个适配器承担。收尾要据此判断「已注入」这句话能不能说
# —— 说错了就是假报告，比不打印更糟。
PERSONA_ADAPTER="agents-md-file"

if [ -t 1 ]; then
  C_OK=$'\033[32m'; C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_DIM=$'\033[2m'; C_RST=$'\033[0m'
else
  C_OK=""; C_WARN=""; C_ERR=""; C_DIM=""; C_RST=""
fi

step() { printf '\n%s\n' "$*"; }
ok()   { printf '  %s✔%s %s\n' "$C_OK" "$C_RST" "$*"; }
warn() { printf '  %s!%s %s\n' "$C_WARN" "$C_RST" "$*"; }
info() { printf '  %s%s%s\n' "$C_DIM" "$*" "$C_RST"; }
die()  { printf '\n  %s✘ %s%s\n\n' "$C_ERR" "$*" "$C_RST" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --yes|-y)   APPLY=1 ;;
    --uninstall) UNINSTALL=1 ;;
    --print)    PRINT_ONLY=1 ;;
    --print-trigger) PRINT_TRIGGER=1 ;;
    --no-skill) WITH_SKILL=0 ;;
    --backup)   BACKUP=1 ;;
    --host)     shift; ONLY_HOST="${1:-}" ;;
    --into)     shift; TARGET_PROJECT="${1:-}" ;;
    --verify)
      VERIFY=1
      # 值是可选的：给了目录就检查它，没给就只标了 VERIFY，到执行处再报清楚
      if [ $# -gt 1 ] && [ -d "${2:-}" ]; then
        VERIFY_ROOTS+=("$2"); shift
      fi
      ;;
    -h|--help)
      # 适配器名从目录里现取，不写死 —— 加了新适配器忘了改帮助文本是常态。
      ad_list=""
      for a in "$ADAPTER_DIR"/*.sh; do
        [ -f "$a" ] || continue
        ad_list="${ad_list}${ad_list:+、}$(basename "$a" .sh)"
      done
      cat <<EOS

吉伊卡哇资料库 · 安装器

  bash install.sh                    只打印计划，不写任何文件
  bash install.sh --yes              按计划写入
  bash install.sh --uninstall        撤销（配 --yes 才真执行）
  bash install.sh --print            只输出注册信息，供手工粘贴到任意宿主
  bash install.sh --print-trigger    只输出常驻触发规则，供粘贴到常驻说明位
  bash install.sh --no-skill         只登记数据服务，不登记方法说明
  bash install.sh --backup           写入前留一份配置副本（默认不留）
  bash install.sh --host <名字>      只跑指定的适配器，可选：$ad_list
  bash install.sh --into <项目路径>   把人格锚注入到这个项目里（不指定就不注入）
  bash install.sh --verify <路径>     检查这些位置下已注入的人格是否过期（可重复，只读）

环境变量：

  CHIIKAWA_NODE              指定运行时绝对路径（nvm / volta 用户常用）
  CHIIKAWA_NODE_CANDIDATES   PATH 里找不到时去扫哪些位置，冒号分隔
  CHIIKAWA_SKILLS_ROOT       方法说明挂到哪。默认用户级，对所有仓库生效

EOS
      exit 0 ;;
    *) die "不认识的参数：$1" ;;
  esac
  shift
done

# 目标项目要在这里校验：适配器的 detect 是静默的，路径写错了会「什么都不发生」，
# 那种失败最难诊断。
if [ -n "$TARGET_PROJECT" ]; then
  [ -d "$TARGET_PROJECT" ] || die "--into 指的不是一个目录：$TARGET_PROJECT"
  TARGET_PROJECT="$(cd "$TARGET_PROJECT" && pwd)"
fi

# --host 同理：传错名字会让适配器循环整个空转，表现是「退出码 0 但什么都没做」。
# 只接受纯名字（不含路径分隔符），免得写成 ../ 绕过到适配器目录之外。
if [ -n "$ONLY_HOST" ]; then
  if [ "$(basename "$ONLY_HOST")" != "$ONLY_HOST" ] || [ ! -f "$ADAPTER_DIR/$ONLY_HOST.sh" ]; then
    avail=""
    for a in "$ADAPTER_DIR"/*.sh; do
      [ -f "$a" ] || continue
      avail="${avail}${avail:+、}$(basename "$a" .sh)"
    done
    die "不认识的适配器：$ONLY_HOST
  可用的有：$avail"
  fi
fi

resolve_path() {
  local p="$1"
  if readlink -f "$p" >/dev/null 2>&1; then
    readlink -f "$p"
  else
    ( cd "$(dirname "$p")" && printf '%s/%s' "$(pwd)" "$(basename "$p")" )
  fi
}

printf '\n%s\n' "吉伊卡哇资料库 · 安装"
printf '%s\n' "──────────────────────────────────────────"

# 适配器靠环境变量拿参数，--verify 那条路径上不经过后面的运行时检测，
# 所以契约要求的几项要在这里先给全 —— 少一项，相关适配器的 detect 会直接退出，
# 表现是「盘点里少了这一类登记」，而那看起来和「没装过」一模一样。
export CHIIKAWA_NAME="$SERVER_NAME"
export CHIIKAWA_PERSONA="$PERSONA_FILE"
export CHIIKAWA_TARGET_PROJECT="$TARGET_PROJECT"
export CHIIKAWA_SERVER="$SERVER"
export CHIIKAWA_NODE="$(resolve_path "${CHIIKAWA_NODE:-$(command -v node 2>/dev/null || true)}")"
if [ "$WITH_SKILL" -eq 1 ]; then
  export CHIIKAWA_SKILL="$SKILL_FILE"
else
  export CHIIKAWA_SKILL=""
fi

# ── --verify：只读盘点，检查已注入项目的人格是否还跟着模板 ──────────────
# 「人格过期最难发现」是这套设计的固有代价：注入是把正文复制进目标项目，
# 复制品不会自己跟上模板。这个方法把它变成一条命令，不用记得每个项目在哪。
# 放在这里是因为它要用上面定义的 step/ok/warn/info/die，且必须在任何写入之前。
if [ "$VERIFY" -eq 1 ]; then
  step "已注入内容盘点（只读，不写任何文件）"
  [ "${#VERIFY_ROOTS[@]}" -gt 0 ] || die "请给出要检查的路径：bash install.sh --verify <路径>（可重复）"

  shopt -s nullglob
  V_ADAPTERS=("$ADAPTER_DIR"/*.sh)
  shopt -u nullglob
  [ "${#V_ADAPTERS[@]}" -gt 0 ] || die "没有可用的适配器"

  # 人格锚是项目级的，适配器没法凭空知道要检查哪些项目 —— 把给定的路径
  # 传下去，让它自己在那下面找带本资料库标记的项目。
  V_ROOTS_JOINED=""
  for vr in "${VERIFY_ROOTS[@]}"; do
    [ -n "$vr" ] || die "--verify 后面要给一个目录"
    [ -d "$vr" ] || die "--verify 指的不是一个目录：$vr"
    V_ROOTS_JOINED="${V_ROOTS_JOINED}${V_ROOTS_JOINED:+:}$(cd "$vr" && pwd)"
  done
  export CHIIKAWA_VERIFY_ROOTS="$V_ROOTS_JOINED"

  CHECKED=0; STALE=0; OKN=0; UNSURE=0
  for vad in "${V_ADAPTERS[@]}"; do
    vad_name="$(basename "$vad" .sh)"
    [ -n "$ONLY_HOST" ] && [ "$ONLY_HOST" != "$vad_name" ] && continue

    # 位置由适配器自己报，这里不猜 —— 加一个新宿主只需它有 detect
    V_CONFIGS="$("$vad" detect 2>/dev/null || true)"
    [ -n "$V_CONFIGS" ] || continue

    while IFS= read -r vcfg; do
      [ -n "$vcfg" ] || continue
      vstatus="$("$vad" status "$vcfg" 2>/dev/null)" && vrc=0 || vrc=$?
      case "$vrc" in
        0)  ok    "[$vad_name] 一致：$vcfg"; OKN=$((OKN+1)); CHECKED=$((CHECKED+1)) ;;
        1)  warn  "[$vad_name] 过期：$vcfg"
                  STALE=$((STALE+1)); CHECKED=$((CHECKED+1)) ;;
        3)  : ;;  # 该位置没有本资料库的登记，不算问题，也不刷屏
        2)  : ;;  # 这个适配器没实现 status，不是错误
        *)  warn  "[$vad_name] 无法判定（退出码 $vrc）：$vcfg"; UNSURE=$((UNSURE+1)) ;;
      esac
    done <<< "$V_CONFIGS"
  done

  printf '\n'
  if [ "$CHECKED" -eq 0 ]; then
    info "没有找到本资料库已登记的位置"
  elif [ "$STALE" -eq 0 ]; then
    ok "检查了 $CHECKED 个登记位，全部与当前内容一致"
  else
    warn "检查了 $CHECKED 个登记位：$OKN 个一致、$STALE 个已过期"
    info "过期的那几个不会自己跟上——源文件改了要重跑一次安装"
    info "更新某一项：bash install.sh --into <项目路径> --yes"
  fi
  [ "$UNSURE" -eq 0 ] || info "另有 $UNSURE 个无法判定，看上面的原因"
  printf '\n'
  exit 0
fi

# ── 1. 运行时 ─────────────────────────────────────────────
step "1. 运行时"

NODE_BIN=""
if [ -n "${CHIIKAWA_NODE:-}" ]; then
  # 显式指定优先：nvm / volta / asdf 这类版本管理器常用得到
  if [ -x "$CHIIKAWA_NODE" ]; then
    NODE_BIN="$CHIIKAWA_NODE"
  else
    die "CHIIKAWA_NODE 指向的不是可执行文件：$CHIIKAWA_NODE"
  fi
elif command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
else
  # 图形界面启动的宿主拿不到 shell PATH，所以路径里找不到时再扫这几个常见位置
  for c in ${CHIIKAWA_NODE_CANDIDATES:-/opt/homebrew/bin/node:/usr/local/bin/node:/usr/bin/node}; do
    if [ -x "$c" ]; then NODE_BIN="$c"; break; fi
  done
fi

if [ -z "$NODE_BIN" ]; then
  warn "没找到 node"
  cat <<'EOS'

  这个资料库的服务需要一个 JavaScript 运行时。装好之后重新运行本脚本：

    macOS       brew install node
    其它系统      https://nodejs.org 下载 LTS 版本

  已经装了但仍然报这个错，说明它在非常规位置。直接指给本脚本：

    CHIIKAWA_NODE=/你的/node/绝对路径 bash install.sh

  没有它，宿主只会报一句难以诊断的 “command not found”。

EOS
  exit 1
fi

NODE_REAL="$(resolve_path "$NODE_BIN")"
ok "运行时：$NODE_REAL"
info "版本：$("$NODE_REAL" --version 2>/dev/null || echo '未知')"
info "用绝对路径写进配置 —— 图形界面启动的宿主通常拿不到你的 shell PATH"

# ── 2. 数据 ───────────────────────────────────────────────
step "2. 数据"

[ -d "$DATA_DIR" ] || die "找不到数据目录 $DATA_DIR
     本包必须和项目的 js/ 一起被复制。只复制 library/ 是不够的。"
[ -f "$SERVER" ] || die "找不到服务文件 $SERVER"

DATA_FILES="$(find "$DATA_DIR" -maxdepth 1 -name '*.js' \
  \( -name 'episodes-*' -o -name 'data-*' \) | wc -l | tr -d ' ')"
[ "$DATA_FILES" -gt 0 ] || die "$DATA_DIR 里没有数据文件"

ok "数据目录：${DATA_DIR}（${DATA_FILES} 个文件）"
info "路径按自身位置推导，整个项目挪到哪都成立"

# ── 3. 自检 ───────────────────────────────────────────────
step "3. 自检"

SELFTEST="$("$NODE_REAL" "$SERVER" --selftest 2>&1)" || die "服务无法启动：
$SELFTEST"

read_counts() {
  printf '%s' "$SELFTEST" | "$NODE_REAL" -e '
    let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
      try{const j=JSON.parse(d);const c=j.counts||{};
        console.log([c.episode,c.short,c.character,c.arc,c.line,j.data_version||""].join(" "));
      }catch(e){console.log("");}
    });'
}
COUNTS="$(read_counts)"
if [ -z "$COUNTS" ]; then die "自检输出无法解析，服务可能未正常装载数据"; fi
set -- $COUNTS
ok "数据装载正常：$1 集 / $2 短篇 / $3 角色 / $4 篇章 / $5 条台词"
info "版本指纹：$6"

HS="$(printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"installer","version":"1"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | "$NODE_REAL" "$SERVER" 2>/dev/null || true)"

# 自检的是「契约还在不在」，不是「刚好五个」。
# 早先写死 = 5：服务端一加工具，全机安装就会失败并报「期望 5 个」——
# 加能力反而装不上，这是自检在阻止自己该做的事。所以这里只要求
# 五个契约工具一个不少，多余的算正常演进。
EXPECTED_TOOLS="list_entries get_entry search_entries get_related describe_schema"
TOOL_NAMES="$(printf '%s' "$HS" | "$NODE_REAL" -e '
  let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{
    let names=[];
    d.trim().split("\n").forEach(l=>{try{const m=JSON.parse(l);
      if(m.id===2&&m.result&&m.result.tools)names=m.result.tools.map(t=>t.name);}catch(e){}});
    console.log(names.join(" "));
  });')"

MISSING=""
for want in $EXPECTED_TOOLS; do
  case " $TOOL_NAMES " in
    *" $want "*) ;;
    *) MISSING="${MISSING}${MISSING:+、}$want" ;;
  esac
done
if [ -n "$MISSING" ]; then
  die "协议自检失败：缺少契约里的工具 $MISSING
  服务返回的工具是：${TOOL_NAMES:-（一个都没有）}"
fi
TOOL_COUNT="$(printf '%s' "$TOOL_NAMES" | wc -w | tr -d ' ')"
ok "协议自检通过：initialize 握手 + $TOOL_COUNT 个工具可枚举（契约要求的 5 个都在）"

# ── 4. 注册信息 ───────────────────────────────────────────
if [ "$PRINT_ONLY" -eq 1 ]; then
  step "注册信息（粘贴到任意宿主）"
  cat <<EOS

  服务名    $SERVER_NAME
  启动命令  $NODE_REAL
  启动参数  $SERVER

  多数宿主用这两个字段就够；字段叫什么名字、写进哪个文件，以你宿主的文档为准。

  方法说明不用登记到配置里 —— 它的发现靠目录位置。把下面这个目录
  挂进（或复制进）宿主的技能扫描目录即可，目录里应有 SKILL.md：

      $(dirname "$SKILL_FILE")

EOS
  cat <<EOS

  想只让某一个项目用到它：

      把上面的注册信息写进该项目的**项目级**配置，
      再把这个目录挂进该项目的技能扫描目录。

      CHIIKAWA_SKILLS_ROOT=<该项目的技能目录> bash install.sh --yes

EOS
  exit 0
fi

if [ "$PRINT_TRIGGER" -eq 1 ]; then
  step "常驻触发规则（粘贴到对话开始前就会被读到的位置）"
  awk '/^```markdown$/{f=1;next} f&&/^```$/{exit} f' "$TRIGGER_FILE"
  printf '\n  出处：%s\n\n' "$TRIGGER_FILE"
  exit 0
fi

if [ "$UNINSTALL" -eq 0 ]; then
  if [ "$WITH_SKILL" -eq 1 ] && [ -f "$SKILL_FILE" ]; then
    step "4. 方法说明"
    ok "将挂到宿主会扫描的技能目录：$SKILL_FILE"
    info "挂的是软链接不是副本 —— 正文改了立即生效，不会留一份过期说明"
    info "它头部那段描述进常驻上下文，作用就是「什么时候该查这份资料」"
  elif [ "$WITH_SKILL" -eq 0 ]; then
    step "4. 方法说明"
    warn "--no-skill：只登记数据服务"
    info "调用方仍能查询，但不知道字段语义，容易用错"
  fi
fi

if [ "$UNINSTALL" -eq 0 ] && [ -n "$TARGET_PROJECT" ]; then
  step "5. 人格锚"
  ok "将注入到：$TARGET_PROJECT"
  info "把人格模板的正文直接写进项目说明文件，不另建人格文件或目录"
  info "人格是唯一不会被自动发现的一层，只能这样显式放进去"
fi

# ── 6. 适配器 ─────────────────────────────────────────────
step "6. 宿主登记"

[ -d "$ADAPTER_DIR" ] || die "找不到适配器目录 $ADAPTER_DIR"

shopt -s nullglob
ADAPTERS=("$ADAPTER_DIR"/*.sh)
shopt -u nullglob

if [ "${#ADAPTERS[@]}" -eq 0 ]; then
  warn "没有可用的适配器"
  info "用 --print 拿到注册信息，手工配置即可"
  exit 0
fi

export CHIIKAWA_NODE="$NODE_REAL"
export CHIIKAWA_SERVER="$SERVER"
export CHIIKAWA_NAME="$SERVER_NAME"
export CHIIKAWA_BACKUP="$BACKUP"
export CHIIKAWA_PERSONA="$PERSONA_FILE"
export CHIIKAWA_TARGET_PROJECT="$TARGET_PROJECT"
if [ "$WITH_SKILL" -eq 1 ]; then
  export CHIIKAWA_SKILL="$SKILL_FILE"
else
  export CHIIKAWA_SKILL=""
fi

# 默认挂到用户级技能目录（对所有仓库生效，不需要往每个项目里塞东西）。
# 想让某个项目独占，把它指到那个项目的技能目录即可。
if [ -n "${CHIIKAWA_SKILLS_ROOT:-}" ]; then
  export CHIIKAWA_SKILLS_ROOT
fi

ACTION="写入"; [ "$UNINSTALL" -eq 1 ] && ACTION="撤销"
TOUCHED=0
# 撤销时记下人格锚撤过的那一项，见收尾的提醒
PERSONA_REMOVED=""

for ad in "${ADAPTERS[@]}"; do
  ad_name="$(basename "$ad" .sh)"
  if [ -n "$ONLY_HOST" ] && [ "$ONLY_HOST" != "$ad_name" ]; then continue; fi

  printf '\n  %s\n' "适配器：$ad_name"

  CONFIGS="$("$ad" detect 2>/dev/null || true)"
  if [ -z "$CONFIGS" ]; then
    info "没有可写入的位置，跳过"
    continue
  fi

  while IFS= read -r cfg; do
    [ -n "$cfg" ] || continue

    if [ "$UNINSTALL" -eq 1 ]; then
      if [ "$APPLY" -eq 1 ]; then
        # 以 remove 的退出码为准：它能认出「登记还在、只是内容过期了」这种情况，
        # 而 installed 对过期登记会返回非 0，拿它把关就撤不干净。
        if "$ad" remove "$cfg" >/dev/null 2>&1; then
          ok "已撤销：$cfg"
          TOUCHED=1
          [ "$ad_name" = "$PERSONA_ADAPTER" ] && PERSONA_REMOVED="$cfg"
        else
          info "$cfg 里没有本服务，跳过"
        fi
      else
        if "$ad" installed "$cfg" >/dev/null 2>&1; then
          printf '    %s将要撤销：%s%s\n' "$C_DIM" "$cfg" "$C_RST"
          TOUCHED=1
        else
          info "$cfg 里没有本服务或登记已过期，跳过"
        fi
      fi
      continue
    fi

    if "$ad" installed "$cfg" >/dev/null 2>&1; then
      ok "$cfg 里已登记，无需改动"
      TOUCHED=1
      if [ "$ad_name" = "$PERSONA_ADAPTER" ]; then PERSONA_TOUCHED=1; fi
      continue
    fi

    printf '\n    %s\n' "$cfg"
    "$ad" plan "$cfg" | sed 's/^/    /'

    if [ "$APPLY" -eq 1 ]; then
      # 以退出码为准：写失败要当场炸掉，绝不能接着报「已写入」。
      "$ad" apply "$cfg" || die "适配器 $ad_name 写入失败：$cfg"
      ok "已写入：$cfg"
      if [ "$ad_name" = "$PERSONA_ADAPTER" ]; then PERSONA_TOUCHED=1; fi
    else
      printf '    %s（只是预览，未写入）%s\n' "$C_DIM" "$C_RST"
    fi
    TOUCHED=1
  done <<< "$CONFIGS"
done

# ── 7. 收尾 ───────────────────────────────────────────────
step "7. 收尾"

if [ "$TOUCHED" -eq 0 ]; then
  warn "没有找到任何可写入的宿主配置"
  info "用 --print 拿到注册信息，手工配置即可"
fi

if [ "$APPLY" -eq 0 ] && [ "$TOUCHED" -eq 1 ]; then
  printf '  加 %s--yes%s 才会真的%s。\n' "$C_OK" "$C_RST" "$ACTION"
fi

# 撤销完要说清「还有什么没撤」。人格锚是项目级的，不带 --into 就找不到任何目标，
# 于是它静默留着 —— 用户会以为撤干净了。实测踩过：用户级两处都撤了，
# 两个项目里的人格原样还在，而输出里一个字都没提。
if [ "$APPLY" -eq 1 ] && [ "$UNINSTALL" -eq 1 ]; then
  if [ -n "$PERSONA_REMOVED" ]; then
    printf '\n  人格锚是从项目里摘掉的，撤销时记得对每个注入过的项目各跑一次：\n'
    printf '      bash install.sh --into <项目路径> --uninstall --yes\n'
  else
    cat <<'EOS'

  注意：**项目里的 agent 不在这次撤销范围内**。人格锚是项目级的，
  不带 --into 就找不到目标，所以它仍然留在那些项目的说明文件里。
  要摘掉某个项目的：

      bash install.sh --into <项目路径> --uninstall --yes

  想先看看哪些项目还留着：bash install.sh --verify <项目所在目录>

EOS
  fi
fi

if [ "$APPLY" -eq 1 ] && [ "$UNINSTALL" -eq 0 ]; then
  cat <<EOS

  装完了。能力那两层是自动生效的：

    · 工具本身 —— 建立连接后就在上下文里，宿主自己知道有这些工具
    · 何时该用 —— 方法说明头部的描述会进常驻列表，宿主按它匹配

  也就是说，**能力**不需要你往项目里塞提示词。

EOS

  if [ -n "$TARGET_PROJECT" ] && [ "$PERSONA_TOUCHED" -eq 1 ]; then
    printf '  人格锚已注入：%s\n' "$TARGET_PROJECT"
    printf '  那个项目现在自包含 —— 挪位置、复制给别人，人格都跟着走。\n'
  elif [ -n "$TARGET_PROJECT" ]; then
    # 指定了项目却没走到注入那一步：最常见是 --host 把承担人格的适配器筛掉了。
    # 这里必须如实说，报「已注入」而其实没注入，比不报更糟。
    warn "人格锚没有注入：$TARGET_PROJECT"
    info "承担人格的是 $PERSONA_ADAPTER 适配器，本次没有跑到它"
    info "单独注入：bash install.sh --into <项目路径> --yes"
  else
    cat <<'EOS'
  但**人格那层不会自动生效** —— 它没有可被自动发现的落点，只能显式放进去。
  想给某个项目加上人格，对它跑一次：

      bash install.sh --into <项目路径> --yes

  只影响那一个项目；本机其它项目不受影响。撤销时同一句换成 --uninstall。

EOS
  fi

  cat <<'EOS'
  只有一种情况还要手工一步：宿主既不认这套技能目录约定、又不把说明的
  存在告诉模型。那就把常驻触发规则贴到「对话开始前会被读到」的地方：

      bash install.sh --print-trigger

  怎么确认真的通了：开一个新会话，问一句这部作品相关的问题
  （比如「乌萨奇出现在哪些集」），看它有没有去查而不是凭记忆答。

EOS
fi
