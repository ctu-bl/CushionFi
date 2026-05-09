"use client";
import { use } from 'react';
import { redirect } from 'next/navigation';
import { AppNav } from '../../components/AppNav';
import { Card } from '../../components/Card';
import { LtvBar } from '../../components/LtvBar';
import { PriceChart } from '../../components/PriceChart';
import { HealthFactorRing } from '../../components/HealthFactorRing';
import { EventFeed } from '../../components/EventFeed';
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

  return (
    <>
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
          .position-title-block h1 {
            font-family: var(--font-display);
            font-size: 32px;
            line-height: 1;
            margin-bottom: 8px;
            color: var(--fg);
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
              <h1>SOL/USDC Position</h1>
              <div className="position-id">id: demo · Wrapped on Kamino</div>
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
                <div className="position-stat-value">
                  {position.collateralAmount.toFixed(3)} SOL
                </div>
              </div>
              <div>
                <div className="position-stat-label">Debt</div>
                <div className="position-stat-value">
                  {position.debtAmount.toFixed(2)} USDC
                </div>
              </div>
              <div>
                <div className="position-stat-label">SOL Price</div>
                <div className="position-stat-value">
                  ${position.collateralPriceUsd.toFixed(2)}
                </div>
              </div>
            </div>
          </Card>

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
