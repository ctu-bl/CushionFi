export interface LocalState {
    assetMint?: string;
    collection?: string;
  }
  
  export const LOCAL_STATE_FILE_PATH: URL;
  export function readEnvironmentState(appEnv: string): Promise<LocalState>;
  export function readLocalState(): Promise<LocalState>;
  export function writeEnvironmentState(
    appEnv: string,
    partialState: LocalState
  ): Promise<LocalState>;
  export function writeLocalState(partialState: LocalState): Promise<LocalState>;
  