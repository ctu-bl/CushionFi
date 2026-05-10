"use client";
import type { Position } from '../lib/types';

type Props = {
  position: Position;
  original: {
    collateralAmount: number;
    debtAmount: number;
    startPriceUsd: number;
  };
  finalPriceUsd: number;
};

export function LiquidationSummary({ original, finalPriceUsd }: Props) {
  const drawdownPct = ((original.startPriceUsd - finalPriceUsd) / original.startPriceUsd) * 100;
  const closedAt = new Date().toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });

  return (
    <div className="liq-summary">
      <style>{`
        .liq-summary {
          background: var(--surface);
          border: 1px solid var(--accent-border);
          border-radius: 12px;
          padding: 32px;
          position: relative;
          overflow: hidden;
        }
        .liq-summary::before {
          content: "";
          position: absolute;
          inset: 0;
          background: linear-gradient(135deg, var(--accent-soft) 0%, transparent 60%);
          pointer-events: none;
        }
        .liq-summary-header {
          display: flex;
          align-items: baseline;
          gap: 16px;
          flex-wrap: wrap;
          margin-bottom: 24px;
          position: relative;
        }
        .liq-summary-eyebrow {
          font-family: var(--font-mono);
          font-size: 10px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--accent);
          padding: 4px 10px;
          border: 1px solid var(--accent-border);
          background: var(--accent-soft);
          border-radius: 999px;
        }
        .liq-summary-title {
          font-family: var(--font-display);
          font-size: 32px;
          line-height: 1.1;
          color: var(--fg);
          letter-spacing: -0.01em;
        }
        .liq-summary-title em {
          font-style: italic;
          color: var(--accent);
        }
        .liq-summary-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 24px;
          position: relative;
        }
        .liq-summary-stat {
          padding-top: 20px;
          border-top: 1px solid var(--border);
        }
        .liq-summary-stat-label {
          font-size: 11px;
          color: var(--fg-muted);
          text-transform: uppercase;
          letter-spacing: 0.06em;
          margin-bottom: 10px;
        }
        .liq-summary-stat-value {
          font-family: var(--font-mono);
          font-size: 18px;
          color: var(--fg);
          margin-bottom: 6px;
          line-height: 1.3;
        }
        .liq-summary-stat-desc {
          font-size: 12px;
          color: var(--fg-muted);
          line-height: 1.5;
        }
        .liq-summary-footer {
          margin-top: 28px;
          padding: 20px;
          background: var(--bg-elevated);
          border-left: 2px solid var(--accent);
          border-radius: 4px;
          position: relative;
        }
        .liq-summary-footer-label {
          font-family: var(--font-mono);
          font-size: 11px;
          color: var(--accent);
          text-transform: uppercase;
          letter-spacing: 0.08em;
          margin-bottom: 6px;
        }
        .liq-summary-footer-text {
          font-size: 14px;
          color: var(--fg);
          line-height: 1.5;
        }
        @media (max-width: 700px) {
          .liq-summary-grid { grid-template-columns: 1fr; }
        }
      `}</style>

      <div className="liq-summary-header">
        <span className="liq-summary-eyebrow">Position closed · {closedAt}</span>
        <h2 className="liq-summary-title">
          Your position closed <em>safely.</em>
        </h2>
      </div>

      <div className="liq-summary-grid">
        <div className="liq-summary-stat">
          <div className="liq-summary-stat-label">Position state</div>
          <div className="liq-summary-stat-value">Closed</div>
          <div className="liq-summary-stat-desc">
            No longer exposed to further price movement. Debt is fully repaid.
          </div>
        </div>

        <div className="liq-summary-stat">
          <div className="liq-summary-stat-label">Cascade depth</div>
          <div className="liq-summary-stat-value">SOL fell {drawdownPct.toFixed(1)}%</div>
          <div className="liq-summary-stat-desc">
            From ${original.startPriceUsd.toFixed(0)} at entry to ${finalPriceUsd.toFixed(0)} at close.
          </div>
        </div>

        <div className="liq-summary-stat">
          <div className="liq-summary-stat-label">Outcome</div>
          <div className="liq-summary-stat-value" style={{ color: 'var(--accent)' }}>
            Controlled exit
          </div>
          <div className="liq-summary-stat-desc">
            Better than an open-market liquidation. No bot took your collateral.
          </div>
        </div>
      </div>

      <div className="liq-summary-footer">
        <div className="liq-summary-footer-label">What just happened</div>
        <div className="liq-summary-footer-text">
          Cushion's vault handled the unwind on your behalf — repaying your debt to Kamino and managing the swap. Nothing else for you to do.
        </div>
      </div>
    </div>
  );
}
