"use client";
import { use } from 'react';
import { redirect } from 'next/navigation';
import { AppNav } from '../../components/AppNav';
import { DemoBanner } from '../../components/DemoBanner';
import { Card } from '../../components/Card';
import { LtvBar } from '../../components/LtvBar';
import { PriceChart } from '../../components/PriceChart';
import { HealthFactorRing } from '../../components/HealthFactorRing';
import { EventFeed } from '../../components/EventFeed';
import { LiquidationSummary } from '../../components/LiquidationSummary';
import { useCascadeRunner, CascadeControls } from '../../components/CascadeRunner';

export default function PositionDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  if (id !== 'demo') redirect('/positions/demo');

  const runner = useCascadeRunner();
  const { position, events, priceHistory, state, play, pause, reset } = runner;

  const isLiquidated = position.status === 'liquidated';

  return (
    <>
      <DemoBanner />
      <AppNav />
      <main className="position-page">
        <style>{`
          .position-page {
            max-width: 1280px;
            margin: 0 auto;
            padding: 32px 24px;
            display: grid;
            grid-template-columns: 1fr 380px;
            gap: 24px;
          }
          .position-main { display: flex; flex-direction: column; gap: 24px; }
          .position-header {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            flex-wrap: wrap;
            gap: 16px;
          }
          .position-eyebrow {
            display: inline-flex;
            align-items: center;
            gap: 8px;
            font-family: var(--font-mono);
            font-size: 11px;
            letter-spacing: 0.12em;
            text-transform: uppercase;
            color: var(--accent);
            margin-bottom: 12px;
          }
          .position-eyebrow-dot {
            width: 6px;
            height: 6px;
            background: var(--accent);
            border-radius: 50%;
            display: inline-block;
            animation: pulse-dot 2s ease-in-out infinite;
          }
          @keyframes pulse-dot {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.4; }
          }
          .position-title-block h1 {
            font-family: var(--font-display);
            font-size: 44px;
            line-height: 1;
            margin-bottom: 8px;
            color: var(--fg);
            letter-spacing: -0.01em;
          }
          .position-title-block h1 em {
            font-style: italic;
            color: var(--accent);
          }
          .position-title-block .position-id {
            font-family: var(--font-mono);
            font-size: 12px;
            color: var(--fg-muted);
          }
          .position-stats {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 16px;
          }
          .position-stat-label {
            font-size: 11px;
            color: var(--fg-muted);
            text-transform: uppercase;
            letter-spacing: 0.04em;
            margin-bottom: 4px;
          }
          .position-stat-value {
            font-family: var(--font-mono);
            font-size: 20px;
            color: var(--fg);
          }
          .position-stat-value.muted {
            color: var(--fg-dim);
          }
          .ltv-section {
            padding-top: 36px;
            padding-bottom: 36px;
          }
          .chart-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 16px;
          }
          @media (max-width: 900px) {
            .position-page { grid-template-columns: 1fr; }
            .position-stats { grid-template-columns: 1fr; }
          }
        `}</style>

        <div className="position-main">
          <div className="position-header">
            <div className="position-title-block">
              <div className="position-eyebrow">
                <span className="position-eyebrow-dot" />
                Live position · Wrapped on Kamino
              </div>
              <h1>SOL/USDC <em>Position</em></h1>
              <div className="position-id">id: demo</div>
            </div>
            <CascadeControls
              state={state}
              onPlay={play}
              onPause={pause}
              onReset={reset}
            />
          </div>

          <Card>
            <div className="position-stats">
              <div>
                <div className="position-stat-label">Collateral</div>
                <div className={`position-stat-value ${isLiquidated ? 'muted' : ''}`}>
                  {isLiquidated ? '—' : `${position.collateralAmount.toFixed(3)} SOL`}
                </div>
              </div>
              <div>
                <div className="position-stat-label">Debt</div>
                <div className={`position-stat-value ${isLiquidated ? 'muted' : ''}`}>
                  {isLiquidated ? '—' : `${position.debtAmount.toFixed(2)} USDC`}
                </div>
              </div>
              <div>
                <div className="position-stat-label">SOL Price</div>
                <div className={`position-stat-value ${isLiquidated ? 'muted' : ''}`}>
                  {isLiquidated ? '—' : `$${position.collateralPriceUsd.toFixed(2)}`}
                </div>
              </div>
            </div>
          </Card>

          {isLiquidated && (
            <LiquidationSummary
              position={position}
              original={{
                collateralAmount: 5.0,
                debtAmount: 225,
                startPriceUsd: 90,
              }}
              finalPriceUsd={position.collateralPriceUsd > 0 ? position.collateralPriceUsd : 48}
            />
          )}

          <Card>
            <div className="ltv-section">
              <LtvBar position={position} />
            </div>
          </Card>

          <Card>
            <div className="chart-row">
              <div>
                <div className="position-stat-label">SOL Price (last 30s)</div>
              </div>
              <HealthFactorRing position={position} />
            </div>
            <PriceChart prices={priceHistory} />
          </Card>
        </div>

        <div>
          <EventFeed events={events} />
        </div>
      </main>
    </>
  );
}
