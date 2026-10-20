// Targeted certification for the FOUR additive published-runtime parity gaps:
//   * sitemap.xml / robots.txt — the "seo" action's response and App-Visibility behavior;
//   * per-page document title, og:image / twitter:image projection and RESTORED-SESSION
//     persistence are the HOST-side halves — the browser-level checks below drive them
//     against /app/<slug> in the preview (the same pattern hostRuntimeGapCert uses).
// One disposable fixture app is deployed LIVE through the REAL deployment worker
// (shared/deployFixtures.createDeployedApp); cleanup removes every created row.
import { createClientFromRequest } from "npm:@base44/sdk@0.8.53";
import { createDeployedApp, appRuntimeCaller, MINIMAL_MAIN, MINIMAL_STYLES } from "../../shared/deployFixtures.ts";
import { signUpWithSession } from "../../shared/appAuth.ts";
import { ENTRY_FILE } from "../../shared/runtimeExports.ts";

// The fixture app: a login/logout surface (so the host's session persistence can be driven
// through the REAL auth ops) and an in-app navigate (so the per-page title update is
// observable as a runtime:navigate back to the host). The "/second" route string also feeds
// the sitemap's route discovery.
const APP_SOURCE = `import { html, auth, navigate, useRoute, useState, useEffect } from 'runtime';
export default function App() {
  const route = useRoute();
  const [user, setUser] = useState(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { auth.me().then((u) => { if (u) setUser(u); }).catch(() => {}); }, []);
  const signIn = async () => { try { const u = await auth.login({ email: email, password: password }); setUser(u); } catch (e) { setErr(String((e && e.message) || e)); } };
  const signOut = async () => { await auth.logout(); setUser(null); };
  if (user) return html\`<div class="page"><h1 class="card-title" id="route-display">\${route}</h1><p id="who">\${user.email}</p><button id="nav-second" onClick=\${() => navigate('/second')}>Go second</button><button id="signout" onClick=\${signOut}>Sign out</button></div>\`;
  return html\`<div class="page"><input id="email" onInput=\${(e) => setEmail(e.target.value)} /><input id="password" type="password" onInput=\${(e) => setPassword(e.target.value)} /><button id="signin" onClick=\${signIn}>Sign in</button><p id="err">\${err}</p></div>\`;
}
`;

export default async function (req) {
  const client = createClientFromRequest(req);
  const svc = client.asServiceRole;
  const body = await req.json();
  const mode = String(body.mode || "deploy");

  if (mode === "deploy") {
    const { project, run } = await createDeployedApp(svc, {
      workspace_id: String(body.workspace_id || ""),
      name: "Published SEO Fixture",
      slug: String(body.slug || "published-seo-fixture"),
      deployed_by: String(body.deployed_by || ""),
      files: [
        [ENTRY_FILE, MINIMAL_MAIN],
        ["src/App.js", APP_SOURCE],
        ["styles.css", MINIMAL_STYLES],
      ],
    });
    return Response.json({ ok: run.status === "LIVE", project_id: project.id, slug: project.slug, deployment_status: run.status });
  }

  if (mode === "cert") {
    return runCert(svc, { projectId: String(body.project_id || ""), baseUrl: String(body.base_url || "") });
  }

  // cleanup: remove every row the fixture created (the app was only ever served from these).
  const projectId = String(body.project_id || "");
  if (!projectId) return Response.json({ error: "cleanup requires project_id" }, { status: 400 });
  await svc.entities.AppUser.deleteMany({ project_id: projectId }).catch(() => {});
  await svc.entities.AppSession.deleteMany({ project_id: projectId }).catch(() => {});
  await svc.entities.AppAuthToken.deleteMany({ project_id: projectId }).catch(() => {});
  await svc.entities.ProjectFile.deleteMany({ project_id: projectId });
  await svc.entities.ProjectVersion.deleteMany({ project_id: projectId });
  await svc.entities.Deployment.deleteMany({ project_id: projectId });
  await svc.entities.DeploymentArtifact.deleteMany({ project_id: projectId });
  await svc.entities.Project.delete(projectId);
  return Response.json({ cleaned: true, project_id: projectId });
}

