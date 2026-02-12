import { useEffect, useMemo, useState } from "react";
import type { FileReadResult } from "./use-file-workspace";
import { formatBytes } from "./utils";
import "./text-file-preview.css";

const LINE_PAGE_SIZE = 160;

type PreviewMode = "read" | "edit";
type Language =
  | "typescript"
  | "javascript"
  | "json"
  | "python"
  | "shell"
  | "yaml"
  | "text";
type TokenKind = "plain" | "keyword" | "string" | "number" | "comment";

interface HighlightToken {
  readonly kind: TokenKind;
  readonly text: string;
}

const KEYWORDS: Record<Language, Set<string>> = {
  typescript: new Set([
    "as",
    "async",
    "await",
    "break",
    "case",
    "class",
    "const",
    "continue",
    "default",
    "else",
    "enum",
    "export",
    "extends",
    "false",
    "for",
    "from",
    "function",
    "if",
    "implements",
    "import",
    "in",
    "interface",
    "let",
    "new",
    "null",
    "return",
    "switch",
    "throw",
    "true",
    "try",
    "type",
    "undefined",
    "while",
  ]),
  javascript: new Set([
    "async",
    "await",
    "break",
    "case",
    "class",
    "const",
    "continue",
    "default",
    "else",
    "export",
    "extends",
    "false",
    "for",
    "from",
    "function",
    "if",
    "import",
    "in",
    "let",
    "new",
    "null",
    "return",
    "switch",
    "throw",
    "true",
    "try",
    "undefined",
    "while",
  ]),
  json: new Set(["true", "false", "null"]),
  python: new Set([
    "and",
    "as",
    "async",
    "await",
    "class",
    "def",
    "elif",
    "else",
    "False",
    "for",
    "from",
    "if",
    "import",
    "in",
    "None",
    "not",
    "or",
    "pass",
    "return",
    "True",
    "while",
  ]),
  shell: new Set([
    "case",
    "do",
    "done",
    "elif",
    "else",
    "esac",
    "export",
    "fi",
    "for",
    "function",
    "if",
    "in",
    "local",
    "return",
    "then",
    "while",
  ]),
  yaml: new Set(["true", "false", "null", "yes", "no", "on", "off"]),
  text: new Set(),
};

function detectLanguage(path: string): Language {
  const lowerPath = path.toLowerCase();
  if (
    lowerPath.endsWith(".ts") ||
    lowerPath.endsWith(".tsx") ||
    lowerPath.endsWith(".mts") ||
    lowerPath.endsWith(".cts")
  ) {
    return "typescript";
  }
  if (
    lowerPath.endsWith(".js") ||
    lowerPath.endsWith(".jsx") ||
    lowerPath.endsWith(".mjs") ||
    lowerPath.endsWith(".cjs")
  ) {
    return "javascript";
  }
  if (lowerPath.endsWith(".json")) {
    return "json";
  }
  if (lowerPath.endsWith(".py")) {
    return "python";
  }
  if (
    lowerPath.endsWith(".sh") ||
    lowerPath.endsWith(".bash") ||
    lowerPath.endsWith(".zsh")
  ) {
    return "shell";
  }
  if (lowerPath.endsWith(".yaml") || lowerPath.endsWith(".yml")) {
    return "yaml";
  }
  return "text";
}

function commentMarkers(language: Language): readonly string[] {
  if (language === "typescript" || language === "javascript") {
    return ["//"];
  }
  if (language === "python" || language === "shell" || language === "yaml") {
    return ["#"];
  }
  return [];
}

