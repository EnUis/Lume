import ts from 'typescript';
export default {
  esbuild:false,
  resolve:{preserveSymlinks:true},
  plugins:[{name:'typescript-tests',enforce:'pre',transform(code,id){if(!/\.tsx?$/.test(id)||id.includes('/node_modules/')||id.includes('\\node_modules\\'))return null;return{code:ts.transpileModule(code.replaceAll('process.env.NODE_ENV',"process.env['NODE' + '_ENV']"),{fileName:id,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText,map:null};}}],
  test:{include:['tests/**/*.test.ts'],pool:'threads',maxWorkers:1,fileParallelism:false}
};
