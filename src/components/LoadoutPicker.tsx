"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type CatalogItem, type Preset } from "@/lib/api";
import { Button, Input } from "./ui";

const KIND_LABEL: Record<string, string> = {
  plugin: "Plugins",
  mcp: "MCP servers",
  skill: "Skills",
  agent: "Agents",
  command: "Commands",
  workflow: "Workflows",
  memory: "Instructions",
};

export function LoadoutPicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [filter, setFilter] = useState("");
  const [presetName, setPresetName] = useState("");
  const [mcpOpen, setMcpOpen] = useState(false);

  const load = () => {
    api<CatalogItem[]>("/api/catalog").then(setCatalog);
    api<Preset[]>("/api/presets").then(setPresets);
  };
  useEffect(load, []);

  const selected = new Set(value);
  const groups = useMemo(() => {
    const f = filter.toLowerCase();
    const m = new Map<string, CatalogItem[]>();
    for (const i of catalog) {
      if (f && !`${i.name} ${i.description ?? ""}`.toLowerCase().includes(f)) continue;
      m.set(i.kind, [...(m.get(i.kind) ?? []), i]);
    }
    return [...m.entries()];
  }, [catalog, filter]);

  const toggle = (id: string) => onChange(selected.has(id) ? value.filter((v) => v !== id) : [...value, id]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center">
        <Input placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} className="flex-1 min-w-40" />
        <select
          className="rounded-md bg-panel-2 border border-line px-2 py-1.5"
          value=""
          onChange={(e) => {
            const p = presets.find((p) => p.id === e.target.value);
            if (p) onChange(p.items);
          }}
        >
          <option value="">Apply preset…</option>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.items.length})
            </option>
          ))}
        </select>
        <Button
          onClick={async () => {
            await api("/api/catalog", { method: "POST", json: { op: "import" } });
            load();
          }}
        >
          Re-import ~/.claude
        </Button>
        <Button onClick={() => setMcpOpen((o) => !o)}>+ MCP server</Button>
      </div>

      {mcpOpen && <AddMcp onDone={() => (setMcpOpen(false), load())} />}

      <div className="text-muted text-xs">
        {value.length} selected ·{" "}
        <button className="underline" onClick={() => onChange([])}>
          clear
        </button>
      </div>

      <div className="space-y-4 max-h-[50vh] overflow-y-auto pr-1">
        {groups.map(([kind, items]) => (
          <div key={kind}>
            <div className="flex items-center justify-between mb-1">
              <h4 className="text-xs uppercase tracking-wide text-muted">{KIND_LABEL[kind] ?? kind}</h4>
              <button
                className="text-xs text-muted hover:text-text"
                onClick={() => {
                  const ids = items.filter((i) => i.remote_ok).map((i) => i.id);
                  const all = ids.every((id) => selected.has(id));
                  onChange(all ? value.filter((v) => !ids.includes(v)) : [...new Set([...value, ...ids])]);
                }}
              >
                toggle all
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
              {items.map((i) => (
                <label
                  key={i.id}
                  className={`flex gap-2 items-start rounded-md px-2 py-1.5 border ${
                    selected.has(i.id) ? "border-accent/60 bg-accent/5" : "border-transparent hover:bg-panel-2"
                  } ${i.remote_ok ? "cursor-pointer" : "opacity-40"}`}
                  title={i.description ?? ""}
                >
                  <input type="checkbox" disabled={!i.remote_ok} checked={selected.has(i.id)} onChange={() => toggle(i.id)} className="mt-0.5 accent-[var(--accent)]" />
                  <span className="min-w-0">
                    <span className="block truncate">{i.name}</span>
                    {i.description && <span className="block text-xs text-muted truncate">{i.description}</span>}
                  </span>
                </label>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="flex gap-2 pt-2 border-t border-line">
        <Input placeholder="Save selection as preset…" value={presetName} onChange={(e) => setPresetName(e.target.value)} className="flex-1" />
        <Button
          disabled={!presetName.trim()}
          onClick={async () => {
            await api("/api/presets", { method: "POST", json: { name: presetName.trim(), items: value } });
            setPresetName("");
            load();
          }}
        >
          Save preset
        </Button>
      </div>
    </div>
  );
}

function AddMcp({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [config, setConfig] = useState('{\n  "type": "http",\n  "url": "https://…"\n}');
  const [err, setErr] = useState("");
  return (
    <div className="rounded-md border border-line p-3 space-y-2 bg-panel-2/40">
      <Input placeholder="name" value={name} onChange={(e) => setName(e.target.value)} className="w-full" />
      <textarea
        value={config}
        onChange={(e) => setConfig(e.target.value)}
        rows={5}
        className="w-full font-mono text-xs rounded-md bg-panel-2 border border-line p-2 outline-none focus:border-accent"
      />
      <p className="text-xs text-muted">Same shape as an entry in .mcp.json. stdio commands run inside the sandbox.</p>
      {err && <p className="text-bad text-xs">{err}</p>}
      <Button
        variant="primary"
        onClick={async () => {
          try {
            await api("/api/catalog", { method: "POST", json: { op: "addMcp", name, config: JSON.parse(config) } });
            onDone();
          } catch (e) {
            setErr(String(e));
          }
        }}
      >
        Add
      </Button>
    </div>
  );
}
