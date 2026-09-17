// Builds the docs/SYMBOLS.md content: a symbol -> file:line index over
// src/**/*.ts (excluding src/tests/**), so an agent can jump straight to
// code instead of grepping a 7,000-line file (twilioStream.ts).
//
// Uses the TypeScript compiler API to read the AST — never regex — so the
// map reflects actual exports, class members, and call expressions rather
// than text patterns that happen to look like them.
//
// This lives under src/ (not scripts/) so src/tests/symbolMap.test.ts can
// import generateSymbolMap() directly without pulling scripts/** into the
// tsc rootDir="src" compilation graph. The CLI entry point is
// scripts/gen-symbol-map.ts (`npm run symbols`); it imports this module,
// calls generateSymbolMap(), and writes docs/SYMBOLS.md.
//
// Line numbers shift on nearly every edit to the underlying source, so
// docs/SYMBOLS.md WILL go stale often — that is expected, not a bug.
// src/tests/symbolMap.test.ts regenerates the map in memory and diffs it
// against the committed file; when that test fails, run `npm run symbols`
// and commit the result.

import ts from 'typescript';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC_DIR_NAME = 'src';
const EXCLUDED_TOP_LEVEL_DIR = 'tests';
export const OUTPUT_RELATIVE_PATH = 'docs/SYMBOLS.md';
const TOOL_FILE_RELATIVE_PATH = 'src/realtime/twilioStream.ts';
const TOOL_DEFINITIONS_ARRAY_NAME = 'TOOL_DEFINITIONS';
const REGISTER_TRACKED_TOOL_METHOD = 'registerTrackedTool';

interface FileSymbol {
  line: number;
  kind: string;
  name: string;
}

interface ToolDefinitionEntry {
  name: string;
  line: number;
}

interface ToolRegistrationEntry {
  name: string;
  line: number;
  handlers: string[];
}

interface ToolSurface {
  definitions: ToolDefinitionEntry[];
  registrations: ToolRegistrationEntry[];
}

interface UnclassifiedNode {
  file: string;
  line: number;
  description: string;
}

/** Every src/**\/*.ts file except src/tests/**, sorted for a stable order. */
function listSourceFiles(rootDir: string): string[] {
  const srcDir = join(rootDir, SRC_DIR_NAME);
  const files: string[] = [];

  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        const relFromSrc = relative(srcDir, fullPath);
        if (
          relFromSrc === EXCLUDED_TOP_LEVEL_DIR ||
          relFromSrc.startsWith(`${EXCLUDED_TOP_LEVEL_DIR}${sep}`)
        ) {
          continue;
        }
        walk(fullPath);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        files.push(fullPath);
      }
    }
  };

  walk(srcDir);
  files.sort();
  return files;
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return (
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
    1
  );
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}

function isExported(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function isAsyncNode(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.AsyncKeyword);
}

function isPrivateMember(member: ts.ClassElement): boolean {
  if (hasModifier(member, ts.SyntaxKind.PrivateKeyword)) return true;
  return !!member.name && ts.isPrivateIdentifier(member.name);
}

