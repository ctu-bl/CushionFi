"use client";
import { useMemo } from 'react';

type Props = {
  prices: { t: number; priceUsd: number }[];
  width?: number;
  height?: number;
};

export function PriceChart({ prices, width = 600, height = 80 }: Props) {
  const path = useMemo(() => {
    if (prices.length < 2) return '';
    const minP = Math.min(...prices.map(p => p.priceUsd));
    const maxP = Math.max(...prices.map(p => p.priceUsd));
    const range = maxP - minP || 1;
    const minT = prices[0].t;
    const maxT = prices[prices.length - 1].t;
    const tRange = maxT - minT || 1;

    return prices
      .map((p, i) => {
        const x = ((p.t - minT) / tRange) * width;
        const y = height - ((p.priceUsd - minP) / range) * height * 0.9 - height * 0.05;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }, [prices, width, height]);

  const lastPrice = prices[prices.length - 1]?.priceUsd ?? 0;
  const firstPrice = prices[0]?.priceUsd ?? 0;
  const isDown = lastPrice < firstPrice;

  return (
    <div style={{ width: '100%', position: 'relative' }}>
      <style>{`
        .price-chart-svg {
          width: 100%;
          height: ${height}px;
          display: block;
        }
        .price-chart-line {
          fill: none;
          stroke-width: 2;
          stroke-linejoin: round;
          stroke-linecap: round;
        }
        .price-chart-area {
          opacity: 0.15;
        }
      `}</style>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="price-chart-svg"
      >
        {path && (
          <>
            <path
              d={`${path} L${width},${height} L0,${height} Z`}
              className="price-chart-area"
              fill={isDown ? 'var(--danger)' : 'var(--accent)'}
            />
            <path
              d={path}
              className="price-chart-line"
              stroke={isDown ? 'var(--danger)' : 'var(--accent)'}
            />
          </>
        )}
      </svg>
    </div>
  );
}
