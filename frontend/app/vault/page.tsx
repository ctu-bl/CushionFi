"use client";
import { AppNav } from '../components/AppNav';
import { Card } from '../components/Card';

const STATS = [
  {
    label: "Total Deposits",
    value: "$487,200",
    desc: "USD-equivalent value across all vault depositors",
  },
  {
    label: "Currently Deployed",
    value: "$32.18",
    desc: "Capital actively protecting positions right now",
  },
  {
    label: "Current APY",
    value: "8.7%",
    desc: "Annualized yield from interest charged on injected buffer",
  },
];

const RECENT_EVENTS = [
  {
    when: "2 min ago",
    msg: "Buffer deployed to Position #demo: $32.18",
  },
  {
    when: "14 min ago",
    msg: "Buffer withdrawn from Position #demo: $48.10 (incl. $0.42 interest)",
  },
  {
    when: "31 min ago",
    msg: "Buffer deployed to Position #demo: $47.68",
  },
  {
    when: "1 hr ago",
    msg: "Vault deposit received: $5,000",
  },
];

export default function VaultPage() {
  return (
    <>
      <AppNav />
      <main className="vault-page">
        <style>{`
          .vault-page { max-width: 1024px; margin: 0 auto; padding: 32px 24px; }
          .vault-header h1 {
            font-family: var(--font-display);
            font-size: 36px;
            line-height: 1;
            margin-bottom: 8px;
            color: var(--fg);
          }
          .vault-header p { color: var(--fg-muted); margin-bottom: 32px; }
          .vault-stats {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 16px;
            margin-bottom: 32px;
          }
          .vault-stat-label {
            font-size: 12px;
            color: var(--fg-muted);
            text-transform: uppercase;
            letter-spacing: 0.06em;
            margin-bottom: 12px;
          }
          .vault-stat-value {
            font-family: var(--font-mono);
            font-size: 32px;
            color: var(--fg);
            margin-bottom: 8px;
          }
          .vault-stat-desc {
            font-size: 13px;
            color: var(--fg-muted);
            line-height: 1.5;
          }
          .vault-events-title {
            font-size: 12px;
            color: var(--fg-muted);
            text-transform: uppercase;
            letter-spacing: 0.06em;
            margin-bottom: 16px;
          }
          .vault-event-row {
            display: flex;
            justify-content: space-between;
            padding: 12px 0;
            border-bottom: 1px solid var(--border);
            font-size: 14px;
          }
          .vault-event-row:last-child { border-bottom: none; }
          .vault-event-when {
            color: var(--fg-dim);
            font-family: var(--font-mono);
            font-size: 12px;
          }
          @media (max-width: 800px) { .vault-stats { grid-template-columns: 1fr; } }
        `}</style>

        <div className="vault-header">
          <h1>Cushion Vault</h1>
          <p>
            Liquidity providers deposit here. Capital protects borrowers. Interest accrues to depositors.
          </p>
        </div>

        <div className="vault-stats">
          {STATS.map(s => (
            <Card key={s.label}>
              <div className="vault-stat-label">{s.label}</div>
              <div className="vault-stat-value">{s.value}</div>
              <div className="vault-stat-desc">{s.desc}</div>
            </Card>
          ))}
        </div>

        <Card>
          <div className="vault-events-title">Recent Vault Activity</div>
          {RECENT_EVENTS.map((e, i) => (
            <div className="vault-event-row" key={i}>
              <span>{e.msg}</span>
              <span className="vault-event-when">{e.when}</span>
            </div>
          ))}
        </Card>
      </main>
    </>
  );
}