function tokenizeLine(line: string, language: Language): HighlightToken[] {
  if (line.length === 0) {
    return [{ kind: "plain", text: " " }];
  }

  const keywords = KEYWORDS[language];
  const markers = commentMarkers(language);
  const tokens: HighlightToken[] = [];
  let index = 0;

  while (index < line.length) {
    const marker = markers.find((value) => line.startsWith(value, index));
    if (marker) {
      tokens.push({
        kind: "comment",
        text: line.slice(index),
      });
      break;
    }

    const current = line[index];
    if (!current) {
      break;
    }

    if (current === '"' || current === "'" || current === "`") {
      const quote = current;
      let next = index + 1;
      while (next < line.length) {
        const char = line[next];
        if (char === "\\") {
          next += 2;
          continue;
        }
        if (char === quote) {
          next += 1;
          break;
        }
        next += 1;
      }
      tokens.push({
        kind: "string",
        text: line.slice(index, next),
      });
      index = next;
      continue;
    }

    if (/[0-9]/.test(current)) {
      let next = index + 1;
      while (next < line.length && /[0-9._]/.test(line[next] ?? "")) {
        next += 1;
      }
      tokens.push({
        kind: "number",
        text: line.slice(index, next),
      });
      index = next;
      continue;
    }

    if (/[A-Za-z_$]/.test(current)) {
      let next = index + 1;
      while (next < line.length && /[A-Za-z0-9_$]/.test(line[next] ?? "")) {
        next += 1;
      }
      const word = line.slice(index, next);
      tokens.push({
        kind: keywords.has(word) ? "keyword" : "plain",
        text: word,
      });
      index = next;
      continue;
    }

    let next = index + 1;
    while (next < line.length) {
      const char = line[next];
      if (!char || /[A-Za-z0-9_$'"`]/.test(char)) {
        break;
      }
      if (markers.some((value) => line.startsWith(value, next))) {
        break;
      }
      next += 1;
    }
    tokens.push({
      kind: "plain",
      text: line.slice(index, next),
    });
    index = next;
  }

  return tokens;
}

export interface TextFilePreviewProps {
  readonly path: string;
  readonly preview: FileReadResult;
  readonly draft: string;
  readonly setDraft: (value: string) => void;
  readonly busy: boolean;
  readonly onLoadMore: () => Promise<void>;
  readonly onSave: () => Promise<void>;
}

export function TextFilePreview(input: TextFilePreviewProps) {
  const [mode, setMode] = useState<PreviewMode>("read");
  const [page, setPage] = useState<number>(1);

  const language = useMemo(() => detectLanguage(input.path), [input.path]);
  const lines = useMemo(() => input.draft.split(/\r?\n/), [input.draft]);
  const pageCount = Math.max(1, Math.ceil(lines.length / LINE_PAGE_SIZE));
  const startLine = (page - 1) * LINE_PAGE_SIZE;
  const pageLines = lines.slice(startLine, startLine + LINE_PAGE_SIZE);

  const canEdit = !input.preview.truncated && input.preview.encoding === "utf8";

  useEffect(() => {
    setMode("read");
    setPage(1);
  }, [input.path]);

  useEffect(() => {
    setPage((prev) => Math.min(prev, pageCount));
  }, [pageCount]);

  return (
    <>
      <div className="text-preview-head">
        <div className="text-preview-mode">
          <button
            type="button"
            className={`secondary ${mode === "read" ? "active" : ""}`}
            onClick={() => setMode("read")}
          >
            只读
          </button>
          <button
            type="button"
            className={`secondary ${mode === "edit" ? "active" : ""}`}
            disabled={!canEdit}
            onClick={() => setMode("edit")}
          >
            编辑
          </button>
        </div>
        <div className="text-preview-controls">
          {input.preview.nextOffset !== null ? (
            <button
              type="button"
              className="secondary"
              disabled={input.busy}
              onClick={() => void input.onLoadMore()}
            >
              继续加载
            </button>
          ) : null}
          {mode === "edit" ? (
            <button
              type="button"
              disabled={input.busy || !canEdit}
              onClick={() => void input.onSave()}
            >
              保存
            </button>
          ) : null}
        </div>
      </div>

      {mode === "read" ? (
        <>
          {pageCount > 1 ? (
            <div className="text-preview-paging">
              <button
                type="button"
                className="secondary"
                disabled={page <= 1}
                onClick={() => setPage((prev) => Math.max(1, prev - 1))}
              >
                上一页
              </button>
              <strong>
                第 {page} / {pageCount} 页
              </strong>
              <button
                type="button"
                className="secondary"
                disabled={page >= pageCount}
                onClick={() => setPage((prev) => Math.min(pageCount, prev + 1))}
              >
                下一页
              </button>
            </div>
          ) : null}

          <ol className="code-lines" start={startLine + 1}>
            {pageLines.map((line, index) => (
              <li key={`${startLine + index}:${line.length}`}>
                <span className="code-line-no">{startLine + index + 1}</span>
                <code className="code-line">
                  {tokenizeLine(line, language).map((token, tokenIndex) => (
                    <span
                      key={`${startLine + index}:${tokenIndex}:${token.text.length}`}
                      className={`code-token code-token-${token.kind}`}
                    >
                      {token.text}
                    </span>
                  ))}
                </code>
              </li>
            ))}
          </ol>
        </>
      ) : (
        <textarea
          className="file-editor"
          value={input.draft}
          onChange={(event) => input.setDraft(event.target.value)}
          rows={10}
          disabled={input.busy}
        />
      )}

      <p className="muted">
        已加载 {formatBytes(input.preview.readBytes)} /{" "}
        {formatBytes(input.preview.size)}
      </p>
      {input.preview.truncated ? (
        <p className="muted">当前为分段读取，加载完整后才可进入编辑模式并保存。</p>
      ) : null}
    </>
  );
}