function memberName(member: ts.ClassElement): string | null {
  if (!member.name) return null;
  if (ts.isIdentifier(member.name)) return member.name.text;
  if (ts.isPrivateIdentifier(member.name)) {
    return member.name.text.replace(/^#/, '');
  }
  return null;
}

/**
 * Top-level exported functions/consts/types/interfaces/classes (with their
 * class members) and top-level non-exported functions, in source order.
 * Anything else at the top level is reported via `unclassified` rather than
 * silently dropped.
 */
function extractFileSymbols(
  sourceFile: ts.SourceFile,
  unclassified: UnclassifiedNode[]
): FileSymbol[] {
  const symbols: FileSymbol[] = [];

  const report = (node: ts.Node, description: string) => {
    unclassified.push({
      file: sourceFile.fileName,
      line: lineOf(sourceFile, node),
      description,
    });
  };

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement)) {
      if (!statement.name) {
        report(statement, 'anonymous top-level function declaration');
        continue;
      }
      const prefix = `${isExported(statement) ? 'export ' : ''}${
        isAsyncNode(statement) ? 'async ' : ''
      }function`;
      symbols.push({
        line: lineOf(sourceFile, statement),
        kind: prefix,
        name: statement.name.text,
      });
      continue;
    }

    if (ts.isVariableStatement(statement)) {
      if (!isExported(statement)) continue; // only exported consts are in scope
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          symbols.push({
            line: lineOf(sourceFile, decl),
            kind: 'const',
            name: decl.name.text,
          });
        } else {
          report(
            decl,
            'exported variable declaration with a non-identifier (destructured) name'
          );
        }
      }
      continue;
    }

    if (ts.isTypeAliasDeclaration(statement)) {
      if (isExported(statement)) {
        symbols.push({
          line: lineOf(sourceFile, statement),
          kind: 'type',
          name: statement.name.text,
        });
      }
      continue;
    }

    if (ts.isInterfaceDeclaration(statement)) {
      if (isExported(statement)) {
        symbols.push({
          line: lineOf(sourceFile, statement),
          kind: 'interface',
          name: statement.name.text,
        });
      }
      continue;
    }

    if (ts.isClassDeclaration(statement)) {
      if (!statement.name) {
        report(statement, 'anonymous top-level class declaration');
        continue;
      }
      const className = statement.name.text;
      symbols.push({
        line: lineOf(sourceFile, statement),
        kind: isExported(statement) ? 'export class' : 'class',
        name: className,
      });
      for (const member of statement.members) {
        if (ts.isConstructorDeclaration(member)) {
          symbols.push({
            line: lineOf(sourceFile, member),
            kind: 'method',
            name: `${className}.constructor`,
          });
          continue;
        }
        if (
          ts.isMethodDeclaration(member) ||
          ts.isGetAccessorDeclaration(member) ||
          ts.isSetAccessorDeclaration(member)
        ) {
          const name = memberName(member);
          if (!name) {
            report(
              member,
              `class member with a computed/unsupported name in ${className}`
            );
            continue;
          }
          const accessorPrefix = ts.isGetAccessorDeclaration(member)
            ? 'get '
            : ts.isSetAccessorDeclaration(member)
              ? 'set '
              : '';
          const kind = `${isPrivateMember(member) ? 'private ' : ''}${
            isAsyncNode(member) ? 'async ' : ''
          }${accessorPrefix}method`;
          symbols.push({
            line: lineOf(sourceFile, member),
            kind,
            name: `${className}.${name}`,
          });
          continue;
        }
        // Property declarations, index signatures, and semicolon class
        // elements are not methods; the symbol map only indexes callable
        // members, so these are intentionally skipped (not unclassified).
      }
      continue;
    }

    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause) {
        report(
          statement,
          'export * (wildcard re-export) — names not enumerated'
        );
        continue;
      }
      if (ts.isNamespaceExport(statement.exportClause)) {
        symbols.push({
          line: lineOf(sourceFile, statement),
          kind: 're-export *',
          name: statement.exportClause.name.text,
        });
        continue;
      }
      for (const element of statement.exportClause.elements) {
        symbols.push({
          line: lineOf(sourceFile, statement),
          kind:
            statement.isTypeOnly || element.isTypeOnly
              ? 're-export type'
              : 're-export',
          name: element.name.text,
        });
      }
      continue;
    }

    if (
      ts.isImportDeclaration(statement) ||
      ts.isImportEqualsDeclaration(statement) ||
      ts.isExpressionStatement(statement) ||
      ts.isIfStatement(statement) ||
      ts.isTryStatement(statement) ||
      ts.isForStatement(statement) ||
      ts.isForInStatement(statement) ||
      ts.isForOfStatement(statement) ||
      ts.isWhileStatement(statement) ||
      ts.isDoStatement(statement) ||
      ts.isSwitchStatement(statement) ||
      ts.isLabeledStatement(statement) ||
      ts.isThrowStatement(statement) ||
      ts.isReturnStatement(statement) ||
      ts.isBlock(statement) ||
      statement.kind === ts.SyntaxKind.EmptyStatement
    ) {
      continue; // module-level side effects / control flow, not a symbol
    }

    report(statement, `unhandled top-level ${ts.SyntaxKind[statement.kind]}`);
  }

  return symbols;
}

/** `this.a.b.c(...)` -> `"a.b.c"`; returns null if the call is not on `this`. */
function thisCallPath(expression: ts.Expression): string | null {
  const parts: string[] = [];
  let current: ts.Expression = expression;
  while (ts.isPropertyAccessExpression(current)) {
    parts.unshift(current.name.text);
    current = current.expression;
  }
  if (current.kind !== ts.SyntaxKind.ThisKeyword) return null;
  return parts.join('.');
}

/** Every distinct `this.*(...)` call reachable inside `node`, in appearance order. */
function collectThisCallPaths(node: ts.Node): string[] {
  const found: string[] = [];
  const seen = new Set<string>();

  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const path = thisCallPath(n.expression);
      if (path && !seen.has(path)) {
        seen.add(path);
        found.push(path);
      }
    }
    ts.forEachChild(n, visit);
  };

  visit(node);
  return found;
}

/**
 * The "Tool surface": every `TOOL_DEFINITIONS` array entry's `name` (tool ->
 * definition line) and every `this.registerTrackedTool('<name>', handler)`
 * call (tool -> handler method(s) + line), both derived from the AST.
 */