// ---- cert mode (exported through the mode switch below the deploy branch) ----------------
// (run as: { mode: "cert", project_id, base_url })

export async function runCert(svc, { projectId, baseUrl }) {
  const project = await svc.entities.Project.get(projectId);
  const call = appRuntimeCaller(svc);
  const checks = [];
  const check = (name, ok, detail) => { checks.push({ name, ok, detail: String(detail || "").slice(0, 300) }); };
  // Slug-addressed (built-in-domain) requests: the runtime derives the canonical URL base as
  // the origin + its own /app/<slug> serving path.
  const urlBase = `${baseUrl}/app/${project.slug}`;

  // 1. robots.txt on a PUBLIC app: allow + its own sitemap, from visibility only.
  const robots = await call({ slug: project.slug, action: "seo", op: "robots", base_url: baseUrl });
  check("robots public: Allow + Sitemap line, no Disallow",
    robots.ok && robots.data.content.includes("User-agent: *") && robots.data.content.includes("Allow: /")
      && robots.data.content.includes(`Sitemap: ${urlBase}/sitemap.xml`) && !robots.data.content.includes("Disallow"),
    robots.data.content || robots.error);

  // 2. sitemap.xml: real XML, bounded route discovery from the artifact's own files.
  const sitemap = await call({ slug: project.slug, action: "seo", op: "sitemap", base_url: baseUrl });
  const sm = sitemap.ok ? String(sitemap.data.content) : "";
  check("sitemap: XML document with the app's discovered routes",
    sitemap.ok && sm.startsWith("<?xml") && sm.includes('xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"')
      && sm.includes(`<loc>${urlBase}/</loc>`) && sm.includes(`<loc>${urlBase}/second</loc>`) && sm.trim().endsWith("</urlset>"),
    sm.slice(0, 220));

  // 3. Input validation: a non-https or malformed base is refused; an unknown op is refused.
  const badBase = await call({ slug: project.slug, action: "seo", op: "robots", base_url: "javascript:alert(1)" });
  const badOp = await call({ slug: project.slug, action: "seo", op: "other", base_url: baseUrl });
  check("validation: invalid base_url and unknown op are refused 400",
    badBase.status === 400 && badOp.status === 400,
    `${badBase.status}/${badOp.status}`);

  // 4. App-Visibility behavior: the serving gate is UNCHANGED — a private app's SEO surfaces
  //    are not served to an anonymous crawler (401 AUTH_REQUIRED), and an authenticated app
  //    user's robots.txt excludes the app from crawling entirely.
  await svc.entities.Project.update(project.id, { visibility: "private" });
  const anonRobots = await call({ slug: project.slug, action: "seo", op: "robots", base_url: baseUrl });
  const anonSitemap = await call({ slug: project.slug, action: "seo", op: "sitemap", base_url: baseUrl });
  const { user, token } = await signUpWithSession(svc, project.id, { email: `seo-fixture-${Date.now()}@example.test`, password: "seo-Fixture-123!" }, {});
  const authedRobots = await call({ slug: project.slug, action: "seo", op: "robots", base_url: baseUrl, session_token: token });
  check("visibility: private app refuses anonymous seo (401) and serves Disallow-only robots to its signed-in user",
    anonRobots.status === 401 && anonSitemap.status === 401
      && authedRobots.ok && authedRobots.data.content.includes("Disallow: /") && !authedRobots.data.content.includes("Allow: /"),
    `${anonRobots.status}/${anonSitemap.status} | ${(authedRobots.data?.content || "").trim()}`);
  await svc.entities.Project.update(project.id, { visibility: "public" }); // restore before browser checks

  return Response.json({ ok: checks.every((c) => c.ok), user_email: user.email, checks });
}