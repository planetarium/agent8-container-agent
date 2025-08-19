/**
 * FileMap types and constants for handling file system trees
 */

const FILE_EXTENSION_REGEX = /\.[^.]+$/;

export interface FileMapEntry {
  content: string;
  path: string;
  lines?: number;
}

/**
 * File entry in FileMap
 */
export interface File {
  type: "file";
  content: string;
  isBinary: boolean;
}

/**
 * Folder entry in FileMap
 */
export interface Folder {
  type: "folder";
}

/**
 * Directory entry - can be either File or Folder
 */
type Dirent = File | Folder;

/**
 * FileMap structure - Record of paths to directory entries
 */
export type FileMap = Record<string, Dirent | undefined>;

/**
 * Configuration options for FileMap building process
 */
export interface FileMapBuildOptions {
  /** Maximum size per file in bytes (default: 1MB) */
  maxFileSize?: number;
  /** Maximum total FileMap size in bytes (default: 50MB) */
  maxTotalSize?: number;
  /** Set of allowed file extensions (default: predefined list) */
  allowedExtensions?: Set<string>;
  /** Set of directories to exclude (default: node_modules, .git, etc.) */
  excludeDirectories?: Set<string>;
  /** Regular expressions for files to exclude */
  excludePatterns?: RegExp[];
}

/**
 * Statistics collected during FileMap building process
 */
export interface FileMapBuildStats {
  /** Number of files successfully processed */
  processedFiles: number;
  /** Number of files skipped (binary, too large, excluded, etc.) */
  skippedFiles: number;
  /** Total size of all processed files in bytes */
  totalSize: number;
  /** Time taken to build FileMap in milliseconds */
  duration: number;
  /** List of error messages encountered during processing */
  errors: string[];
}

/**
 * Result of FileMap building process
 */
export interface FileMapBuildResult {
  /** The constructed FileMap */
  fileMap: FileMap;
  /** Statistics about the building process */
  stats: FileMapBuildStats;
}

/**
 * Detailed error information for file processing failures
 */
export interface FileProcessingError {
  /** Path of the file that caused the error */
  filePath: string;
  /** Error message */
  error: string;
  /** Category of error for better handling */
  errorType: "read_error" | "size_limit" | "binary_file" | "permission_denied";
}

/**
 * Custom error class for FileMap building failures
 */
export class FileMapBuildError extends Error {
  constructor(
    message: string,
    public readonly errorType: "memory_limit" | "permission_error" | "invalid_directory",
    public readonly details?: any,
  ) {
    super(message);
    this.name = "FileMapBuildError";
  }
}

/**
 * Default configuration constants
 */
export const DEFAULT_FILEMAP_CONFIG = {
  /** Default maximum file size: 1MB */
  MAX_FILE_SIZE: 1024 * 1024,
  /** Default maximum total FileMap size: 50MB */
  MAX_TOTAL_SIZE: 50 * 1024 * 1024,
  /** Default allowed file extensions */
  ALLOWED_EXTENSIONS: new Set([
    ".js",
    ".ts",
    ".jsx",
    ".tsx",
    ".json",
    ".md",
    ".txt",
    ".py",
    ".go",
    ".rs",
    ".java",
    ".c",
    ".cpp",
    ".h",
    ".hpp",
    ".css",
    ".scss",
    ".html",
    ".vue",
    ".svelte",
    ".yaml",
    ".yml",
    ".toml",
    ".dockerfile",
    ".gitignore",
  ]),
  /** Default excluded directories */
  EXCLUDED_DIRECTORIES: new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    "out",
    "target",
    "__pycache__",
    ".venv",
    "venv",
    ".next",
    ".nuxt",
    "coverage",
    ".nyc_output",
    "tmp",
    "temp",
  ]),
  /** Default excluded file patterns */
  EXCLUDED_PATTERNS: [
    /\.env(\.|$)/, // .env, .env.local, etc.
    /\.log$/,
    /\.tmp$/,
    /\.cache$/,
    /package-lock\.json$/,
    /yarn\.lock$/,
    /pnpm-lock\.yaml$/,
    /Cargo\.lock$/,
    /composer\.lock$/,
  ],
} as const;

/**
 * MIME type mapping for file extensions
 */
export const MIME_TYPE_MAP: Record<string, string> = {
  ".js": "application/javascript",
  ".ts": "application/typescript",
  ".jsx": "application/javascript",
  ".tsx": "application/typescript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".py": "text/x-python",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".java": "text/x-java",
  ".c": "text/x-c",
  ".cpp": "text/x-c++",
  ".h": "text/x-c",
  ".hpp": "text/x-c++",
  ".css": "text/css",
  ".scss": "text/x-scss",
  ".html": "text/html",
  ".vue": "text/x-vue",
  ".svelte": "text/x-svelte",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".toml": "application/toml",
  ".dockerfile": "text/x-dockerfile",
  ".gitignore": "text/plain",
};

/**
 * Helper function to normalize FileMapBuildOptions with defaults
 */
export function normalizeFileMapOptions(
  options?: FileMapBuildOptions,
): Required<FileMapBuildOptions> {
  return {
    maxFileSize: options?.maxFileSize ?? DEFAULT_FILEMAP_CONFIG.MAX_FILE_SIZE,
    maxTotalSize: options?.maxTotalSize ?? DEFAULT_FILEMAP_CONFIG.MAX_TOTAL_SIZE,
    allowedExtensions: options?.allowedExtensions ?? DEFAULT_FILEMAP_CONFIG.ALLOWED_EXTENSIONS,
    excludeDirectories: options?.excludeDirectories ?? DEFAULT_FILEMAP_CONFIG.EXCLUDED_DIRECTORIES,
    excludePatterns: options?.excludePatterns ?? [...DEFAULT_FILEMAP_CONFIG.EXCLUDED_PATTERNS],
  };
}

/**
 * Helper function to create initial FileMapBuildStats
 */
export function createInitialStats(): FileMapBuildStats {
  return {
    processedFiles: 0,
    skippedFiles: 0,
    totalSize: 0,
    duration: 0,
    errors: [],
  };
}

/**
 * Helper function to check if file extension is allowed
 */
export function isExtensionAllowed(filePath: string, allowedExtensions: Set<string>): boolean {
  const ext = filePath.toLowerCase().match(FILE_EXTENSION_REGEX)?.[0];
  return ext ? allowedExtensions.has(ext) : false;
}

/**
 * Helper function to check if directory should be excluded
 */
export function isDirectoryExcluded(dirPath: string, excludeDirectories: Set<string>): boolean {
  const dirName = dirPath.split("/").pop() || "";
  return excludeDirectories.has(dirName);
}

/**
 * Helper function to check if file matches exclusion patterns
 */
export function isFileExcluded(filePath: string, excludePatterns: RegExp[]): boolean {
  const fileName = filePath.split("/").pop() || "";
  return excludePatterns.some((pattern) => pattern.test(fileName));
}
