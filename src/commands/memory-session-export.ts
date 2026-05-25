export type MemorySessionExportOptions = {
  dryRun: boolean;
  force: boolean;
  model: string;
};

export async function runMemorySessionExportCommand(_opts: MemorySessionExportOptions) {
  return { exported: 0, skipped: 0 };
}
