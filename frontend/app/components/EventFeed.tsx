"use client";
import type { CushionEvent } from '../lib/types';

const KIND_COLOR: Record<CushionEvent["kind"], string> = {
  price_tick: 'var(--fg-muted)',
  ltv_cross: 'var(--warning)',
  inject: 'var(--accent)',
  withdraw: 'var(--accent)',
  liquidate_swap: 'var(--warning)',
  liquidate: 'var(--danger)',
  warning: 'var(--warning)',
};

const KIND_LABEL: Record<CushionEvent["kind"], string> = {
  price_tick: 'PRICE',
  ltv_cross: 'LTV',
  inject: 'INJECT',
  withdraw: 'WITHDRAW',
  liquidate_swap: 'SWAP',
  liquidate: 'LIQUIDATE',
  warning: 'WARN',
};

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d
    .getMinutes()
    .toString()
    .padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

export function EventFeed({ events }: { events: CushionEvent[] }) {
  return (
    <div className="event-feed">
      <style>{`
        .event-feed {
          font-family: var(--font-mono);
          font-size: 12px;
          background: var(--bg-elevated);
          border: 1px solid var(--border);
          border-radius: 12px;
          padding: 16px;
          height: 460px;
          overflow-y: auto;
        }
        .event-feed-header {
          font-size: 10px;
          color: var(--fg-muted);
          text-transform: uppercase;
          letter-spacing: 0.08em;
          margin-bottom: 12px;
          padding-bottom: 8px;
          border-bottom: 1px solid var(--border);
        }
        .event-row {
          display: grid;
          grid-template-columns: 60px 70px 1fr;
          gap: 8px;
          padding: 6px 0;
          line-height: 1.4;
          animation: event-enter 240ms cubic-bezier(0.22, 1, 0.36, 1);
        }
        @keyframes event-enter {
          from { opacity: 0; transform: translateY(-4px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .event-time { color: var(--fg-dim); }
        .event-kind { font-weight: 600; }
        .event-msg { color: var(--fg); word-break: break-word; }
        .event-empty {
          color: var(--fg-dim);
          font-style: italic;
        }
      `}</style>

      <div className="event-feed-header">Protocol Event Log</div>

      {events.length === 0 ? (
        <div className="event-empty">Awaiting events…</div>
      ) : (
        events.map(e => (
          <div className="event-row" key={e.id}>
            <span className="event-time">{formatTime(e.ts)}</span>
            <span className="event-kind" style={{ color: KIND_COLOR[e.kind] }}>
              {KIND_LABEL[e.kind]}
            </span>
            <span className="event-msg">{e.message}</span>
          </div>
        ))
      )}
    </div>
  );
}
