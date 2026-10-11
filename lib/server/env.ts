// Node 24 loads CLI environment files without a separate runtime dependency.
for (const file of ['.env.local', '.env']) {
  try { process.loadEnvFile(file); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
}
