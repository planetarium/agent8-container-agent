/**
 * Remove extra indentation and normalize file content
 */
export function cleanoutFileContent(code: string): string {
  const lines = code.split("\n");
  const nonEmptyLines = lines.filter((line) => line.trim() !== "");

  if (nonEmptyLines.length === 0) {
    return code;
  }

  const minIndent = Math.min(...nonEmptyLines.map((line) => line.match(/^\s*/)?.[0].length ?? 0));

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
  return code.replace(/^```[\w-]*\n?/gm, "```\n").replace(/\n?```$/gm, "\n```");
}

/**
 * Clean escaped HTML tags in content
 */
export function cleanEscapedTags(content: string): string {
  return content
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
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
