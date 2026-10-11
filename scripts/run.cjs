// In-process CLI loader also works in environments that prohibit executable child helpers.
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const result = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true, moduleResolution: ts.ModuleResolutionKind.Node10 } });
  module._compile(result.outputText, filename);
};
const command = process.argv[2];
if (!['init', 'worker', 'create-admin', 'repair-languages', 'backfill-metadata'].includes(command)) throw new Error('Command must be init, worker, create-admin, repair-languages or backfill-metadata');
process.argv.splice(2, 1);
require(path.join(__dirname, `${command}.ts`));
