import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';
import type {
  FileMap,
  FileMapBuildOptions,
  FileMapBuildResult,
} from '../types/fileMap.js';
import {
  normalizeFileMapOptions as normalize,
  createInitialStats as createStats,
  getMimeTypeFromPath as getMimeType,
  isExtensionAllowed as checkExtension,
  isDirectoryExcluded as checkDirectory,
  isFileExcluded as checkFile,
  FileMapBuildError as BuildError
} from '../types/fileMap.js';

/**
 * Node.js file system operations implementation
 */
class NodeFileSystemOperations {
  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  }

  async stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; size: number }> {
    const stats = await stat(path);
    return {
      isFile: () => stats.isFile(),
      isDirectory: () => stats.isDirectory(),
      size: stats.size
    };
  }

  async readdir(path: string): Promise<string[]> {
    return await readdir(path);
  }

  async readFile(path: string, encoding: string = 'utf8'): Promise<string> {
    return await readFile(path, { encoding: encoding as BufferEncoding });
  }

  join(...segments: string[]): string {
    return join(...segments);
  }

  relative(from: string, to: string): string {
    return relative(from, to);
  }
}

/**
 * Binary file detection implementation
 */
class BinaryDetector {
  private static readonly BINARY_EXTENSIONS = new Set([
    '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.ico', '.tiff', '.webp',
    '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.zip', '.tar', '.gz', '.rar', '.7z',
    '.exe', '.dll', '.so', '.dylib',
    '.bin', '.dat', '.db', '.sqlite'
  ]);

  isBinary(content: string, filePath?: string): boolean {
    // Check for null bytes (strong indicator of binary content)
    if (content.includes('\0')) {
      return true;
    }

    // Check for high ratio of non-printable characters
    let nonPrintableCount = 0;
    const sampleSize = Math.min(content.length, 8192); // Check first 8KB

    for (let i = 0; i < sampleSize; i++) {
      const charCode = content.charCodeAt(i);
      // Count characters outside printable ASCII range (excluding common whitespace)
      if (charCode < 32 && charCode !== 9 && charCode !== 10 && charCode !== 13) {
        nonPrintableCount++;
      }
    }

    // If more than 30% non-printable, consider binary
    return (nonPrintableCount / sampleSize) > 0.3;
  }

  isBinaryExtension(filePath: string): boolean {
    const ext = extname(filePath).toLowerCase();
    return BinaryDetector.BINARY_EXTENSIONS.has(ext);
  }
}

/**
 * Main FileMapBuilder implementation
 */
export class FileMapBuilder {
  private readonly workdir: string;
  protected readonly options: Required<FileMapBuildOptions>;
  private readonly fileSystem: NodeFileSystemOperations;
  private readonly binaryDetector: BinaryDetector;

  constructor(workdir: string, options?: FileMapBuildOptions) {
    this.workdir = workdir;
    this.options = normalize(options);
    this.fileSystem = new NodeFileSystemOperations();
    this.binaryDetector = new BinaryDetector();
  }

