/*
 * 导航高亮：把当前页面对应的那个导航项点亮。
 *
 * 为什么单独一个文件：这段逻辑原来在 app.js 里，而 app.js 只被需要剧情数据的
 * 页面引入（它后面挂着 11 个数据文件、约 300KB）。接入页这类纯文档页没有数据，
 * 不引 app.js，导航就不高亮 —— 之前就漏成这样了。
 * 单独拆出来之后，任何页面引这一行就有高亮，代价是 300 字节。
 */
(function () {
  function current() {
    // 去掉查询串与 hash，只看文件名；目录根（/ 或 .../index.html）都算首页
    var p = location.pathname;
    var file = p.split("/").pop();
    return (!file || file === "") ? "index.html" : file;
  }
  var here = current();
  var links = document.querySelectorAll(".nav-links a");
  Array.prototype.forEach.call(links, function (a) {
    if (a.getAttribute("href") === here) a.classList.add("on");
  });
})();
