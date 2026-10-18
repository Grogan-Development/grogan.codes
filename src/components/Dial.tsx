"use client";

/**
 * A stepped dial: the arc shows where the value sits between the first and last stop.
 * Drag the slider or use −/+; arrow keys work on the slider.
 */
export function Dial({
  label,
  unit,
  steps,
  value,
  onChange,
  color = "var(--accent)",
}: {
  label: string;
  unit: string;
  steps: number[];
  value: number;
  onChange: (v: number) => void;
  color?: string;
}) {
  const i = Math.max(0, steps.indexOf(value));
  const max = steps.length - 1;
  const pct = Math.round(8 + (i / max) * 92);
  const set = (j: number) => onChange(steps[Math.max(0, Math.min(max, j))]);
  return (
    <div className="flex flex-col items-center gap-0.5 rounded-xl border border-line-2 bg-panel-2 px-2 pt-2.5 pb-2">
      <div className="relative h-[72px] w-[84px]">
        <svg role="img" aria-label={`${label}: ${value} ${unit}`} width="84" height="72" viewBox="0 0 84 72">
          <path d="M 14.6 60.4 A 34 34 0 1 1 69.4 60.4" fill="none" stroke="#2a2d27" strokeWidth="7" strokeLinecap="round" />
          <path
            d="M 14.6 60.4 A 34 34 0 1 1 69.4 60.4"
            fill="none"
            stroke={color}
            strokeWidth="7"
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={`${pct} 100`}
            className="transition-[stroke-dasharray] duration-150"
          />
        </svg>
        <div className="absolute inset-x-0 top-[22px] text-center">
          <div className="font-mono text-lg leading-none font-medium">{value}</div>
          <div className="mt-[3px] text-[10px] text-muted">{unit}</div>
        </div>
      </div>
      <div className="text-xs font-semibold text-text-2">{label}</div>
      <div className="flex w-full items-center gap-0.5">
        <button type="button" aria-label={`Less ${label.toLowerCase()}`} onClick={() => set(i - 1)} className="size-[26px] shrink-0 rounded-md text-sm hover:bg-[#2a2d27]">
          −
        </button>
        <input
          type="range"
          min={0}
          max={max}
          step={1}
          value={i}
          aria-label={label}
          aria-valuetext={`${value} ${unit}`}
          onChange={(e) => set(Number(e.target.value))}
          className="min-w-0 flex-1"
          style={{ accentColor: color }}
        />
        <button type="button" aria-label={`More ${label.toLowerCase()}`} onClick={() => set(i + 1)} className="size-[26px] shrink-0 rounded-md text-sm hover:bg-[#2a2d27]">
          +
        </button>
      </div>
    </div>
  );
}