function extractToolSurface(
  sourceFile: ts.SourceFile,
  unclassified: UnclassifiedNode[]
): ToolSurface {
  const definitions: ToolDefinitionEntry[] = [];
  const registrations: ToolRegistrationEntry[] = [];

  const report = (node: ts.Node, description: string) => {
    unclassified.push({
      file: sourceFile.fileName,
      line: lineOf(sourceFile, node),
      description,
    });
  };

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(decl.name) ||
        decl.name.text !== TOOL_DEFINITIONS_ARRAY_NAME ||
        !decl.initializer ||
        !ts.isArrayLiteralExpression(decl.initializer)
      ) {
        continue;
      }
      for (const element of decl.initializer.elements) {
        if (!ts.isObjectLiteralExpression(element)) {
          report(
            element,
            `${TOOL_DEFINITIONS_ARRAY_NAME} element is not an object literal`
          );
          continue;
        }
        const nameProp = element.properties.find(
          (property): property is ts.PropertyAssignment =>
            ts.isPropertyAssignment(property) &&
            ts.isIdentifier(property.name) &&
            property.name.text === 'name'
        );
        if (!nameProp || !ts.isStringLiteralLike(nameProp.initializer)) {
          report(
            element,
            `${TOOL_DEFINITIONS_ARRAY_NAME} entry has no literal 'name' property`
          );
          continue;
        }
        definitions.push({
          name: nameProp.initializer.text,
          line: lineOf(sourceFile, element),
        });
      }
    }
  }

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
      node.expression.name.text === REGISTER_TRACKED_TOOL_METHOD
    ) {
      const [nameArg, handlerArg] = node.arguments;
      if (!nameArg || !ts.isStringLiteralLike(nameArg)) {
        report(
          node,
          `${REGISTER_TRACKED_TOOL_METHOD} call has a non-literal tool name`
        );
      } else {
        const handlers = handlerArg ? collectThisCallPaths(handlerArg) : [];
        if (handlers.length === 0) {
          report(
            node,
            `${REGISTER_TRACKED_TOOL_METHOD}('${nameArg.text}') handler has no recognizable this.* call`
          );
        }
        registrations.push({
          name: nameArg.text,
          line: lineOf(sourceFile, node),
          handlers,
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return { definitions, registrations };
}

function renderFileSection(relPath: string, symbols: FileSymbol[]): string {
  const lines = [`## ${relPath}`, ''];
  for (const symbol of symbols) {
    lines.push(`${relPath}:${symbol.line}  ${symbol.kind}  ${symbol.name}`);
  }
  return lines.join('\n');
}

function renderToolSurface(toolSurface: ToolSurface): string {
  const lines = ['## Tool surface', ''];

  lines.push(
    `### ${TOOL_DEFINITIONS_ARRAY_NAME} (${TOOL_FILE_RELATIVE_PATH})`,
    ''
  );
  for (const def of toolSurface.definitions) {
    lines.push(`${TOOL_FILE_RELATIVE_PATH}:${def.line}  tool  ${def.name}`);
  }

  lines.push(
    '',
    `### ${REGISTER_TRACKED_TOOL_METHOD} registrations (${TOOL_FILE_RELATIVE_PATH})`,
    ''
  );
  for (const reg of toolSurface.registrations) {
    const handlerText =
      reg.handlers.length > 0 ? reg.handlers.join(' / ') : '(unresolved)';
    lines.push(
      `${TOOL_FILE_RELATIVE_PATH}:${reg.line}  registered_tool  ${reg.name} -> ${handlerText}`
    );
  }

  return lines.join('\n');
}

/**
 * Regenerates the symbol map in memory (no file I/O). Called by both the
 * scripts/gen-symbol-map.ts CLI (which writes docs/SYMBOLS.md) and
 * src/tests/symbolMap.test.ts (which diffs this against the committed file).
 */
export function generateSymbolMap(rootDir: string): string {
  const files = listSourceFiles(rootDir);
  const unclassified: UnclassifiedNode[] = [];
  const fileSections: string[] = [];
  let toolSurface: ToolSurface | undefined;

  for (const absPath of files) {
    const relPath = relative(rootDir, absPath).split(sep).join('/');
    const text = readFileSync(absPath, 'utf8');
    const sourceFile = ts.createSourceFile(
      relPath,
      text,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    );

    const symbols = extractFileSymbols(sourceFile, unclassified);
    if (symbols.length > 0) {
      fileSections.push(renderFileSection(relPath, symbols));
    }

    if (relPath === TOOL_FILE_RELATIVE_PATH) {
      toolSurface = extractToolSurface(sourceFile, unclassified);
    }
  }

  if (!toolSurface) {
    throw new Error(
      `${TOOL_FILE_RELATIVE_PATH} was not found under ${SRC_DIR_NAME}/ — cannot build the Tool surface section`
    );
  }

  for (const item of unclassified) {
    console.warn(
      `[symbolMap] could not classify ${item.file}:${item.line} — ${item.description}`
    );
  }

  const header = [
    '<!-- GENERATED by scripts/gen-symbol-map.ts — do not edit; run `npm run symbols`. -->',
    '',
    '# SYMBOLS — generated symbol -> file:line index',
    '',
    'Grep this file before grepping the source: `grep -n "<name>" docs/SYMBOLS.md`',
    'returns the file and line for a function, exported const/type/interface,',
    'class, or method. Line numbers shift on nearly every source edit, so this',
    'file goes stale often — that is expected. `src/tests/symbolMap.test.ts`',
    'catches staleness and tells you to run `npm run symbols` and commit it.',
    '',
  ].join('\n');

  const body = [renderToolSurface(toolSurface), ...fileSections].join('\n\n');

  return `${header}\n${body}\n`;
}
