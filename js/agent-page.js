/*
 * 接入页（agent.html）的辅助脚本。
 *
 * 这一页把两段原文抄了进来（服务说明、注入的 agent 正文），好在纯静态站上也
 * 看得到。抄的东西会过期，所以这里读 library/ 里的真文件比一遍，对不上就标出来。
 *
 * 读不到 library/ 时（发布出去的站点就是这样）降级成一句说明，不当错误。
 */
(function () {
  function $(id) { return document.getElementById(id); }

  // 规范化：去掉包装、去掉引号（那是拼接字符串的语法，不是正文）、折叠空白。
  // 比的是内容，不是排版。
  function stripWrap(s) {
    return String(s == null ? "" : s).split("\n").filter(function (l) {
      var t = l.trim();
      if (l.indexOf("资料库 · 人格锚") >= 0) return false; // 注入用的标记行
      if (t === "+") return false;                          // 拼接续行
      return true;
    }).join("\n");
  }
  function norm(s) {
    if (s == null) return null;
    return stripWrap(s).replace(/[""]/g, "").replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim();
  }

  function embedded(key) {
    var node = document.querySelector('[data-drift="' + key + '"]');
    if (!node) return null;
    return node.tagName === "PRE" ? (node.querySelector("code") || node).textContent : node.textContent;
  }

  // 每一段过了 scope 之后，两侧剩下的处理完全一样 ——
  // 早先只给文件那侧做处理，页面侧没做，结果报出假的不一致。
  var CHECKS = [
    {
      key: "persona",
      label: "注入的 agent 正文",
      file: "library/persona/usagi-persona.md",
      scope: function (src) { return src; }
    },
    {
      key: "instructions",
      label: "服务握手说明",
      file: "library/mcp/server.js",
      // 源码里是若干行字符串拼起来的，这里只把每行的字面量内容摘出来
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
    }
  ];

  function render(html) { var el = $("a-drift"); if (el) el.innerHTML = html; }

  fetch("library/persona/usagi-persona.md", { cache: "no-store" })
    .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
    .then(function () { run(); })
    .catch(function () {
      render("这一页读不到 <code>library/</code>，没法自动核对——发布出去的站点本来就不带这个目录。" +
        "页面里那两段原文只是快照，以仓库里的文件为准。");
    });

  function run() {
    var results = [];
    var pending = CHECKS.length;

    CHECKS.forEach(function (c) {
      fetch(c.file, { cache: "no-store" })
        .then(function (r) { return r.ok ? r.text() : null; })
        .then(function (src) {
          var a = norm(embedded(c.key));
          var b = norm(src ? c.scope(src) : null);
          results.push({
            label: c.label,
            state: (a && b) ? (a === b ? "ok" : "drift") : "unknown"
          });
        })
        .catch(function () { results.push({ label: c.label, state: "unknown" }); })
        .then(function () { if (--pending === 0) report(results); });
    });
  }

  function report(results) {
    var bad = results.filter(function (r) { return r.state === "drift"; });
    var text = bad.length
      ? "⚠ 上面 <b>" + bad.map(function (r) { return r.label; }).join("、") +
        "</b> 已经和 <code>library/</code> 里的源文件对不上，以源文件为准。"
      : "页面里这两段原文与 <code>library/</code> 里的源文件逐字一致。";
    render(text);
  }
})();
