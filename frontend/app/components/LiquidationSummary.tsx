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
  const debtRepaid = original.debtAmount;
  const openMarketBonus = debtRepaid * 0.05;

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
          margin-bottom: 24px;
          position: relative;
          flex-wrap: wrap;
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
          font-size: 28px;
          line-height: 1.1;
          color: var(--fg);
        }
        .liq-summary-title em {
          font-style: italic;
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
          margin-bottom: 8px;
        }
        .liq-summary-stat-value {
          font-family: var(--font-mono);
          font-size: 22px;
          color: var(--fg);
          margin-bottom: 6px;
        }
        .liq-summary-stat-desc {
          font-size: 12px;
          color: var(--fg-muted);
          line-height: 1.4;
        }
        .liq-summary-payoff {
          margin-top: 28px;
          padding: 20px;
          background: var(--bg-elevated);
          border-left: 2px solid var(--accent);
          border-radius: 4px;
          position: relative;
        }
        .liq-summary-payoff-label {
          font-family: var(--font-mono);
          font-size: 11px;
          color: var(--accent);
          text-transform: uppercase;
          letter-spacing: 0.08em;
          margin-bottom: 6px;
        }
        .liq-summary-payoff-text {
          font-size: 14px;
          color: var(--fg);
          line-height: 1.5;
        }
        @media (max-width: 700px) {
          .liq-summary-grid { grid-template-columns: 1fr; }
        }
      `}</style>

      <div className="liq-summary-header">
        <span className="liq-summary-eyebrow">Position closed</span>
        <h2 className="liq-summary-title">
          Cushion executed a <em>controlled exit.</em>
        </h2>
      </div>

      <div className="liq-summary-grid">
        <div className="liq-summary-stat">
          <div className="liq-summary-stat-label">Original Position</div>
          <div className="liq-summary-stat-value">
            {original.collateralAmount.toFixed(2)} SOL
          </div>
          <div className="liq-summary-stat-desc">
            {original.debtAmount.toFixed(2)} USDC borrowed at SOL ${original.startPriceUsd.toFixed(0)}
          </div>
        </div>

        <div className="liq-summary-stat">
          <div className="liq-summary-stat-label">Liquidation Price</div>
          <div className="liq-summary-stat-value">
            ${finalPriceUsd.toFixed(2)}
          </div>
          <div className="liq-summary-stat-desc">
            SOL fell {(((original.startPriceUsd - finalPriceUsd) / original.startPriceUsd) * 100).toFixed(1)}% from entry
          </div>
        </div>

        <div className="liq-summary-stat">
          <div className="liq-summary-stat-label">Bonus Recovered</div>
          <div className="liq-summary-stat-value" style={{ color: 'var(--accent)' }}>
            ~${openMarketBonus.toFixed(2)}
          </div>
          <div className="liq-summary-stat-desc">
            Kept inside the protocol instead of leaking to an external bot
          </div>
        </div>
      </div>

      <div className="liq-summary-payoff">
        <div className="liq-summary-payoff-label">What just happened</div>
        <div className="liq-summary-payoff-text">
          Cushion's vault swapped its WSOL collateral into USDC via Orca, repaid the position's debt to Kamino, and reclaimed the remaining collateral. The borrower received a controlled exit, and the liquidation bonus that would have gone to an external bot was captured by the protocol.
        </div>
      </div>
    </div>
  );
}
