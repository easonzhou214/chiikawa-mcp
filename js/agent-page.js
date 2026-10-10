/*
 * 接入页（agent.html）的辅助脚本。
 *
 * 这一页把原文抄了一份进 HTML，好在纯静态站上也能看到 —— 但抄的东西会过期。
 * 所以这里做两件事：
 *   1. 用页面已经加载的数据，把「规模」这类数字算出来（站点在哪都能算）
 *   2. 如果 library/ 就在旁边（本地、或带资料库的部署），去读真文件比对，
 *      逐项核对我抄的那几段，把过期的地方标出来
 *
 * 第 2 步失败不当错误处理：发布后的站点本来就没有 library/，那不是异常。
 */
(function () {
  var CK = window.CK || {};
  var EPS = CK.episodes || [];
  var CHARS = CK.characters || [];
  var ARCS = CK.arcs || [];

  function $(id) { return document.getElementById(id); }

  /* ---------- 一、用已加载的数据算规模（任何环境都能算） ---------- */

  var shorts = 0, lines = 0;
  EPS.forEach(function (e) {
    (e.sh || []).forEach(function (s) {
      shorts++;
      lines += (s.l || []).length;
    });
  });

  var scale = $("a-scale");
  if (scale && EPS.length) {
    scale.textContent = "第 1–" + EPS.length + " 话、" + shorts + " 个短篇、" +
      lines + " 条台词与动作记录";
  }

  var counts = $("a-counts");
  if (counts && EPS.length) {
    counts.textContent = EPS.length + " 集 / " + shorts + " 短篇 / " +
      CHARS.length + " 角色 / " + ARCS.length + " 篇章 / " + lines + " 条台词与动作";
  }

  /* ---------- 二、和真文件比对（只在 library/ 存在时才有意义） ---------- */

  // 规范化：去掉包装、去掉引号（那是拼接字符串的标记，不是正文）、
  // 统一换行与空白。这一页是人读的，比的是内容，不是排版。
  function norm(s) {
    if (s == null) return null;
    return stripWrap(s)
      .replace(/[""]/g, "")
      .replace(/\r\n?/g, "\n")
      .replace(/\s+/g, " ")
      .trim();
  }

  function embedded(key) {
    var node = document.querySelector('[data-drift="' + key + '"]');
    if (!node) return null;
    return node.tagName === "PRE" ? (node.querySelector("code") || node).textContent : node.textContent;
  }

  // 每一项比对都要过同一条管道，两侧都过：
  //   window()  —— 页面为了显示多带的东西（标记行、引号、拼接用的 + 号）
  //   scope()   —— 从文件里摘出要比对的那一段
  // 关键在「两侧都过」：早先只给文件那侧做处理，页面永远比文件长一截，
  // 报出来的是假的不一致。
  //
  // 顺带一个坑：本文件内联在 script 标签里执行，源码里一旦出现 HTML 注释的
  // 起始符，解析器就会把后面的脚本吞掉。所以下面一律按行过滤、不写那种正则。
  function stripWrap(s) {
    return String(s == null ? "" : s).split("\n").filter(function (l) {
      var t = l.trim();
      if (l.indexOf("资料库 · 人格锚") >= 0) return false; // 注入用的标记行
      if (t === "+") return false;                          // 拼接续行
      return true;
    }).join("\n");
  }

  var CHECKS = [
    {
      key: "persona",
      label: "人格注入正文",
      file: "library/persona/usagi-persona.md",
      scope: function (src) { return src; }
    },
    {
      key: "instructions",
      label: "服务握手说明",
      file: "library/mcp/server.js",
      // 这段在源码里是若干行字符串拼起来的，所以文件侧要做的只有一件事：
      // 把每行字符串的**内容**摘出来（引号、缩进、加号、逗号都是 JS 语法，
      // 不是正文）。摘完剩下的处理和页面侧完全一样，两侧就对称了。
      // 早先让文件侧多剥一层引号，页面侧没剥，于是永远对不上。
      scope: function (src) {
        var m = src.match(/instructions:\s*\n([\s\S]*?)\n\s*\}\);/);
        if (!m) return null;
        var out = "";
        m[1].split("\n").forEach(function (l) {
          var q = l.match(/"([^"]*)"/);
          if (q) out += q[1];
        });
        return out;
      }
    },
    {
      key: "skill-desc",
      label: "方法说明的描述",
      file: "library/skill/SKILL.md",
      scope: function (src) {
        var m = src.match(/description:\s*(.*)/);
        return m ? m[1] : null;
      }
    }
  ];

  function render(id, html) { var el = $(id); if (el) el.innerHTML = html; }

  // 全部检查都拿不到真文件时，这一节整体降级成一句说明，不显示成一堆错误
  fetch("library/persona/usagi-persona.md", { cache: "no-store" })
    .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
    .then(function () { runChecks(); })
    .catch(function () {
      render("a-drift",
        '<p>这一页现在读不到 <code>library/</code>，所以没法自动核对——这不一定是问题：' +
        '发布出去的站点本来就不带这个目录。<b>发布的页面里那几段原文只是快照</b>，' +
        '以仓库里的文件为准。</p>');
    });

  function runChecks() {
    var results = [];
    var pending = CHECKS.length;

    CHECKS.forEach(function (c) {
      fetch(c.file, { cache: "no-store" })
        .then(function (r) { return r.ok ? r.text() : null; })
        .then(function (src) {
          var mine = embedded(c.key);
          var real = src ? c.scope(src) : null;
          var a = norm(mine);
          var b = norm(real);
          if (a == null || b == null || !a || !b) {
            results.push({ label: c.label, state: "unknown", file: c.file });
          } else if (a === b) {
            results.push({ label: c.label, state: "ok", file: c.file });
          } else {
            results.push({ label: c.label, state: "drift", file: c.file });
          }
        })
        .catch(function () {
          results.push({ label: c.label, state: "unknown", file: c.file });
        })
        .then(function () {
          if (--pending === 0) report(results);
        });
    });
  }

  function report(results) {
    var bad = results.filter(function (r) { return r.state === "drift"; });
    var unknown = results.filter(function (r) { return r.state === "unknown"; });
    var good = results.filter(function (r) { return r.state === "ok"; });

    var rows = results.map(function (r) {
      var mark = r.state === "ok" ? "✔ 与源文件一致"
        : r.state === "drift" ? "✘ <b>和源文件对不上了</b>"
        : "— 读不到源文件";
      return "<tr><td>" + r.label + "</td><td>" + mark + "</td><td><code>" + r.file + "</code></td></tr>";
    }).join("");

    var head = bad.length
      ? '<p><b>有 ' + bad.length + ' 项对不上。</b>这一页抄的原文已经落后于 <code>library/</code> 里的文件，' +
        '以文件为准，并回来更新这一页。</p>'
      : '<p>抄进这一页的 <b>' + good.length + '</b> 项与 <code>library/</code> 里的源文件逐字一致' +
        (unknown.length ? '（另有 ' + unknown.length + ' 项读不到，未核对）' : "") + '。</p>';

    render("a-drift", head +
      "<table><tr><th>项</th><th>状态</th><th>源文件</th></tr>" + rows + "</table>");
  }
})();
