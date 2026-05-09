"use client";
import type { Position } from '../lib/types';

type Props = {
  position: Position;
};

export function LtvBar({ position }: Props) {
  const ltv = Math.min(Math.max(position.ltv, 0), 1);
  const injectPct = position.injectThreshold * 100;
  const withdrawPct = position.withdrawThreshold * 100;
  const liquidationPct = position.liquidationThreshold * 100;
  const ltvPct = ltv * 100;

  let fillColor = 'var(--accent)';
  if (position.status === 'injected') fillColor = 'var(--accent)';
  else if (ltv >= position.liquidationThreshold) fillColor = 'var(--danger)';
  else if (ltv >= position.injectThreshold) fillColor = 'var(--warning)';

  return (
    <div className="ltv-bar">
      <style>{`
        .ltv-bar {
          width: 100%;
        }
        .ltv-bar-header {
          display: flex;
          justify-content: space-between;
          margin-bottom: 12px;
          font-size: 13px;
          color: var(--fg-muted);
        }
        .ltv-bar-track {
          position: relative;
          height: 14px;
          background: var(--surface-2);
          border-radius: 999px;
          overflow: visible;
          border: 1px solid var(--border);
        }
        .ltv-bar-fill {
          position: absolute;
          top: 0;
          left: 0;
          height: 100%;
          border-radius: 999px;
          transition: width 800ms cubic-bezier(0.22, 1, 0.36, 1), background 400ms ease;
        }
        .ltv-bar-fill.injected {
          animation: ltv-pulse 2s ease-in-out infinite;
        }
        @keyframes ltv-pulse {
          0%, 100% { box-shadow: 0 0 0 0 var(--accent-soft); }
          50% { box-shadow: 0 0 0 6px transparent; }
        }
        .ltv-bar-marker {
          position: absolute;
          top: -4px;
          height: 22px;
          width: 2px;
          background: var(--fg-dim);
          opacity: 0.6;
        }
        .ltv-bar-marker.inject { background: var(--warning); opacity: 0.9; }
        .ltv-bar-marker.withdraw { background: var(--accent); opacity: 0.4; }
        .ltv-bar-marker.liquidation { background: var(--danger); opacity: 0.9; }
        .ltv-bar-marker-label {
          position: absolute;
          top: 24px;
          font-size: 10px;
          font-family: var(--font-mono);
          color: var(--fg-muted);
          white-space: nowrap;
          transform: translateX(-50%);
          letter-spacing: 0.04em;
          text-transform: uppercase;
        }
        .ltv-bar-current {
          position: absolute;
          top: -28px;
          font-family: var(--font-mono);
          font-size: 12px;
          color: var(--fg);
          background: var(--surface);
          padding: 2px 6px;
          border-radius: 4px;
          border: 1px solid var(--border-strong);
          transform: translateX(-50%);
          transition: left 800ms cubic-bezier(0.22, 1, 0.36, 1);
          white-space: nowrap;
        }
      `}</style>

      <div className="ltv-bar-header">
        <span>Loan-to-Value</span>
        <span style={{ fontFamily: 'var(--font-mono)' }}>
          Max: {(position.maxLTV * 100).toFixed(1)}%
        </span>
      </div>

      <div className="ltv-bar-track">
        <div className="ltv-bar-current" style={{ left: `${ltvPct}%` }}>
          {ltvPct.toFixed(1)}%
        </div>
        <div
          className={`ltv-bar-fill ${position.status === 'injected' ? 'injected' : ''}`}
          style={{ width: `${ltvPct}%`, background: fillColor }}
        />
        <div className="ltv-bar-marker withdraw" style={{ left: `${withdrawPct}%` }}>
          <span className="ltv-bar-marker-label">withdraw</span>
        </div>
        <div className="ltv-bar-marker inject" style={{ left: `${injectPct}%` }}>
          <span className="ltv-bar-marker-label">inject</span>
        </div>
        <div className="ltv-bar-marker liquidation" style={{ left: `${liquidationPct}%` }}>
          <span className="ltv-bar-marker-label">liquidation</span>
        </div>
      </div>
    </div>
  );
}
