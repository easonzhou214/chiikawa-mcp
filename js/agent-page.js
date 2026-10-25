/*
 * 接入页（agent.html）的辅助脚本。
 *
 * 这一页把两段原文抄了进来（服务说明、注入的 agent 正文），好在纯静态站上也
 * 看得到。抄的东西会过期，所以这里读 library/ 里的真文件比一遍，对不上就标出来。
 *
 * 读不到 library/ 时（发布出去的站点就是这样）降级成一句说明，不当错误。
 *
 * 比对的两侧都是纯文本：说明正文在 library/mcp/instructions.txt，
 * 人格在 library/persona/usagi-persona.md。原来说明是写在 server.js 里的
 * 一串字符串字面量，这边只能拿正则去啃源码 —— 排版一动就静默失效。
 */
(function () {
  function $(id) { return document.getElementById(id); }

  // 规范化：去掉注入标记行、去掉拼接续行、折叠空白。比的是内容，不是排版。
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
    return stripWrap(s).replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim() || null;
  }

  // 取页面里那段的文本。可能是 <pre><code>（命令、配置），
  // 也可能是会换行的 <p class="quote">（大段中文），两种都取 textContent。
  function embedded(key) {
    var node = document.querySelector('[data-drift="' + key + '"]');
    if (!node) return null;
    var code = node.querySelector("code");
    return (code || node).textContent;
  }

  var CHECKS = [
    { key: "persona", label: "注入的 agent 正文", file: "library/persona/usagi-persona.md" },
    { key: "instructions", label: "服务握手说明", file: "library/mcp/instructions.txt" }
  ];

  function render(html) { var el = $("a-drift"); if (el) el.innerHTML = html; }

  function load(file) {
    return fetch(file, { cache: "no-store" }).then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
      return r.text();
    });
  }

  Promise.all(CHECKS.map(function (c) {
    return load(c.file)
      .then(function (src) { return { label: c.label, file: c.file, src: src, page: embedded(c.key) }; })
      .catch(function () { return { label: c.label, file: c.file, src: null, page: embedded(c.key) }; });
  })).then(function (rows) {
    // 一个文件都读不到 —— 这是发布出去的站点，不是错误
    if (!rows.some(function (r) { return r.src != null; })) {
      render("这一页读不到 <code>library/</code>，没法自动核对——发布出去的站点本来就不带这个目录。" +
        "页面里那两段原文只是快照，以仓库里的文件为准。");
      return;
    }

    var drift = [], unknown = [], ok = 0;
    rows.forEach(function (r) {
      var a = norm(r.page), b = norm(r.src);
      if (!a || !b) { unknown.push(r.label); return; }   // 缺一边就是没核对，不能算过
      if (a === b) ok++; else drift.push(r.label);
    });

    /* 三种结论分开说。以前只有「对不上」和「一致」两句，
       核对不了的那些（文件没读到、页面上找不到那段）落进 unknown 后没人处理，
       于是页面照样显示「逐字一致」—— 把没验证当成验证通过，比不检查更糟。 */
    var parts = [];
    if (drift.length) {
      parts.push("⚠ 上面 <b>" + drift.join("、") + "</b> 已经和 <code>library/</code> 里的源文件对不上，以源文件为准。");
    }
    if (unknown.length) {
      parts.push("有 <b>" + unknown.join("、") + "</b> 没能核对（页面里没有对应段落，或源文件读不到）。");
    }
    if (!drift.length && !unknown.length) {
      parts.push("页面里这两段原文与 <code>library/</code> 里的源文件逐字一致。");
    } else if (ok) {
      parts.push("另外 " + ok + " 段已核对一致。");
    }
    render(parts.join(" "));
  });
})();
