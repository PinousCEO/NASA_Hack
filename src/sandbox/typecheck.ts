/**
 * Static validation of script modules: policy scan + strict type-check against the
 * controlled API only, then transpilation to plain JavaScript for the sandbox.
 * This is defence in depth; the QuickJS sandbox is the actual isolation boundary.
 */
import ts from "typescript";
import { MISSION_API_DTS } from "./api.js";

export interface StaticValidation {
  ok: boolean;
  diagnostics: string[];
  policyViolations: string[];
  compiledJs: string | null;
}

const MODULE_FILE = "/sandbox/module.ts";
const API_FILE = "/sandbox/mission-api.d.ts";
const MAX_SOURCE_BYTES = 64 * 1024;

const OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ES2020,
  module: ts.ModuleKind.CommonJS,
  lib: ["lib.es2020.d.ts"],
  types: [],
  strict: true,
  noEmitOnError: true,
  noImplicitAny: true,
  skipLibCheck: true,
};

function policyScan(source: ts.SourceFile): string[] {
  const violations: string[] = [];
  const at = (node: ts.Node): string => {
    const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
    return `line ${line + 1}`;
  };
  const banned = new Set(["eval", "Function", "require", "globalThis", "process", "WebAssembly"]);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) {
      violations.push(`${at(node)}: imports are not allowed`);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      violations.push(`${at(node)}: re-exports from other modules are not allowed`);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      violations.push(`${at(node)}: dynamic import() is not allowed`);
    } else if (ts.isIdentifier(node) && banned.has(node.text)) {
      const parent = node.parent;
      const isPropertyName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node);
      if (!isPropertyName) violations.push(`${at(node)}: use of "${node.text}" is not allowed`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return violations;
}

export function validateModuleSource(sourceText: string): StaticValidation {
  if (Buffer.byteLength(sourceText, "utf8") > MAX_SOURCE_BYTES) {
    return { ok: false, diagnostics: [], policyViolations: [`source exceeds ${MAX_SOURCE_BYTES} bytes`], compiledJs: null };
  }
  const virtual = new Map([
    [MODULE_FILE, sourceText],
    [API_FILE, MISSION_API_DTS],
  ]);
  const host = ts.createCompilerHost(OPTIONS, true);
  const realGetSourceFile = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, ...rest) => {
    const text = virtual.get(fileName);
    return text !== undefined
      ? ts.createSourceFile(fileName, text, languageVersion, true)
      : realGetSourceFile(fileName, languageVersion, ...rest);
  };
  const realFileExists = host.fileExists.bind(host);
  const realReadFile = host.readFile.bind(host);
  host.fileExists = (f) => virtual.has(f) || realFileExists(f);
  host.readFile = (f) => virtual.get(f) ?? realReadFile(f);
  let compiledJs: string | null = null;
  host.writeFile = (fileName, text) => {
    if (fileName.endsWith("module.js")) compiledJs = text;
  };

  const program = ts.createProgram([MODULE_FILE, API_FILE], OPTIONS, host);
  const moduleSource = program.getSourceFile(MODULE_FILE)!;
  const policyViolations = policyScan(moduleSource);
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .map((d) => {
      const message = ts.flattenDiagnosticMessageText(d.messageText, "\n");
      if (d.file && d.start !== undefined) {
        const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
        return `line ${line + 1}:${character + 1} TS${d.code}: ${message}`;
      }
      return `TS${d.code}: ${message}`;
    });

  const hasRun = moduleSource.statements.some(
    (s) =>
      ts.isFunctionDeclaration(s) &&
      s.name?.text === "run" &&
      (ts.getCombinedModifierFlags(s) & ts.ModifierFlags.Export) !== 0,
  );
  if (!hasRun) policyViolations.push('module must declare "export function run(input)"');

  if (diagnostics.length === 0 && policyViolations.length === 0) program.emit(moduleSource);
  const ok = diagnostics.length === 0 && policyViolations.length === 0 && compiledJs !== null;
  return { ok, diagnostics, policyViolations, compiledJs: ok ? compiledJs : null };
}
