const LOCAL_STATE_FILE_PATH = new URL(
    "./generated/local-state.json",
    import.meta.url
  );
  
  async function ensureGeneratedDir() {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const url = await import("node:url");
    const generatedDirPath = path.dirname(url.fileURLToPath(LOCAL_STATE_FILE_PATH));
    await fs.mkdir(generatedDirPath, { recursive: true });
  }
  
  async function readLocalState() {
    return readEnvironmentState("local");
  }
  
  async function writeLocalState(partialState) {
    return writeEnvironmentState("local", partialState);
  }
  
  async function readStateFile() {
    const fs = await import("node:fs/promises");
  
    try {
      const raw = await fs.readFile(LOCAL_STATE_FILE_PATH, "utf-8");
      return JSON.parse(raw);
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "ENOENT"
      ) {
        return {};
      }
  
      throw error;
    }
  }
  
  async function readEnvironmentState(appEnv) {
    const state = await readStateFile();
    const scopedState = state?.[appEnv];
  
    if (!scopedState || typeof scopedState !== "object") {
      return {};
    }
  
    return scopedState;
  }
  
  async function writeEnvironmentState(appEnv, partialState) {
    const fs = await import("node:fs/promises");
    const currentState = await readStateFile();
    const scopedState =
      currentState?.[appEnv] && typeof currentState[appEnv] === "object"
        ? currentState[appEnv]
        : {};
    const nextScopedState = { ...scopedState, ...partialState };
    const nextState = { ...currentState, [appEnv]: nextScopedState };
  
    await ensureGeneratedDir();
    await fs.writeFile(
      LOCAL_STATE_FILE_PATH,
      JSON.stringify(nextState, null, 2) + "\n",
      "utf-8"
    );
  
    return nextScopedState;
  }
  
  export {
    LOCAL_STATE_FILE_PATH,
    readEnvironmentState,
    readLocalState,
    writeEnvironmentState,
    writeLocalState,
  };
  