  async buildFileMap(options?: FileMapBuildOptions): Promise<FileMapBuildResult> {
    const startTime = Date.now();
    const stats = createStats();
    const effectiveOptions = options ? normalize(options) : this.options;

    try {
      console.log(`[FileMapBuilder] Starting FileMap construction from: ${this.workdir}`);
      console.log(`[FileMapBuilder] Options:`, {
        maxFileSize: effectiveOptions.maxFileSize,
        maxTotalSize: effectiveOptions.maxTotalSize,
        allowedExtensions: effectiveOptions.allowedExtensions.size,
        excludeDirectories: effectiveOptions.excludeDirectories.size,
        excludePatterns: effectiveOptions.excludePatterns.length
      });

      // Step 1: Get all source files
      const allFiles = await this.getAllSourceFiles();
      console.log(`[FileMapBuilder] Found ${allFiles.length} total files`);

      // Step 2: Filter allowed files
      const allowedFiles = allFiles.filter(file => this.isFileAllowed(file));
      console.log(`[FileMapBuilder] ${allowedFiles.length} files passed filtering`);

      // Step 3: Read content and build FileMap
      const fileMap: FileMap = {};

      for (const filePath of allowedFiles) {
        // Check total size limit before processing more files
        if (stats.totalSize >= effectiveOptions.maxTotalSize) {
          console.error(`[FileMapBuilder] Total size limit reached at ${stats.totalSize} bytes`);
          throw new BuildError(
            `Total size limit exceeded: ${stats.totalSize} >= ${effectiveOptions.maxTotalSize}`,
            'memory_limit'
          );
        }

        const content = await this.readFileContent(filePath);
        if (content !== null) {
          const isBinary = this.isBinaryFile(filePath, content);

          fileMap[filePath] = {
            type: 'file',
            content,
            isBinary
          };

          stats.processedFiles++;
          stats.totalSize += content.length;

          // Log progress for large operations
          if (stats.processedFiles % 100 === 0) {
            console.log(`[FileMapBuilder] Processed ${stats.processedFiles} files, ${stats.totalSize} bytes`);
          }
        } else {
          stats.skippedFiles++;
        }
      }

      stats.duration = Date.now() - startTime;

      console.log(`[FileMapBuilder] FileMap construction completed:`, {
        processedFiles: stats.processedFiles,
        skippedFiles: stats.skippedFiles,
        totalSize: stats.totalSize,
        duration: stats.duration
      });

      return { fileMap, stats };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[FileMapBuilder] FileMap construction failed: ${errorMessage}`);

      throw new BuildError(
        `Failed to build FileMap: ${errorMessage}`,
        'invalid_directory',
        error
      );
    }
  }

  async getAllSourceFiles(): Promise<string[]> {
    const files: string[] = [];
    const visited = new Set<string>();

    const traverse = async (dirPath: string): Promise<void> => {
      try {
        // Avoid infinite loops with symlinks
        const realPath = this.fileSystem.join(dirPath);
        if (visited.has(realPath)) {
          return;
        }
        visited.add(realPath);

        const entries = await this.fileSystem.readdir(dirPath);

        for (const entry of entries) {
          const fullPath = this.fileSystem.join(dirPath, entry);
          const relativePath = this.fileSystem.relative(this.workdir, fullPath);

          const stats = await this.fileSystem.stat(fullPath);

          if (stats.isDirectory()) {
            // Skip excluded directories
            if (!checkDirectory(relativePath, this.options.excludeDirectories)) {
              await traverse(fullPath);
            }
          } else if (stats.isFile()) {
            files.push(fullPath); // Use absolute path instead of relative path
          }
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[FileMapBuilder] Cannot read directory ${dirPath}: ${errorMessage}`);
        throw new BuildError(
          `Failed to read directory: ${dirPath} - ${errorMessage}`,
          'permission_error',
          error
        );
      }
    };

    await traverse(this.workdir);
    return files;
  }

  async readFileContent(filePath: string): Promise<string | null> {
    try {
      // filePath is already an absolute path
      const fullPath = filePath;
      const stats = await this.fileSystem.stat(fullPath);

      // Check file size limit
      if (stats.size > this.options.maxFileSize) {
        console.warn(`[FileMapBuilder] File too large: ${filePath} (${stats.size} bytes)`);
        return null;
      }

      // Check if file extension suggests binary content
      if (this.binaryDetector.isBinaryExtension(filePath)) {
        console.log(`[FileMapBuilder] Skipping binary file by extension: ${filePath}`);
        return null;
      }

      const content = await this.fileSystem.readFile(fullPath, 'utf8');

      // Additional binary check on content
      if (this.binaryDetector.isBinary(content, filePath)) {
        console.log(`[FileMapBuilder] Skipping binary file by content: ${filePath}`);
        return null;
      }

      return content;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[FileMapBuilder] Failed to read ${filePath}: ${errorMessage}`);
      throw new BuildError(
        `Failed to read file: ${filePath} - ${errorMessage}`,
        'permission_error',
        error
      );
    }
  }

  getMimeType(filePath: string): string {
    return getMimeType(filePath);
  }

  isBinaryFile(filePath: string, content: string): boolean {
    return this.binaryDetector.isBinary(content, filePath) ||
           this.binaryDetector.isBinaryExtension(filePath);
  }

  isFileAllowed(filePath: string): boolean {
    // Convert absolute path to relative for checking patterns
    const relativePath = this.fileSystem.relative(this.workdir, filePath);

    // Check if extension is allowed
    if (!checkExtension(relativePath, this.options.allowedExtensions)) {
      return false;
    }

    // Check if file matches exclusion patterns
    if (checkFile(relativePath, this.options.excludePatterns)) {
      return false;
    }

    // Check if any part of the path is an excluded directory
    const pathParts = relativePath.split('/');
    for (const part of pathParts.slice(0, -1)) { // Exclude filename itself
      if (this.options.excludeDirectories.has(part)) {
        return false;
      }
    }

    return true;
  }
}
