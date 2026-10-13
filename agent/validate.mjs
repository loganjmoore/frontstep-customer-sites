// The gate between what the AI wrote and a live customer website.
// Anything that fails here is reverted and Logan gets an alert; nothing half-checked ships.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { parse } from "parse5";
import { posix } from "node:path";

const ALLOWED_SCRIPT = /<script data-fss="form-status">[\s\S]*?<\/script>|<script type="application\/ld\+json">[\s\S]*?<\/script>/g;
// The one script that runs on customer sites, byte for byte as the template has it (the AI may not edit it).
const FORM_STATUS = readFileSync(new URL("../templates/trades/index.html", import.meta.url), "utf8").match(/<script data-fss="form-status">[\s\S]*?<\/script>/)[0];

/** WCAG contrast ratio between two #rrggbb colors. */
export function contrast(a, b) {
  const lum = (hex) => {
    const [r, g, bl] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Problems with one HTML file, as plain sentences. Empty array = OK. */
export function checkHtml(html, { formAction }) {
  const problems = [];
  const url = (value) => {
    try { return new URL(value.replace(/[\u0000-\u0020\u007f]/g, ""), "https://site.invalid/"); } catch { return null; }
  };
  // Parse exactly as an HTML browser does: entities, unquoted values, namespaces and templates.
  const visit = (node) => {
    const tag = node.tagName;
    const attrs = Object.fromEntries((node.attrs ?? []).map(a => [a.prefix ? `${a.prefix}:${a.name}` : a.name, a.value]));
    for (const [name, value] of Object.entries(attrs)) {
      if (/^on/i.test(name)) problems.push("has an inline event handler");
      if (["formaction", "formmethod", "formtarget", "srcdoc", "ping"].includes(name)) problems.push(`has forbidden ${name} override`);
      if (["href", "src", "action", "xlink:href", "poster", "background", "data"].includes(name)) {
        const parsed = url(value);
        if (!parsed || !["http:", "https:", "mailto:", "tel:", "sms:"].includes(parsed.protocol)) problems.push("has an unsafe URL");
        if (name !== "href" && name !== "xlink:href" && parsed && !["http:", "https:"].includes(parsed.protocol)) problems.push("has an unsafe resource URL");
      }
    }
    if (tag === "script") {
      const loc = node.sourceCodeLocation;
      const original = loc ? html.slice(loc.startOffset, loc.endOffset) : "";
      if (attrs["data-fss"] === "form-status") {
        if (original !== FORM_STATUS) problems.push("changed the form-status script");
      } else if (node.namespaceURI === "http://www.w3.org/1999/xhtml" && attrs.type === "application/ld+json" && Object.keys(attrs).length === 1) {
        try { JSON.parse((node.childNodes ?? []).map(n => n.value ?? "").join("")); } catch { problems.push("has invalid JSON-LD"); }
      } else problems.push("has a <script> tag that isn't one of the two allowed ones");
    }
    if (["object", "embed", "base", "frame", "frameset", "animate", "set", "foreignObject"].includes(tag)) problems.push(`has a forbidden ${tag} element`);
    if (tag === "meta" && attrs["http-equiv"]?.toLowerCase() === "refresh") problems.push("has a meta refresh redirect");
    if (tag === "iframe") {
      const parsed = url(attrs.src ?? "");
      if (!parsed || parsed.protocol !== "https:" || parsed.hostname !== "www.google.com" || parsed.username || parsed.password || parsed.port || !(parsed.pathname === "/maps/embed" || parsed.pathname.startsWith("/maps/embed/"))) problems.push("has a non-map iframe");
    }
    if (tag === "link" && attrs.rel?.toLowerCase().split(/\s+/).includes("stylesheet")) {
      const parsed = url(attrs.href ?? "");
      if (!parsed || (parsed.origin !== "https://site.invalid" && !(parsed.protocol === "https:" && parsed.hostname === "fonts.googleapis.com" && !parsed.username && !parsed.password && !parsed.port && /^\/css(?:2)?$/.test(parsed.pathname)))) problems.push("loads an outside stylesheet");
    }
    if (tag === "form") {
      if (attrs.action !== formAction || attrs.method?.toLowerCase() !== "post") problems.push(`form posts somewhere else (${attrs.action || "nowhere"})`);
      const hasTrap = (n) => n.tagName === "input" && n.attrs?.some(a => a.name === "name" && a.value === "website") || (n.childNodes ?? []).some(hasTrap);
      if (!hasTrap(node)) problems.push("contact form lost its spam trap field");
    }
    for (const child of node.childNodes ?? []) visit(child);
    if (node.content) visit(node.content);
  };
  // noscript has different browser parse behavior when scripting is disabled.
  for (const scriptingEnabled of [true, false]) visit(parse(html, { sourceCodeLocationInfo: true, scriptingEnabled }));
  const livery = html.match(/--livery:\s*([^;]+);/)?.[1].trim();
  if (livery && !/^#[0-9a-f]{6}$/i.test(livery)) problems.push(`--livery must be a 6-digit hex color (got ${livery})`);
  else if (livery && contrast("#ffffff", livery) < 7) problems.push(`--livery ${livery} is too light: white text on it needs 7:1 (has ${contrast("#ffffff", livery).toFixed(1)}:1)`);
  if (!/Site by <a href="https:\/\/frontstepsites\.com/.test(html)) problems.push('footer lost "Site by Front Step Sites"');
  if (/\{\{[A-Z0-9_]+\}\}/.test(html)) problems.push("still has unfilled {{PLACEHOLDERS}}");
  if (/\u2014/.test(html.replace(/<!--[\s\S]*?-->/g, ""))) problems.push("uses an em dash");
  if (html.length > 400_000) problems.push("is over 400 KB");
  return problems;
}

/** Changed paths must all sit inside the request's own site folder. */
export function checkPaths(paths, slug) {
  return paths.filter((p) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || p.includes("\\") || posix.normalize(p) !== p || !p.startsWith(`sites/${slug}/`)).map((p) => `changed a file outside the site: ${p}`);
}

/** Every .html file under dir, recursively (nested blog pages included). */
export function htmlFiles(dir) {
  return existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((f) => f.endsWith(".html")) : [];
}
