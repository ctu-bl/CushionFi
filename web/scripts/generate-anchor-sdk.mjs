import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const TARGET_IDL = path.resolve(ROOT, "..", "target", "idl", "cushion.json");
const TARGET_TYPES = path.resolve(ROOT, "..", "target", "types", "cushion.ts");
const OUT_DIR = path.resolve(ROOT, "src", "generated", "cushion");
const OUT_IDL = path.join(OUT_DIR, "idl.json");
const OUT_TYPES = path.join(OUT_DIR, "types.ts");
const OUT_PROGRAM = path.join(OUT_DIR, "program.ts");
const OUT_INDEX = path.join(OUT_DIR, "index.ts");

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!fs.existsSync(TARGET_IDL)) {
  fail(`Missing ${TARGET_IDL}. Run 'anchor build' first.`);
}

if (!fs.existsSync(TARGET_TYPES)) {
  fail(`Missing ${TARGET_TYPES}. Run 'anchor build' first.`);
}

const idl = JSON.parse(fs.readFileSync(TARGET_IDL, "utf8"));
const programAddress = idl.address ?? idl.metadata?.address;

if (!programAddress) {
  fail("Program address not found in IDL (expected idl.address or idl.metadata.address).");
}

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.copyFileSync(TARGET_IDL, OUT_IDL);
fs.copyFileSync(TARGET_TYPES, OUT_TYPES);

const programTs = `import { Program, type AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import idl from "./idl.json";
import type { Cushion } from "./types";

export const CUSHION_PROGRAM_ID = new PublicKey("${programAddress}");

export function createCushionProgram(provider: AnchorProvider): Program<Cushion> {
  return new Program(idl as Cushion, provider) as Program<Cushion>;
}
`;

const indexTs = `export { CUSHION_PROGRAM_ID, createCushionProgram } from "./program";
export { default as cushionIdl } from "./idl.json";
export type { Cushion } from "./types";
`;

fs.writeFileSync(OUT_PROGRAM, programTs, "utf8");
fs.writeFileSync(OUT_INDEX, indexTs, "utf8");

console.log(`Generated Anchor SDK in ${OUT_DIR}`);
