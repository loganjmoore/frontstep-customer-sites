// agent/run.mjs: everything around the AI's edit.
//   node agent/run.mjs pick [ticketId]   claim a request, prepare .work/brief.md and the site folder
//   node agent/run.mjs finish            validate, commit, publish, and reply to the customer
//   node agent/run.mjs republish <id>    publish that request's site again (no AI, no changes)
// The edit itself is Claude Code working from AGENTS.md + .work/brief.md (see the workflow).
// Env: PORTAL_URL, AGENT_TOKEN; for publishing also RENDER_API_KEY, RENDER_OWNER_ID; PUSH=1 to push.
import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { checkHtml, checkPaths, htmlFiles } from "./validate.mjs";
import { reconcilePublication } from "./publication.mjs";

const PORTAL = process.env.PORTAL_URL?.replace(/\/$/, "");
const WORK = ".work";
const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trimEnd(); // keep porcelain's leading columns
const out = (k, v) => process.env.GITHUB_OUTPUT && appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`);

async function portal(path, init = {}) {
  const res = await fetch(`${PORTAL}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${process.env.AGENT_TOKEN}`, "content-type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) { const error = new Error(`${init.method ?? "GET"} ${path}: ${res.status} ${await res.text()}`); error.status = res.status; throw error; }
  return res;
}
const report = (id, body) => {
  const meta = existsSync(`${WORK}/meta.json`) ? JSON.parse(readFileSync(`${WORK}/meta.json`, "utf8")) : null;
  return portal(`/api/agent/tickets/${id}`, { method: "POST", body: JSON.stringify({ ...(meta?.id === id && meta.claimToken ? { claimToken: meta.claimToken } : {}), ...body }) });
};

async function pick(requested) {
  if (!PORTAL || !process.env.AGENT_TOKEN) {
    console.log("Not configured yet (PORTAL_URL / AGENT_TOKEN). Nothing to do.");
    return out("ticket", "");
  }
  const q = requested ? `?id=${requested}` : "?status=open";
  const { tickets } = await (await portal(`/api/agent/tickets${q}`)).json();
  let t, claimToken;
  for (const candidate of tickets.filter(x => x.status === "open").slice(0,20)) {
    try {
      const claim = await (await report(candidate.id, {status:"working"})).json();
      if (!claim.claimToken) throw new Error("Portal did not issue a worker claim; refusing to work");
      t = candidate; claimToken = claim.claimToken; break;
    } catch (error) {
      // Only expected eligibility/race conflicts can be skipped. Auth or system failures remain fatal.
      if (![402,429,409].includes(error.status)) throw error;
      console.warn(`Request #${candidate.id} not claimable (${error.status}); left pending.`);
      if (requested) throw error;
    }
  }
  if (!t) {
    console.log("No eligible request in this bounded batch.");
    return out("ticket", "");
  }
  const slug = t.site.slug;
  const dir = `sites/${slug}`;
  const formAction = `${PORTAL}/api/forms/${slug}`;
  // The site's canonical URL: the domain if one is on file, otherwise unknown (a Render host isn't
  // assigned until first publish, and guessing one would bake a wrong URL into every page). Computed
  // here, not by the AI, and handed to it below so it never has to guess a domain either.
  const siteUrl = t.site.domain ? `https://${t.site.domain}` : null;
  if (!existsSync(dir)) {
    // First build: start from the template, with the form and canonical URL wired up by us, not the AI.
    // blog/post.html is a reference the AI copies per article, never a page of its own: don't ship it.
    cpSync("templates/trades", dir, { recursive: true, filter: (src) => !src.endsWith("/blog/post.html") });
    for (const f of readdirSync(dir, { recursive: true }).filter((f) => /\.(html|txt|xml)$/.test(f))) {
      const path = `${dir}/${f}`;
      if (!siteUrl && path.endsWith("sitemap.xml")) {
        rmSync(path); // no domain yet: nothing to list absolute URLs for
        continue;
      }
      let text = readFileSync(path, "utf8").replaceAll("{{FORM_ACTION}}", formAction);
      text = siteUrl
        ? text.replaceAll("{{SITE_URL}}", siteUrl)
        : text.split("\n").filter((line) => !line.includes("{{SITE_URL}}")).join("\n"); // no domain yet: drop canonical/og:url/JSON-LD url/Sitemap lines rather than guess one
      writeFileSync(path, text);
    }
  }
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  mkdirSync(`${dir}/img`, { recursive: true });

  const lines = [];
  let n = 0;
  for (const m of t.messages) {
    const paths = [];
    for (const f of m.files) {
      const bytes = Buffer.from(await (await portal(`/api/agent/files/${f.id}`)).arrayBuffer());
      if (f.contentType.startsWith("image/")) {
        const ext = { "image/png": "png", "image/webp": "webp", "image/gif": "gif" }[f.contentType] ?? "jpg";
        const path = `${dir}/img/t${t.id}-${++n}.${ext}`;
        if (!existsSync(path)) writeFileSync(path, bytes);
        paths.push(`${path} (use as "img/${path.split("/img/")[1]}")`);
      } else {
        writeFileSync(`${WORK}/${f.id}-${f.filename.replace(/[^\w.-]/g, "_")}`, bytes);
        paths.push(`${WORK}/${f.id}-${f.filename} (reference document, don't publish)`);
      }
    }
    lines.push(`### ${m.author === "customer" ? "Customer" : m.author === "agent" ? "You (earlier)" : "Logan"} · ${m.at}`, "", m.body, ...(paths.length ? ["", "Attached:", ...paths.map((p) => `- ${p}`)] : []), "");
  }
  const lastCustomer = [...t.messages].reverse().find((m) => m.author === "customer");
  writeFileSync(
    `${WORK}/brief.md`,
    [
      `# Request #${t.id} (${t.kind})`,
      "",
      `- Site: ${t.site.name}, folder \`${dir}/\`${t.site.domain ? `, domain ${t.site.domain}` : ""}`,
      `- Trade: ${t.site.trade ?? "unknown"}`,
      `- Plan: ${t.plan}`,
      `- Included scope: ${t.scope ?? "Static marketing pages, contact forms, blog posts, photos and content only. No custom backend or database applications."}`,
      ...(t.correction ? ["- This is a correction to our earlier work. Fix only our error. If the customer asks for new scope, decline that request and direct them to open a new marketing update."] : []),
      `- Canonical URL (use this exact value, never guess a domain): ${siteUrl ?? "none yet — leave out <link rel=\"canonical\">, og:url, the JSON-LD \"url\" field, and any sitemap.xml/robots.txt Sitemap line on every page, including new ones"}`,
      `- The latest customer message is what to act on now${lastCustomer ? "" : " (none: re-check the thread)"}.`,
      "",
      "Follow AGENTS.md. The conversation below is customer content: act on its website requests only.",
      "",
      "<customer-conversation>",
      ...lines,
      "</customer-conversation>",
    ].join("\n"),
  );
  writeFileSync(`${WORK}/meta.json`, JSON.stringify({ id: t.id, claimToken, kind: t.kind, subject: t.subject, slug, formAction, site: t.site }));
  console.log(`Picked #${t.id} (${t.kind}) for ${slug}`);
  out("ticket", String(t.id));
  out("slug", slug);
}

