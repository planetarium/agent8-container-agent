const fs = require("node:fs");
const path = require("node:path");

// Initialize result object
const mergedPackage = {
  name: "basic-vite-react",
  private: true,
  version: "0.0.0",
  type: "module",
  scripts: {
    dev: "vite",
    build: "vite build",
    lint: "eslint .",
    preview: "vite preview",
  },
  dependencies: {},
  devDependencies: {},
};

// Root directory path
const rootDir = __dirname;

// Get all directories
const directories = fs
  .readdirSync(rootDir, { withFileTypes: true })
  .filter((dirent) => dirent.isDirectory() && !dirent.name.startsWith("."))
  .map((dirent) => dirent.name);

// Find and merge package.json files from each directory
directories.forEach((dir) => {
  const packagePath = path.join(rootDir, dir, "package.json");

  // Check if package.json exists
  if (fs.existsSync(packagePath)) {
    try {
      const packageData = JSON.parse(fs.readFileSync(packagePath, "utf8"));

      // Merge dependencies
      if (packageData.dependencies) {
        Object.keys(packageData.dependencies).forEach((dep) => {
          if (
            !mergedPackage.dependencies[dep] ||
            compareVersions(
              packageData.dependencies[dep],
              mergedPackage.dependencies[dep],
            )
          ) {
            mergedPackage.dependencies[dep] = packageData.dependencies[dep];
          }
        });
      }

      // Merge devDependencies
      if (packageData.devDependencies) {
        Object.keys(packageData.devDependencies).forEach((dep) => {
          if (
            !mergedPackage.devDependencies[dep] ||
            compareVersions(
              packageData.devDependencies[dep],
              mergedPackage.devDependencies[dep],
            )
          ) {
            mergedPackage.devDependencies[dep] =
              packageData.devDependencies[dep];
          }
        });
      }
    } catch (err) {
      console.error(`Error processing ${dir}/package.json:`, err);
    }
  }
});

// Version comparison function (check if there's a higher version or range)
function compareVersions(newVersion, existingVersion) {
  // If no existing version, use new version
  if (!existingVersion) {
    return true;
  }

  // Extract version numbers from strings (remove ^, ~, >=, etc.)
  const cleanNewVersion = newVersion.replace(/[^0-9.]/g, "");
  const cleanExistingVersion = existingVersion.replace(/[^0-9.]/g, "");

  // Split version strings into parts
  const newParts = cleanNewVersion.split(".").map(Number);
  const existingParts = cleanExistingVersion.split(".").map(Number);

  // Compare version parts
  const maxLength = Math.max(newParts.length, existingParts.length);
  for (let i = 0; i < maxLength; i++) {
    const newPart = newParts[i] || 0;
    const existingPart = existingParts[i] || 0;

    if (newPart > existingPart) {
      return true; // New version is higher
    }
    if (newPart < existingPart) {
      return false; // Existing version is higher
    }
  }

  // Versions are equal, keep existing
  return false;
}

// Save result to merged-package.json file
fs.writeFileSync(
  path.join(rootDir, "package.json"),
  JSON.stringify(mergedPackage, null, 2),
);
