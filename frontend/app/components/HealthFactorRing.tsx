"use client";
import type { Position } from '../lib/types';

export function HealthFactorRing({ position }: { position: Position }) {
  const hf = position.liquidationThreshold / Math.max(position.ltv, 0.001);
  const displayHf = Math.min(hf, 9.99);
  const ringPct = Math.max(0, Math.min(1, (hf - 1) / 1));

  let color = 'var(--accent)';
  if (hf < 1.05) color = 'var(--danger)';
  else if (hf < 1.2) color = 'var(--warning)';

  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  const dash = circumference * ringPct;

  return (
    <div className="hf-ring">
      <style>{`
        .hf-ring { display: flex; align-items: center; gap: 16px; }
        .hf-ring-svg { transform: rotate(-90deg); }
        .hf-ring-track { stroke: var(--surface-2); }
        .hf-ring-fill { transition: stroke-dasharray 600ms ease, stroke 400ms ease; }
        .hf-ring-info { display: flex; flex-direction: column; }
        .hf-ring-label {
          font-size: 11px;
          color: var(--fg-muted);
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .hf-ring-value {
          font-family: var(--font-mono);
          font-size: 22px;
          color: var(--fg);
        }
      `}</style>
      <svg width="88" height="88" className="hf-ring-svg">
        <circle cx="44" cy="44" r={radius} strokeWidth="6" fill="none" className="hf-ring-track" />
        <circle
          cx="44"
          cy="44"
          r={radius}
          strokeWidth="6"
          fill="none"
          stroke={color}
          strokeDasharray={`${dash} ${circumference}`}
          strokeLinecap="round"
          className="hf-ring-fill"
        />
      </svg>
      <div className="hf-ring-info">
        <span className="hf-ring-label">Health Factor</span>
        <span className="hf-ring-value">{displayHf.toFixed(2)}</span>
      </div>
    </div>
  );
}
