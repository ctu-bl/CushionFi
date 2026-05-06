import cushionIdl from "../../generated/cushion/idl.json" with { type: "json" };

export class CushionSdkError extends Error {
  readonly code?: number;
  readonly codeName?: string;
  readonly original: unknown;

  constructor(message: string, original: unknown, code?: number, codeName?: string) {
    super(message);
    this.name = "CushionSdkError";
    this.code = code;
    this.codeName = codeName;
    this.original = original;
  }
}

type IdlError = { code: number; name: string; msg?: string };

const IDL_ERRORS = new Map<number, IdlError>(
  ((cushionIdl as { errors?: IdlError[] }).errors ?? []).map((entry) => [entry.code, entry])
);

function parseCodeFromMessage(message: string): number | undefined {
  const matchHex = message.match(/custom program error:\s*0x([0-9a-fA-F]+)/);
  if (matchHex) return Number.parseInt(matchHex[1], 16);

  const matchDec = message.match(/custom program error:\s*(\d+)/);
  if (matchDec) return Number.parseInt(matchDec[1], 10);

  return undefined;
}

export function mapAnchorError(error: unknown): CushionSdkError {
  const anyError = error as {
    message?: string;
    error?: { errorCode?: { number?: number; code?: string }; errorMessage?: string };
    logs?: string[];
  };

  const explicitCode = anyError?.error?.errorCode?.number;
  const explicitCodeName = anyError?.error?.errorCode?.code;
  const explicitMessage = anyError?.error?.errorMessage;
  const fallbackMessage = anyError?.message ?? "Unknown Cushion SDK error";

  const parsedCode =
    explicitCode ??
    parseCodeFromMessage(fallbackMessage) ??
    (Array.isArray(anyError?.logs)
      ? anyError.logs.map((line) => parseCodeFromMessage(line)).find((value) => value !== undefined)
      : undefined);

  const idlMatch = parsedCode !== undefined ? IDL_ERRORS.get(parsedCode) : undefined;
  const codeName = explicitCodeName ?? idlMatch?.name;
  const message = explicitMessage ?? idlMatch?.msg ?? fallbackMessage;

  return new CushionSdkError(message, error, parsedCode, codeName);
}

export function isCushionErrorCode(error: unknown, codeName: string): boolean {
  const mapped = mapAnchorError(error);
  return mapped.codeName === codeName;
}