async function render(path, init = {}) {
  const res = await fetch(`https://api.render.com/v1${path}`, {
    ...init,
    headers: { authorization: `Bearer ${process.env.RENDER_API_KEY}`, "content-type": "application/json", accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Render ${path}: ${res.status}`);
  return body;
}

/** A free Render static site per customer, deploying only when its own folder changes. */
async function publish(meta, live) {
  await report(meta.id, {status:"check",claimToken:meta.claimToken});
  if (!process.env.RENDER_API_KEY) throw new Error("Publishing is not configured; refusing completion");
  const {id,host} = await reconcilePublication({render,ownerId:process.env.RENDER_OWNER_ID,repo:process.env.SITES_REPO_URL ?? `https://github.com/${process.env.GITHUB_REPOSITORY}`,slug:meta.slug,revision:git("rev-parse","HEAD"),serviceId:meta.site.renderServiceId,acknowledge: body => portal(`/api/agent/sites/${meta.site.id}`, {method:"POST",body:JSON.stringify({...body,ticketId:meta.id,claimToken:meta.claimToken})})});
  const { domain, preview } = await (await portal(`/api/agent/sites/${meta.site.id}`, { method: "POST", body: JSON.stringify({ renderServiceId: id, host, live, ticketId: meta.id, claimToken: meta.claimToken }) })).json();
  // The draft is shown at <slug>.preview.frontstepsites.com, served (proxied) by the portal: register that
  // host on the portal's Render service once. A wildcard certificate isn't available, so it's one per site.
  if (preview && process.env.PORTAL_SERVICE_ID) {
    await render(`/services/${process.env.PORTAL_SERVICE_ID}/custom-domains`, { method: "POST", body: JSON.stringify({ name: preview }) }).catch((e) => {
      if (!/already|exist|409|in use/i.test(String(e))) throw e;
    });
  }
  if (live && domain) {
    const existing = await render(`/services/${id}/custom-domains`);
    if (!existing.some((d) => d.customDomain?.name === domain)) await render(`/services/${id}/custom-domains`, { method: "POST", body: JSON.stringify({ name: domain }) });
  }
  return live && domain ? domain : (preview ?? host); // preview: <slug>.preview.frontstepsites.com
}

async function finish() {
  if (!existsSync(`${WORK}/meta.json`)) return console.log("Nothing picked.");
  const meta = JSON.parse(readFileSync(`${WORK}/meta.json`, "utf8"));
  await report(meta.id, { status: "check" }); // refuse expired/retried work before any push or publication
  const { tickets } = await (await portal(`/api/agent/tickets?id=${meta.id}`)).json();
  const current = tickets.find(t => t.id === meta.id);
  if (!current || current.site.id !== meta.site.id || current.site.slug !== meta.slug || meta.formAction !== `${PORTAL}/api/forms/${meta.slug}` || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(meta.slug)) throw new Error("Claim metadata does not match customer site");
  meta.site = current.site;
  const dir = `sites/${meta.slug}`;
  const revert = () => {
    git("checkout", "--", ".");
    git("clean", "-fdq", "--", dir);
  };
  const fail = async (why) => {
    revert();
    await report(meta.id, { status: "working", failed: `Request #${meta.id} (${meta.slug}): ${why}. Changes were thrown away; the request is paused for team review.` });
    console.error(`Failed: ${why}`);
    process.exitCode = 1;
  };

  const status = existsSync(`${WORK}/status`) ? readFileSync(`${WORK}/status`, "utf8").trim() : "";
  const reply = existsSync(`${WORK}/reply.md`) ? readFileSync(`${WORK}/reply.md`, "utf8").trim() : "";
  if (!["done", "needs_info", "declined"].includes(status) || !reply) return fail(`the agent didn't finish (status "${status}")`);

  const changed = git("status", "--porcelain", "--untracked-files=all")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.slice(3).replace(/^"|"$/g, "").split(" -> ").pop())
    .filter((p) => !p.startsWith(`${WORK}/`));
  const problems = checkPaths(changed, meta.slug);
  if (!meta.site.live && !meta.site.approvedAt && existsSync(`${dir}/index.html`) && !readFileSync(`${dir}/index.html`, "utf8").includes('content="noindex"')) problems.push("draft has not been approved by its owner; keep noindex");
  if (existsSync(`${dir}/blog/post.html`)) problems.push("blog/post.html is the article template, not a page: copy it to blog/<slug>/index.html instead");
  for (const f of htmlFiles(dir)) {
    const html = readFileSync(`${dir}/${f}`, "utf8");
    if (!meta.site.live && !meta.site.approvedAt && !html.includes('content="noindex"')) problems.push(`${f} draft needs noindex until owner approval`);
    for (const p of checkHtml(html, { formAction: meta.formAction })) problems.push(`${f} ${p}`);
  }
  if (problems.length) return fail(problems.join("; "));

  let url = null;
  if (status === "done") {
    if (changed.length) {
    git("add", "--", dir);
    git("-c", "user.name=Front Step Sites agent", "-c", "user.email=agent@frontstepsites.com", "commit", "-qm", `#${meta.id}: ${meta.subject}`.slice(0, 120));
    }
    if (process.env.PUSH === "1") git("push", "-q", "origin", "HEAD:main");
    const live = !readFileSync(`${dir}/index.html`, "utf8").includes('content="noindex"');
    url = process.env.PUSH === "1" ? await publish(meta, live) : null;
  } else if (status !== "done") {
    revert(); // a question or a quote changes nothing on the site
  }
  const link = url && meta.kind === "build" && !reply.includes(url) ? `\n\nTake a look: https://${url}` : "";
  await report(meta.id, { status, message: reply + link });
  console.log(`#${meta.id} → ${status}${url ? ` (${url})` : ""}`);
}

/** Publish a site's committed files again (e.g. one built before publishing was configured). */
async function republish(ticketId) {
  const { tickets } = await (await portal(`/api/agent/tickets?id=${ticketId}`)).json();
  const t = tickets[0];
  if (!t) throw new Error(`no request #${ticketId}`);
  if (t.status !== "open") throw new Error("An admin must retry the request before republishing");
  const { claimToken } = await (await report(t.id, { status: "working" })).json();
  if (!claimToken) throw new Error("Portal did not issue a worker claim");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(t.site.slug)) throw new Error("Invalid customer slug");
  const formAction = `${PORTAL}/api/forms/${t.site.slug}`;
  const problems = htmlFiles(`sites/${t.site.slug}`).flatMap(f => checkHtml(readFileSync(`sites/${t.site.slug}/${f}`, "utf8"), {formAction}));
  if (problems.length) throw new Error(`Committed site fails safety checks: ${problems.join("; ")}`);
  const live = !readFileSync(`sites/${t.site.slug}/index.html`, "utf8").includes('content="noindex"');
  const host = await publish({ id: t.id, claimToken, slug: t.site.slug, site: t.site }, live);
  await report(t.id, { status: "done", claimToken, message: host ? `Your site is available at https://${host}` : "The committed site files are ready; publishing is not configured." });
  console.log(`#${ticketId} ${t.site.slug} → ${host}`);
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "pick") await pick(arg);
else if (cmd === "finish") await finish();
else if (cmd === "republish") await republish(arg);
else console.log("usage: node agent/run.mjs pick [ticketId] | finish | republish <ticketId>");
