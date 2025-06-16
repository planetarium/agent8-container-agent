const CODEBLOCK_LANGUAGE_REGEX = /^```[\w-]*\n?/gm;
const CODEBLOCK_END_REGEX = /\n?```$/gm;
const WHITESPACE_START_REGEX = /^\s*/;
const HTML_ESCAPE_PATTERNS = {
  LT: /&lt;/g,
  GT: /&gt;/g,
  AMP: /&amp;/g,
  QUOT: /&quot;/g,
  APOS: /&#x27;/g,
};

/**
 * Remove extra indentation and normalize file content
 */
export function cleanoutFileContent(code: string): string {
  const lines = code.split("\n");
  const nonEmptyLines = lines.filter((line) => line.trim() !== "");

  if (nonEmptyLines.length === 0) {
    return code;
  }

  const minIndent = Math.min(
    ...nonEmptyLines.map((line) => line.match(WHITESPACE_START_REGEX)?.[0].length ?? 0),
  );

  return lines
    .map((line) => (line.trim() === "" ? "" : line.slice(minIndent)))
    .join("\n")
    .trim();
}

/**
 * Remove language identifier from code blocks
 */
export function cleanoutCodeblockSyntax(code: string): string {
  // Remove language identifiers like ```javascript, ```python, etc.
  return code.replace(CODEBLOCK_LANGUAGE_REGEX, "```\n").replace(CODEBLOCK_END_REGEX, "\n```");
}

/**
 * Clean escaped HTML tags in content
 */
export function cleanEscapedTags(content: string): string {
  return content
    .replace(HTML_ESCAPE_PATTERNS.LT, "<")
    .replace(HTML_ESCAPE_PATTERNS.GT, ">")
    .replace(HTML_ESCAPE_PATTERNS.AMP, "&")
    .replace(HTML_ESCAPE_PATTERNS.QUOT, '"')
    .replace(HTML_ESCAPE_PATTERNS.APOS, "'");
}

/**
 * Check if a string represents a complete JSON object
 */
export function isCompleteJSON(str: string): boolean {
  try {
    JSON.parse(str);
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract attribute value from tag string
 */
export function extractAttribute(tagContent: string, attributeName: string): string | undefined {
  const regex = new RegExp(`${attributeName}="([^"]*)"`, "i");
  const match = tagContent.match(regex);
  return match?.[1];
}
