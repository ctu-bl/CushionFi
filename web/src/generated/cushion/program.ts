import { Program, type AnchorProvider } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import idl from "./idl.json" with { type: "json" };
import type { Cushion } from "./types.ts";

export const CUSHION_PROGRAM_ID = new PublicKey("H8BhL28KxwHPyNyCNRQWb5MVVadqesiam9HQ9jPfmd8W");

export function createCushionProgram(provider: AnchorProvider): Program<Cushion> {
  return new Program(idl as Cushion, provider) as Program<Cushion>;
}
