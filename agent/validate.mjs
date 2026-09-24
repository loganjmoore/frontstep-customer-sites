// The gate between what the AI wrote and a live customer website.
// Anything that fails here is reverted and Logan gets an alert; nothing half-checked ships.

const ALLOWED_SCRIPT = /<script data-fss="form-status">[\s\S]*?<\/script>|<script type="application\/ld\+json">[\s\S]*?<\/script>/g;

/** Problems with one HTML file, as plain sentences. Empty array = OK. */
export function checkHtml(html, { formAction }) {
  const problems = [];
  const stripped = html.replace(ALLOWED_SCRIPT, "");
  if (/<script\b/i.test(stripped)) problems.push("has a <script> tag that isn't one of the two allowed ones");
  if (/\son[a-z]+\s*=/i.test(stripped)) problems.push("has an inline event handler (onclick= etc.)");
  if (/javascript:/i.test(html)) problems.push("has a javascript: URL");
  for (const m of html.matchAll(/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)/gi)) {
    if (!m[1].startsWith("https://www.google.com/maps/embed")) problems.push(`has a non-map iframe (${m[1]})`);
  }
  if (/<(object|embed)\b/i.test(html)) problems.push("has an <object>/<embed>");
  if (/<meta[^>]+http-equiv\s*=\s*["']?refresh/i.test(html)) problems.push("has a meta refresh redirect");
  for (const m of html.matchAll(/<link\b[^>]*rel\s*=\s*["']?stylesheet[^>]*>/gi)) {
    const href = m[0].match(/href\s*=\s*["']([^"']+)/i)?.[1] ?? "";
    if (href.startsWith("http") && !href.startsWith("https://fonts.googleapis.com/")) problems.push(`loads an outside stylesheet (${href})`);
  }
  for (const m of html.matchAll(/<form\b[^>]*>/gi)) {
    const action = m[0].match(/action\s*=\s*["']([^"']*)/i)?.[1] ?? "";
    if (action !== formAction) problems.push(`form posts somewhere else (${action || "nowhere"})`);
  }
  if (/<form\b/i.test(html) && !/name=["']website["']/.test(html)) problems.push("contact form lost its spam trap field");
  if (!/Site by <a href="https:\/\/frontstepsites\.com/.test(html)) problems.push('footer lost "Site by Front Step Sites"');
  if (/\{\{[A-Z0-9_]+\}\}/.test(html)) problems.push("still has unfilled {{PLACEHOLDERS}}");
  if (/—/.test(html.replace(/<!--[\s\S]*?-->/g, ""))) problems.push("uses an em dash");
  if (html.length > 400_000) problems.push("is over 400 KB");
  return problems;
}

/** Changed paths must all sit inside the request's own site folder. */
export function checkPaths(paths, slug) {
  return paths.filter((p) => !p.startsWith(`sites/${slug}/`)).map((p) => `changed a file outside the site: ${p}`);
}
