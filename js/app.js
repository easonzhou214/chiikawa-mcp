(function () {
  var CK = window.CK || {};

  /* 先把数据整理成固定的形状，再交给渲染层。
     理由：渲染层里到处是 e.sh[0]、c.tags.slice(2) 这类直接访问，只要某一条
     数据少个字段，抛出的异常就会让那一整块（有时是整页）变成空白 —— 而且
     页面不会报错，看上去像"没数据"。实测过四种：首页两块全空、剧集页
     「共 345 话」却列表为空、角色图鉴 0 张卡、搜索页连空状态都没有。
     在这里补默认值，渲染层就不必到处写 || []。 */
  function normEp(e) {
    if (!e || typeof e !== "object") return null;
    e.cn = e.cn || ""; e.jp = e.jp || ""; e.d = e.d || "";
    e.a = Array.isArray(e.a) ? e.a : [];
    e.sh = Array.isArray(e.sh) ? e.sh : [];
    e.sh.forEach(function (s) {
      if (!s || typeof s !== "object") return;
      s.t = s.t || ""; s.s = s.s || ""; s.c = s.c || "";
      s.l = Array.isArray(s.l) ? s.l : [];
      s.l.forEach(function (l) { if (l) { l.w = l.w || ""; l.k = l.k || ""; l.x = l.x == null ? "" : l.x; } });
    });
    return e;
  }
  function normChar(c) {
    if (!c || typeof c !== "object") return null;
    c.cn = c.cn || c.id || ""; c.jp = c.jp || ""; c.romaji = c.romaji || "";
    c.role = c.role || ""; c.intro = c.intro || ""; c.line = c.line || "";
    c.tags = Array.isArray(c.tags) ? c.tags : [];
    c.alias = Array.isArray(c.alias) ? c.alias : [];
    c.eps = Array.isArray(c.eps) ? c.eps : [];
    return c;
  }
  function normArc(a) {
    if (!a || typeof a !== "object") return null;
    a.cn = a.cn || a.id || ""; a.jp = a.jp || ""; a.tag = a.tag || "";
    a.summary = a.summary || ""; a.status = a.status || "";
    // 起止话数漏了会渲染成「第 undefined–undefined 话」，这里一并兜住
    a.start = Number(a.start) || 0; a.end = Number(a.end) || 0;
    return a;
  }

  // map 已经返回新数组，不必再 slice 一次
  var EPS = (CK.episodes || []).map(normEp).filter(Boolean)
    .sort(function (a, b) { return a.id - b.id; });
  var ARCS = (CK.arcs || []).map(normArc).filter(Boolean);
  var CHARS = (CK.characters || []).map(normChar).filter(Boolean);
  var ARC_MAP = {};
  ARCS.forEach(function (a) { ARC_MAP[a.id] = a; });

  /* 万不得已加载不出来时，只显示一个「缺图」提示，不用自绘形象冒充角色 */
  var NOIMG = "data:image/svg+xml;utf8," + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="#F1ECE6"/><text x="50" y="55" font-size="12" text-anchor="middle" fill="#B6AAA2">缺图</text></svg>');

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  /* 高亮用的正则会按关键词缓存。
     原来每高亮一个文本片段就 new 一个 RegExp，实测搜「吉伊」时单次渲染要
     构造两千多个 —— 缓存之后只构造一次。缓存只留最近几个关键词，不会长。 */
  var HL_CACHE = {};
  var HL_CACHE_KEYS = [];
  function hlRe(kw) {
    // 用 hasOwnProperty 而不是直接取值：缓存里可能是 null（非法正则），
    // 而 null 是 falsy，直接判断会让它每次都重建；顺带挡住 constructor 这类原型键。
    if (Object.prototype.hasOwnProperty.call(HL_CACHE, kw)) return HL_CACHE[kw];
    var re;
    try {
      re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    } catch (e) {
      re = null;
    }
    HL_CACHE[kw] = re;
    HL_CACHE_KEYS.push(kw);
    if (HL_CACHE_KEYS.length > 8) delete HL_CACHE[HL_CACHE_KEYS.shift()];
    return re;
  }
  /* 高亮。顺序是「先在原文上匹配，再逐段转义」，不能反过来。
     反过来（先 esc 再匹配）有两个坑，都会真的出现在页面上：
       · 搜「&」「<」匹配不到 —— 原文里那个字符已经变成 &amp; 了；
       · 搜到实体名（amp / lt / quot）会把 &amp; 从中间切开，
         浏览器把剩下的半截当普通文本，页面显示成 A&;B。 */
  function hl(text, kw) {
    var s = text == null ? "" : String(text);
    if (!kw) return esc(s);
    var re = hlRe(kw);
    if (!re) return esc(s);
    re.lastIndex = 0;   // 带 g 的正则是有状态的，复用前必须复位
    var out = "", last = 0, m;
    while ((m = re.exec(s)) !== null) {
      if (!m[0]) { re.lastIndex++; continue; }   // 空匹配会让循环原地打转
      out += esc(s.slice(last, m.index)) + "<mark>" + esc(m[0]) + "</mark>";
      last = m.index + m[0].length;
    }
    return out + esc(s.slice(last));
  }
  /* 中文引进版的分季边界是外部事实（B 站／优酷／芒果 TV 的引进范围）。
     标签、下拉选项、tooltip 全从这一份出来 —— 原来 episodes.html 里另抄了一份，
     两处措辞已经不一致了（「中文版第一季」vs「中文引进版 第一季」）。 */
  var SEASONS = [
    { id: 1, label: "中文引进版 第一季（第 1–120 话）", option: "中文版第一季（1–120）", tag: "中文版第 1 季" },
    { id: 2, label: "中文引进版 第二季（第 121–240 话）", option: "中文版第二季（121–240）", tag: "中文版第 2 季" },
    { id: 3, label: "中文引进版尚未覆盖（第 241 话以后）", option: "中文版未覆盖（241 以后）", tag: "中文版未引进" }
  ];
  function seasonOf(id) { return id <= 120 ? 1 : (id <= 240 ? 2 : 3); }
  function seasonById(id) { return SEASONS[id - 1] || SEASONS[SEASONS.length - 1]; }
  function confBadge(c) {
    return c === "A"
      ? '<span class="badge-lv a">可信度 A · 有资料支撑</span>'
      : '<span class="badge-lv">可信度 B · 依据标题与设定整理</span>';
  }
  function arcTags(ids) {
    return (ids || []).map(function (id) {
      var a = ARC_MAP[id];
      if (!a) return "";
      return '<a class="tag pk" href="arcs.html#' + a.id + '">' + esc(a.cn) + "</a>";
    }).join("");
  }
  function imgTag(src, alt, cls) {
    return '<img src="' + esc(src) + '" alt="' + esc(alt) + '"' + (cls ? ' class="' + cls + '"' : "") +
      ' onerror="this.onerror=null;this.src=\'' + NOIMG + '\'">';
  }

  /* 把主色朝白色方向混，得到柔和的同色系浅色 */
  function soften(hex, k) {
    var h = String(hex || "#E4698F").replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.substr(0, 2), 16), g = parseInt(h.substr(2, 2), 16), b = parseInt(h.substr(4, 2), 16);
    function mix(c) { return Math.round(c + (255 - c) * k); }
    return "rgb(" + mix(r) + "," + mix(g) + "," + mix(b) + ")";
  }

  /* 官方没有立绘的角色：统一用同一款占位符，不画角色形象 */
  function phArt(c) {
    var col = c.color || "#E4698F";
    var svg = '<svg class="ph-svg" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" aria-hidden="true">' +
      '<circle cx="50" cy="44" r="26" fill="#fff" stroke="' + soften(col, 0.45) +
      '" stroke-width="1.8" stroke-dasharray="5.5 4.5"/>' +
      '<text x="50" y="44" dy="0.34em" text-anchor="middle" font-size="25" font-weight="800" fill="' + col + '">' +
      esc(c.cn.slice(0, 1)) + "</text>" +
      '<text x="50" y="82" dy="0.32em" text-anchor="middle" font-size="7" letter-spacing="0.6" fill="#BDB1A9">' +
      "暂无官方立绘</text>" +
      "</svg>";
    return '<div class="char-ph" style="background:' + soften(col, 0.94) + '">' + svg + "</div>";
  }
  function charArtHTML(c) { return c.img ? imgTag(c.img, c.cn) : phArt(c); }

  /* ================= 首页 ================= */
  function initHome() {
    var box = $("#today");
    if (box) {
      if (!EPS.length) {
        box.innerHTML = '<p class="muted">剧集数据加载中……</p>';
      } else {
        var d = new Date();
        var seed = d.getFullYear() * 372 + (d.getMonth() + 1) * 31 + d.getDate();
        var ep = EPS[seed % EPS.length];
        var s = ep.sh[0] || { s: "", l: [] };
        var l = s.l[0] || null;
        box.innerHTML =
          '<div class="lab">今日随机一话</div>' +
          '<h2>第 ' + ep.id + ' 话 · ' + esc(ep.cn) + "</h2>" +
          "<p>" + esc(s.s.length > 130 ? s.s.slice(0, 130) + "……" : s.s) + "</p>" +
          (l ? '<p class="ln"><b>' + esc(l.w) + "：</b>" + esc(l.x) + "</p>" : "") +
          '<div class="acts"><a class="btn" href="episodes.html#' + ep.id + '">看这一话的完整剧情</a>' +
          '<a class="btn ghost" href="search.html">搜台词</a></div>';
      }
    }

    var st = $("#stats");
    if (st) {
      var shorts = 0, lines = 0;
      EPS.forEach(function (e) { e.sh.forEach(function (x) { shorts++; lines += x.l.length; }); });
      st.innerHTML = [
        // 这个数字以前写死成 120，站点扩到 345 话之后首页一直在撒谎。
        [EPS.length, "话已收录"],
        [shorts, "个短篇剧情"],
        [lines, "条台词记录"],
        [CHARS.length, "位角色档案"]
      ].map(function (p) { return '<div class="stat"><b>' + p[0] + "</b><span>" + p[1] + "</span></div>"; }).join("");
    }
  }

  /* ================= 剧集总览 ================= */
  function initEpisodes() {
    var list = $("#ep-list");
    if (!list) return;
    var input = $("#q"), selArc = $("#f-arc"), selConf = $("#f-conf"), selSeason = $("#f-season");
    var state = { kw: "", arc: "all", conf: "all", season: "all" };

    var arcSet = {};
    EPS.forEach(function (e) { (e.a || []).forEach(function (id) { arcSet[id] = (arcSet[id] || 0) + 1; }); });
    if (selArc) {
      Object.keys(arcSet).forEach(function (id) {
        var a = ARC_MAP[id]; if (!a) return;
        var o = document.createElement("option");
        o.value = id; o.textContent = a.cn + "（" + arcSet[id] + " 话）";
        selArc.appendChild(o);
      });
    }
    // 季度选项也从 SEASONS 生成，不再在 HTML 里抄第二份
    if (selSeason) {
      SEASONS.forEach(function (s) {
        var o = document.createElement("option");
        o.value = String(s.id); o.textContent = s.option;
        selSeason.appendChild(o);
      });
    }

    function matches(e) {
      if (state.season !== "all" && seasonOf(e.id) !== Number(state.season)) return false;
      if (state.arc !== "all" && (e.a || []).indexOf(state.arc) < 0) return false;
      if (state.conf !== "all") {
        var has = e.sh.some(function (s) { return s.c === state.conf; });
        if (!has) return false;
      }
      if (!state.kw) return true;
      var k = state.kw.toLowerCase();
      if (("第" + e.id + "话 " + e.cn + " " + e.jp).toLowerCase().indexOf(k) >= 0) return true;
      return e.sh.some(function (s) {
        if ((s.t + " " + s.s).toLowerCase().indexOf(k) >= 0) return true;
        return (s.l || []).some(function (l) { return (l.w + l.x).toLowerCase().indexOf(k) >= 0; });
      });
    }

    function epHTML(e, kw) {
      var body = e.sh.map(function (s) {
        var lines = s.l.length
          ? s.l.map(function (l) {
              return '<div class="line"><span class="who' + (l.k === "a" ? " act" : "") + '">' + esc(l.w) + '：</span><span class="txt">' + hl(l.x, kw) + "</span></div>";
            }).join("")
          : '<div class="empty">（本段落暂无台词记录）</div>';
        return '<div class="short">' +
          '<div class="short-head"><h3>' + hl(s.t, kw) + "</h3>" + confBadge(s.c) + "</div>" +
          "<p>" + hl(s.s, kw) + "</p>" +
          '<div class="lines"><div class="lt">台词与行为记录（角色名：内容）</div>' + lines + "</div>" +
          "</div>";
      }).join("");
      var season = seasonById(seasonOf(e.id));
      return '<article class="ep" id="ep-' + e.id + '">' +
        '<div class="ep-head" role="button" tabindex="0" aria-expanded="false" aria-controls="epb-' + e.id + '">' +
        '<div class="ep-no"><small>第</small><b>' + e.id + "</b></div>" +
        '<div class="ep-main">' +
        '<div class="cn">' + hl(e.cn, kw) + "</div>" +
        '<div class="jp">' + esc(e.jp) + "</div>" +
        '<div class="ep-meta"><span class="tag bl">' + esc(e.d) + "</span>" +
        '<span class="tag pu" title="' + esc(season.label) + '">' + esc(season.tag) + "</span>" +
        (e.a.length ? arcTags(e.a) : '<span class="tag gy">单话</span>') +
        "<span class=\"tag gy\">" + e.sh.length + " 个短篇</span></div>" +
        "</div>" +
        '<div class="ep-arrow">▾</div>' +
        "</div>" +
        '<div class="ep-body" id="epb-' + e.id + '">' + body + "</div>" +
        "</article>";
    }

    // 重建整个列表时要把「已经展开的那几话」记下来再还原：
    // 不然边搜边读时，每敲一个字都会把展开的内容合上。
    function openIds() {
      return $$(".ep.open", list).map(function (el) { return el.id; });
    }

    function render() {
      var keep = openIds();
      var hits = EPS.filter(matches);
      var count = $("#res-count");
      if (count) count.textContent = "共 " + hits.length + " 话";
      list.innerHTML = hits.length
        ? hits.map(function (e) { return epHTML(e, state.kw); }).join("")
        : '<div class="empty-state"><div class="big">🐰</div><p>没有找到符合条件的话数，换个关键词试试。</p></div>';
      keep.forEach(function (id) {
        var el = document.getElementById(id);
        if (el) setOpen(el, true);
      });
    }

    // 展开状态同时写在 class 和 aria-expanded 上，读屏才看得到
    function setOpen(article, on) {
      article.classList.toggle("open", on);
      var head = article.querySelector(".ep-head");
      if (head) head.setAttribute("aria-expanded", on ? "true" : "false");
    }

    function toggle(article) {
      setOpen(article, !article.classList.contains("open"));
    }

    function toggleFrom(ev) {
      var head = ev.target.closest(".ep-head");
      if (!head) return;
      // 点标题里的篇章标签是去跳转的，别顺手把这一话展开
      if (ev.target.closest("a")) return;
      toggle(head.parentElement);
    }

    list.addEventListener("click", toggleFrom);
    list.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      var head = ev.target.closest(".ep-head");
      if (!head) return;
      /* 两道判断，和鼠标那一侧对齐：
         1) 焦点在篇章链接上时，这次回车/空格是给链接的 —— 少了这一句，
            preventDefault 会吃掉跳转，键盘用户永远进不去篇章页；
         2) 其余情况按「切换」，不是写死展开 —— 原来写死 true，键盘只能开不能关。 */
      if (ev.target.closest("a")) return;
      ev.preventDefault();
      toggle(head.parentElement);
    });

    // chip 与下拉框是同一份状态的两个入口，两边都要同步（hash 也是第三个入口）。
    function syncChips(value) {
      $$(".chip[data-arc]").forEach(function (x) {
        x.classList.toggle("on", x.getAttribute("data-arc") === value);
      });
    }

    function applyHash() {
      var hash = location.hash.replace("#", "");
      if (!hash) return;
      if (/^arc:/.test(hash)) {
        state.arc = hash.slice(4);
        if (selArc) selArc.value = state.arc;
        syncChips(state.arc);
        render();
      } else {
        var m = document.getElementById("ep-" + hash);
        if (m) { setOpen(m, true); setTimeout(function () { m.scrollIntoView({ block: "center" }); }, 60); }
      }
    }

    $$(".chip[data-arc]").forEach(function (c) {
      c.addEventListener("click", function () {
        state.arc = c.getAttribute("data-arc");
        syncChips(state.arc);
        if (selArc) selArc.value = state.arc;
        render();
      });
      // chip 原来是 span，键盘和读屏都用不了；补上按钮语义与回车/空格
      c.addEventListener("keydown", function (ev) {
        if (ev.key !== "Enter" && ev.key !== " ") return;
        ev.preventDefault();
        c.click();
      });
    });

    // 输入防抖：不防抖的话每敲一个字都要重建整份列表
    //（实测约 29 万字符、一万多个元素），中文输入法下尤其明显。
    var debounceTimer = null;
    function debouncedRender() {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(render, 150);
    }
    if (input) input.addEventListener("input", function () { state.kw = input.value.trim(); debouncedRender(); });
    if (selArc) selArc.addEventListener("change", function () {
      state.arc = selArc.value;
      syncChips(state.arc);
      render();
    });
    if (selConf) selConf.addEventListener("change", function () { state.conf = selConf.value; render(); });
    if (selSeason) selSeason.addEventListener("change", function () { state.season = selSeason.value; render(); });

    render();
    applyHash();
    // 站内改 hash、前进后退、或者从别的页面跳回来，都要跟着走
    window.addEventListener("hashchange", applyHash);
  }

  /* ================= 篇章地图 ================= */
  /* 篇幅的 start/end 是「主体连续话数」，但有些篇章会在后面被回访
     （「郎拉面篇」41–43，第 125 话又回到那家店的留言板）。这些回访集在
     episodes[].a 里也标了篇章，于是筛出来的条数会比「第 41–43 话」多。
     不是错，但页面上必须说清楚，不然读者会以为筛选坏了。 */
  function arcRevisits(a) {
    return EPS.filter(function (e) {
      return (e.a || []).indexOf(a.id) >= 0 && (e.id < a.start || e.id > a.end);
    });
  }

  function initArcs() {
    var box = $("#arc-list");
    if (!box) return;
    var totalRev = 0, arcsRev = 0;
    ARCS.forEach(function (a) {
      var n = arcRevisits(a).length;
      if (n) { arcsRev++; totalRev += n; }
    });
    var note = $("#arc-note");
    if (note) {
      var lastEp = EPS.length ? EPS[EPS.length - 1].id : 0;
      note.textContent = "共 " + ARCS.length + " 个长篇，已按起止话数逐集写入第 1–" +
        lastEp + " 话的剧集内容。其中 " + arcsRev + " 篇另在范围之外有回访集（合计 " +
        totalRev + " 话），点进去会一并筛出，所以条数可能比「第 X–Y 话」多一些。";
    }
    var list = ARCS.slice().sort(function (a, b) { return a.start - b.start; });
    box.innerHTML = list.map(function (a) {
      var rev = arcRevisits(a).length;
      return '<div class="arc ' + (a.status === "later" ? "later" : "") + '" id="' + a.id + '">' +
        '<div class="arc-card">' +
        '<div class="arc-top"><h3>' + esc(a.cn) + "</h3>" +
        '<span class="jp">' + esc(a.jp) + "</span>" +
        '<span class="tag ' + (a.status === "done" ? "pk" : "gy") + '">' + esc(a.tag) + "</span>" +
        (a.highlight ? '<span class="tag yl">重点</span>' : "") +
        '<span class="range">第 ' + a.start + "–" + a.end + " 话</span></div>" +
        "<p>" + esc(a.summary) + "</p>" +
        '<div class="arc-foot"><a class="btn ghost" href="episodes.html#arc:' + a.id + '">看这个篇章的话数 →</a>' +
        (rev ? '<span class="tag gy">另有 ' + rev + " 话回访</span>" : "") +
        "</div>" +
        "</div></div>";
    }).join("");
  }

  /* ================= 角色图鉴 ================= */
  function initChars() {
    var box = $("#chars");
    if (!box) return;
    // 卡片要能用键盘打开：补 role/tabindex + Enter/Space。
    // 不然这 30 张卡只有鼠标点得开，而弹窗是看详情的唯一入口。
    box.innerHTML = CHARS.map(function (c) {
      return '<article class="char" data-id="' + c.id + '" role="button" tabindex="0">' +
        '<div class="char-img' + (c.img ? "" : " ph") + '">' + charArtHTML(c) + "</div>" +
        '<div class="char-info"><h3>' + esc(c.cn) + "</h3>" +
        '<div class="jp">' + esc(c.jp) + (c.romaji ? " / " + esc(c.romaji) : "") + "</div>" +
        '<div class="tags"><span class="tag pk">' + esc(c.role) + "</span>" +
        c.tags.slice(0, 2).map(function (t) { return '<span class="tag">' + esc(t) + "</span>"; }).join("") +
        "</div></div></article>";
    }).join("");

    var modal = $("#char-detail");
    var lastFocus = null;

    function closeModal() {
      modal.classList.remove("on");
      document.body.style.overflow = "";
      // 焦点还回去，不然键盘用户关掉弹窗后不知道自己在哪
      if (lastFocus && lastFocus.focus) lastFocus.focus();
      lastFocus = null;
    }

    function openFor(el) {
      var c = CHARS.filter(function (x) { return x.id === el.getAttribute("data-id"); })[0];
      if (!c) return;
      lastFocus = el;
      $("#cd-body").innerHTML =
        '<div class="top' + (c.img ? "" : " ph") + '">' +
        charArtHTML(c) +
        '<div class="meta"><h2>' + esc(c.cn) + "</h2>" +
        '<div class="jp">' + esc(c.jp) + " / " + esc(c.romaji) + "</div>" +
        "<dl><dt>定位</dt><dd>" + esc(c.role) + "</dd>" +
        (c.alias.length ? "<dt>别名</dt><dd>" + c.alias.map(esc).join("、") + "</dd>" : "") +
        "<dt>日配</dt><dd>" + esc(c.cvJp) + "</dd>" +
        "<dt>中配</dt><dd>" + esc(c.cvCn) + "</dd>" +
        "<dt>标签</dt><dd>" + c.tags.map(esc).join("、") + "</dd>" +
        "<dt>代表话数</dt><dd>" + (c.eps.length
          ? c.eps.map(function (n) { return '<a class="tag bl" href="episodes.html#' + n + '">第 ' + n + " 话</a>"; }).join(" ")
          : '<span class="muted">暂无对应话数</span>') + "</dd></dl>" +
        "</div></div>" +
        '<div class="bd"><p>' + esc(c.intro) + "</p>" +
        '<div class="q">' + esc(c.line) + "</div>" +
        '<div class="more"><a class="btn ghost" href="search.html?q=' + encodeURIComponent(c.cn) + '">搜这个词的全部记录 →</a></div></div>';
      modal.classList.add("on");
      document.body.style.overflow = "hidden";   // 弹窗打开时别再滚背景
      var close = $("[data-close]", modal);
      if (close) close.focus();
    }

    /* 焦点陷阱：弹窗声明了 aria-modal="true"，Tab 就不该跑到背后的页面上。
       不用 offsetParent 判断可见性 —— 弹窗本身是 position:fixed，
       在它里面的元素 offsetParent 可能为 null，会被误判成隐藏。 */
    function trapFocus(ev) {
      if (ev.key !== "Tab" || !modal.classList.contains("on")) return;
      var items = $$("a[href],button:not([disabled]),[tabindex]:not([tabindex='-1'])", modal)
        .filter(function (el) { return el.getClientRects().length > 0; });
      if (!items.length) return;
      var first = items[0], last = items[items.length - 1];
      if (ev.shiftKey && document.activeElement === first) {
        ev.preventDefault(); last.focus();
      } else if (!ev.shiftKey && document.activeElement === last) {
        ev.preventDefault(); first.focus();
      }
    }

    box.addEventListener("click", function (ev) {
      var el = ev.target.closest(".char");
      if (el) openFor(el);
    });
    box.addEventListener("keydown", function (ev) {
      if (ev.key !== "Enter" && ev.key !== " ") return;
      var el = ev.target.closest(".char");
      if (!el) return;
      ev.preventDefault();
      openFor(el);
    });

    $$("[data-close]", modal).forEach(function (b) {
      b.addEventListener("click", closeModal);
    });
    modal.addEventListener("click", function (ev) { if (ev.target === modal) closeModal(); });
    modal.addEventListener("keydown", trapFocus);
    document.addEventListener("keydown", function (ev) {
      if (ev.key === "Escape" && modal.classList.contains("on")) closeModal();
    });
  }

  /* ================= 台词搜索 ================= */
  function initSearch() {
    var input = $("#sq"), out = $("#s-out"), cnt = $("#s-count");
    if (!input || !out) return;

    var INDEX = [];
    EPS.forEach(function (e) {
      INDEX.push({ ep: e.id, epCn: e.cn, kind: "话数标题", who: "", text: e.cn + "（" + e.jp + "）", t: e.cn });
      e.sh.forEach(function (s) {
        INDEX.push({ ep: e.id, epCn: e.cn, kind: "剧情概要", who: "", text: s.s, t: s.t });
        (s.l || []).forEach(function (l) {
          INDEX.push({ ep: e.id, epCn: e.cn, kind: l.k === "t" ? "台词" : "行为", who: l.w, text: l.x, t: s.t });
        });
      });
    });
    ARCS.forEach(function (a) {
      INDEX.push({ ep: a.start, epCn: a.cn, kind: "篇章", who: "", text: a.summary, t: a.cn, arc: a.id });
    });
    CHARS.forEach(function (c) {
      // 有角色的 eps 是空的（塞壬、人鱼），以前直接取 c.eps[0]，
      // 结果搜索页会显示「第 undefined 话」并链到 episodes.html#undefined。
      var ep = c.eps.length ? c.eps[0] : null;
      INDEX.push({
        ep: ep,
        epCn: ep == null ? "暂无代表话数" : ep + " 话附近",
        kind: "角色", who: c.cn, text: c.intro, t: c.cn,
        // 别名只进检索、不进标题：「小八」「哈奇瓦乐」都能翻到哈奇喵，
        // 但结果行仍然显示正名，免得一行里堆四个名字。
        keys: (c.alias || []).join(" ")
      });
    });

    function run(kw) {
      kw = (kw || "").trim();
      if (kw.length < 1) {
        out.innerHTML = '<div class="empty-state"><div class="big">🔍</div><p>输入角色名、关键词或者一句台词，就能翻出全部相关记录。<br>比如：<b>哈奇喵</b>、<b>除草检定</b>、<b>缎带</b>、<b>乌萨奇</b>。</p></div>';
        cnt.textContent = "";
        return;
      }
      var k = kw.toLowerCase();
      var hits = INDEX.filter(function (r) {
        return (r.text + " " + r.who + " " + r.t + " " + r.epCn + " " + (r.keys || ""))
          .toLowerCase().indexOf(k) >= 0;
      });
      var shown = hits.slice(0, 300);
      cnt.textContent = hits.length
        ? "命中 " + hits.length + " 条" + (hits.length > 300 ? "（仅显示前 300 条）" : "")
        : "";
      out.innerHTML = shown.length
        ? shown.map(function (r) {
            var snippet = r.text;
            var i = snippet.toLowerCase().indexOf(k);
            if (i > 60) snippet = "……" + snippet.slice(i - 50);
            if (snippet.length > 200) snippet = snippet.slice(0, 200) + "……";
            // 角色条目可能没有代表话数（塞壬、人鱼），这条就不能给跳转链接
            var where = r.ep == null ? esc(r.epCn) : "第 " + r.ep + " 话 · " + esc(r.epCn);
            /* 篇章条目链到的是「按篇章筛选」，并没有定位到某一话，
               所以按钮得说「看这个篇章」，不能跟着写「跳到第 N 话」。 */
            var jump = "";
            if (r.arc) {
              jump = '<div class="jump"><a class="tag pk" href="episodes.html#arc:' + r.arc +
                '">看「' + esc(r.t) + '」的全部话数 →</a></div>';
            } else if (r.ep != null) {
              jump = '<div class="jump"><a class="tag pk" href="episodes.html#' + r.ep +
                '">跳到第 ' + r.ep + " 话 →</a></div>";
            }
            return '<div class="hit"><div class="h-top">' +
              '<span class="tag gy">' + esc(r.kind) + "</span> " +
              (r.who ? "<b>（" + esc(r.who) + "）</b> " : "") +
              where + " · " + esc(r.t) +
              '</div><div class="h-body">' +
              (r.who ? "<b>" + hl(r.who, kw) + "：</b>" : "") + hl(snippet, kw) +
              "</div>" + jump + "</div>";
          }).join("")
        : '<div class="empty-state"><div class="big">🐰</div><p>没有找到「' + esc(kw) + "」相关的记录。</p></div>";
    }

    var q0 = new URLSearchParams(location.search).get("q");
    if (q0) { input.value = q0; run(q0); } else { run(""); }
    // 与剧集页同理：输入防抖，别每敲一个字就全表扫一遍再重建结果
    var searchTimer = null;
    input.addEventListener("input", function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () { run(input.value); }, 150);
    });
  }

  /* 五个初始化各自隔离。
     它们以前串在一个 DOMContentLoaded 里顺序执行，任何一个抛错后面的全不跑；
     而渲染函数里到处是直接取值，数据一有缺失就会整块变成空白。
     现在数据在入口已归一化，这里再兜一层：一处坏掉不影响别处。 */
  document.addEventListener("DOMContentLoaded", function () {
    [
      ["首页", initHome],
      ["剧集总览", initEpisodes],
      ["篇章地图", initArcs],
      ["角色图鉴", initChars],
      ["台词搜索", initSearch]
    ].forEach(function (pair) {
      try {
        pair[1]();
      } catch (err) {
        // 不弹给用户看，但也不能静默：留一条带页面名的线索给控制台
        if (window.console && console.error) {
          console.error("[" + pair[0] + "] 初始化失败：", err);
        }
      }
    });
  });
})();
