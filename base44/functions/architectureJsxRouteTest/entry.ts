// Targeted certification of the JSX Route → page binding extraction added to the Architecture
// route pass. Pure, no database: it runs the REAL `deriveArchitecture` against a hand-built fixture
// mirroring a generated React Router entry, and asserts:
//   1. <Route path="/tasks" element={<TodoPage />} /> resolves to the TodoPage page (verified edge),
//   2. the existing string-route '/about' → About page mapping is unchanged (inferred edge),
//   3. unresolved/dynamic JSX bindings (element={handler}, wrapper <Layout>) create the route node
//      but NO renders edge — the target stays unknown rather than being invented.
import { deriveArchitecture } from "../../shared/architectureGraph.ts";

const FIXTURE = {
  project: { version_count: 1 },
  files: [
    {
      path: "src/App.jsx",
      content: [
        "import TodoPage from './pages/TodoPage.jsx';",
        "import About from './pages/About.jsx';",
        "export default function App() {",
        "  return (",
        "    <Router>",
        "      <Route path=\"/tasks\" element={<TodoPage />} />",
        "      <Route path=\"/dynamic/:id\" element={handler} />",
        "      <Route path=\"/nested\" element={<Layout><DeepPage /></Layout>} />",
        "      {'/about'}",
        "    </Router>",
        "  );",
        "}",
      ].join("\n"),
    },
    { path: "src/pages/TodoPage.jsx", content: "export default function TodoPage() { return null; }" },
    { path: "src/pages/About.jsx", content: "export default function About() { return null; }" },
  ],
  entities: [],
};

export default async function () {
  try {
    const graph = deriveArchitecture(FIXTURE);
    const checks = [];

    const edge = (from, rel, to) =>
      graph.edges.find((e) => e.from_node_key === from && e.relationship === rel && e.to_node_key === to);
    const rendersEdges = (route) =>
      graph.edges.filter((e) => e.from_node_key === `route:${route}` && e.relationship === "renders");
    const node = (key) => graph.nodes.find((n) => n.node_key === key);

    // 1. JSX element={<TodoPage />} → renders TodoPage page, verified (explicit binding from file).
    const tasksRenders = edge("route:/tasks", "renders", "page:src/pages/TodoPage.jsx");
    checks.push({
      name: "1. JSX Route element={<TodoPage />} → renders TodoPage page (verified)",
      passed: !!tasksRenders && tasksRenders.provenance_state === "verified",
      detail: tasksRenders ? `state=${tasksRenders.provenance_state}` : "edge missing",
    });

    // 2. existing string-route '/about' → About page mapping unchanged (inferred).
    const aboutRenders = edge("route:/about", "renders", "page:src/pages/About.jsx");
    checks.push({
      name: "2. string route '/about' → renders About (inferred, unchanged)",
      passed: !!aboutRenders && aboutRenders.provenance_state === "inferred",
      detail: aboutRenders ? `state=${aboutRenders.provenance_state}` : "edge missing",
    });

    // 3a. dynamic JSX route element={handler} — route node exists, no renders edge invented.
    const dynamicRenders = rendersEdges("/dynamic/:id");
    checks.push({
      name: "3a. dynamic JSX route '/dynamic/:id' node exists, no invented renders edge",
      passed: !!node("route:/dynamic/:id") && dynamicRenders.length === 0,
      detail: `node=${!!node("route:/dynamic/:id")} renders=${dynamicRenders.length}`,
    });

    // 3b. nested/wrapper JSX route element={<Layout>...} — wrapper not a page, target unknown.
    const nestedRenders = rendersEdges("/nested");
    checks.push({
      name: "3b. wrapper JSX route '/nested' — target unknown, no invented renders edge",
      passed: !!node("route:/nested") && nestedRenders.length === 0,
      detail: `node=${!!node("route:/nested")} renders=${nestedRenders.length}`,
    });

    const failed = checks.filter((c) => !c.passed);
    if (failed.length) return { passed: false, failures: failed, checks, node_count: graph.nodes.length, edge_count: graph.edges.length };
    return { passed: true, checks, node_count: graph.nodes.length, edge_count: graph.edges.length };
  } catch (e) {
    return { passed: false, error: String(e?.message || e), stack: String(e?.stack || "").split("\n").slice(0, 8) };
  }
}
