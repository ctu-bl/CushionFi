import BN from "bn.js";

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

export type BigNumberish = bigint | BN | number | string;

export function toBigInt(value: BigNumberish): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error("Invalid number value");
    }
    return BigInt(value);
  }
  if (typeof value === "string") return BigInt(value);
  return BigInt(value.toString(10));
}

export function toBn(value: BigNumberish): BN {
  if (BN.isBN(value)) return value;
  return new BN(toBigInt(value).toString(10), 10);
}

export function assertU64(value: BigNumberish, fieldName: string): bigint {
  const parsed = toBigInt(value);
  if (parsed < 0n || parsed > U64_MAX) {
    throw new Error(`${fieldName} is out of u64 range`);
  }
  return parsed;
}

export function assertU128(value: BigNumberish, fieldName: string): bigint {
  const parsed = toBigInt(value);
  if (parsed < 0n || parsed > U128_MAX) {
    throw new Error(`${fieldName} is out of u128 range`);
  }
  return parsed;
}

export function toU64Bn(value: BigNumberish, fieldName: string): BN {
  return toBn(assertU64(value, fieldName));
}

export function toU64Number(value: BigNumberish, fieldName: string): number {
  const parsed = assertU64(value, fieldName);
  return Number(parsed);
}

export function toNullableBigInt(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(value);
  if (typeof value === "string") return BigInt(value);
  if (typeof value === "object" && value !== null && "toString" in value) {
    return BigInt((value as { toString(): string }).toString());
  }
  return null;
}
