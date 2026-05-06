const WAD = 1_000_000_000_000_000_000n;

export function wadToPercentString(wad: bigint | null, decimals = 4): string | null {
  if (wad === null) return null;
  if (decimals < 0) {
    throw new Error("decimals must be >= 0");
  }

  const scale = 10n ** BigInt(decimals);
  const scaledPercent = (wad * 100n * scale + WAD / 2n) / WAD;
  const whole = scaledPercent / scale;
  const fraction = (scaledPercent % scale).toString().padStart(decimals, "0");

  return `${whole.toString()}.${fraction}%`;
}

export function wadStringToPercentString(wad: string | null, decimals = 4): string | null {
  if (wad === null) return null;
  return wadToPercentString(BigInt(wad), decimals);
}
