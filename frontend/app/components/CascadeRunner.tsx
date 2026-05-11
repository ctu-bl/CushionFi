"use client";
import { useState, useRef, useCallback, useEffect } from 'react';
import type { Position, CushionEvent } from '../lib/types';
import { SCENARIOS } from '../lib/scenarios';
import {
  computePositionFromFrame,
  applyEventToPosition,
  makeEvent,
  DEMO_INITIAL_POSITION,
} from '../lib/demoEngine';

export type RunnerState = "idle" | "playing" | "paused" | "finished";

export function useCascadeRunner() {
  const [position, setPosition] = useState<Position>(DEMO_INITIAL_POSITION);
  const [events, setEvents] = useState<CushionEvent[]>([]);
  const [priceHistory, setPriceHistory] = useState<{ t: number; priceUsd: number }[]>([
    { t: 0, priceUsd: 90 },
  ]);
  const [state, setState] = useState<RunnerState>("idle");
  const [scenarioId, setScenarioId] = useState<string>(SCENARIOS[0].id);

  const startTimeRef = useRef<number | null>(null);
  const frameIndexRef = useRef<number>(0);
  const rafRef = useRef<number | null>(null);
  const positionRef = useRef<Position>(DEMO_INITIAL_POSITION);

  positionRef.current = position;

  const reset = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    setPosition(DEMO_INITIAL_POSITION);
    positionRef.current = DEMO_INITIAL_POSITION;
    setEvents([]);
    setPriceHistory([{ t: 0, priceUsd: 90 }]);
    setState("idle");
    startTimeRef.current = null;
    frameIndexRef.current = 0;
  }, []);

  const tick = useCallback(() => {
    const scenario = SCENARIOS.find(s => s.id === scenarioId)!;
    const frames = scenario.frames;
    const elapsed = performance.now() - (startTimeRef.current ?? 0);

    while (
      frameIndexRef.current < frames.length &&
      frames[frameIndexRef.current].t <= elapsed
    ) {
      const frame = frames[frameIndexRef.current];
      const ts = Date.now();

      let newPos = computePositionFromFrame(positionRef.current, frame);

      if (frameIndexRef.current % 3 === 0) {
        setEvents(prev => [
          makeEvent(
            'price_tick',
            ts,
            `SOL price ${frame.priceUsd.toFixed(2)}`,
            { price: frame.priceUsd }
          ),
          ...prev,
        ]);
      }

      if (frame.expectedEvent) {
        let eventMsg = '';
        switch (frame.expectedEvent) {
          case 'inject': {
            const collateralValue = newPos.collateralAmount * frame.priceUsd;
            const surplus = collateralValue - newPos.debtAmount;
            const debtRatio = collateralValue > 0 ? newPos.debtAmount / collateralValue : 0;
            const injectAmount = Math.max(0, surplus * debtRatio * 0.5);
            eventMsg = `Cushion deployed $${injectAmount.toFixed(2)} buffer from vault`;
            break;
          }
          case 'withdraw':
            eventMsg = `Buffer withdrawn back to vault with interest accrued`;
            break;
          case 'liquidate_swap':
            eventMsg = `Vault swapping WSOL → USDC via Orca Whirlpool`;
            break;
          case 'liquidate':
            eventMsg = `Position closed: debt repaid, collateral reclaimed by vault`;
            break;
        }
        const evt = makeEvent(frame.expectedEvent, ts, eventMsg);
        newPos = applyEventToPosition(newPos, evt, frame);
        setEvents(prev => [evt, ...prev]);
      }

      setPosition(newPos);
      positionRef.current = newPos;
      setPriceHistory(prev => {
        const next = [...prev, { t: elapsed, priceUsd: frame.priceUsd }];
        return next.slice(-30);
      });

      frameIndexRef.current += 1;
    }

    if (frameIndexRef.current >= frames.length) {
      setState("finished");
      return;
    }

    rafRef.current = requestAnimationFrame(tick);
  }, [scenarioId]);

  const play = useCallback(() => {
    if (state === "finished") {
      reset();
      // schedule the play after reset's state updates flush
      requestAnimationFrame(() => {
        startTimeRef.current = performance.now();
        setState("playing");
        rafRef.current = requestAnimationFrame(tick);
      });
      return;
    }
    startTimeRef.current = performance.now();
    setState("playing");
    rafRef.current = requestAnimationFrame(tick);
  }, [state, tick, reset]);

  const pause = useCallback(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    setState("paused");
  }, []);

  useEffect(() => {
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return {
    position,
    events,
    priceHistory,
    state,
    scenarioId,
    setScenarioId,
    play,
    pause,
    reset,
  };
}

export function CascadeControls({
  state,
  onPlay,
  onPause,
  onReset,
}: {
  state: RunnerState;
  onPlay: () => void;
  onPause: () => void;
  onReset: () => void;
}) {
  return (
    <div className="cascade-controls">
      <style>{`
        .cascade-controls {
          display: flex;
          gap: 12px;
          align-items: center;
        }
        .cc-btn {
          font-family: var(--font-mono);
          font-size: 13px;
          padding: 10px 18px;
          background: var(--surface);
          border: 1px solid var(--border-strong);
          color: var(--fg);
          border-radius: 8px;
          transition: all 120ms ease;
        }
        .cc-btn:hover { background: var(--surface-2); }
        .cc-btn.primary {
          background: var(--accent);
          color: var(--bg);
          border-color: var(--accent);
        }
        .cc-btn.primary:hover { background: var(--accent-dim); }
        .cc-btn:disabled { opacity: 0.4; cursor: not-allowed; }
      `}</style>
      {state !== "playing" && (
        <button className="cc-btn primary" onClick={onPlay}>
          {state === "finished"
            ? "Replay scenario"
            : state === "paused"
            ? "Resume"
            : "▶ Play scenario"}
        </button>
      )}
      {state === "playing" && (
        <button className="cc-btn" onClick={onPause}>Pause</button>
      )}
      {state !== "idle" && (
        <button className="cc-btn" onClick={onReset}>Reset</button>
      )}
    </div>
  );
}
