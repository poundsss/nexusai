import React from "react";
import { FileCode, Lock, Database, FileText } from "lucide-react";

function group(files) {
  const g = { Pages: [], Components: [], Functions: [], Integrations: [], Files: [] };
  for (const f of files) {
    if (f.path.startsWith("src/pages/")) g.Pages.push(f);
    else if (f.path.startsWith("src/components/")) g.Components.push(f);
    else if (f.path.startsWith("functions/")) g.Functions.push(f);
    else if (f.path.startsWith("integrations/")) g.Integrations.push(f);
    else g.Files.push(f);
  }
  return g;
}

export default function FileTree({ files, entities, selected, onSelect, onSelectEntity }) {
  const groups = group(files);
  const Section = ({ title, children, count }) => (
    <div className="mb-3">
      <div className="px-3 mb-1 flex items-center justify-between text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/60"><span>{title}</span><span className="font-mono">{count}</span></div>
      {children}
    </div>
  );
  const Row = ({ file }) => (
    <button onClick={() => onSelect(file.path)} className={`w-full flex items-center gap-2 px-3 py-1 text-left truncate transition-colors ${selected === file.path ? "bg-primary text-primary-foreground" : "text-foreground hover:bg-muted"}`}>
      {file.path.endsWith(".js") ? <FileCode className="h-3.5 w-3.5 shrink-0 opacity-60" /> : <FileText className="h-3.5 w-3.5 shrink-0 opacity-60" />}
      <span className="truncate font-mono text-[12px]">{file.path.replace(/^(src\/(pages|components)|functions|integrations)\//, "")}</span>
      {file.frozen && <Lock className="h-3 w-3 ml-auto shrink-0 opacity-70" title="Frozen" />}
    </button>
  );
  return (
    <div className="h-full overflow-y-auto py-3 text-[13px]">
      {["Pages", "Components"].map((k) => (
        <Section key={k} title={k} count={groups[k].length}>
          {groups[k].length === 0 && <div className="px-3 text-[12px] text-muted-foreground/60">None yet</div>}
          {groups[k].map((f) => <Row key={f.path} file={f} />)}
        </Section>
      ))}
      <Section title="Entities" count={entities.length}>
        {entities.length === 0 && <div className="px-3 text-[12px] text-muted-foreground/60">No entities yet</div>}
        {entities.map((e) => (
          <button key={e.id} onClick={() => onSelectEntity(e.name)} className="w-full flex items-center gap-2 px-3 py-1 text-left text-foreground hover:bg-muted transition-colors">
            <Database className="h-3.5 w-3.5 shrink-0 opacity-60" /><span className="font-mono text-[12px]">{e.name}</span>
            <span className="ml-auto text-[10px] text-muted-foreground/60">{Object.keys(e.fields || {}).length} fields</span>
          </button>
        ))}
      </Section>
      {["Functions", "Integrations"].map((k) => groups[k].length > 0 && (
        <Section key={k} title={k} count={groups[k].length}>{groups[k].map((f) => <Row key={f.path} file={f} />)}</Section>
      ))}
      <Section title="Files" count={groups.Files.length}>{groups.Files.map((f) => <Row key={f.path} file={f} />)}</Section>
    </div>
  );
}