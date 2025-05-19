const fs = require('fs');
const path = require('path');

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
    preview: "vite preview"
  },
  dependencies: {},
  devDependencies: {}
};

// Root directory path
const rootDir = __dirname;

// Get all directories
const directories = fs.readdirSync(rootDir, { withFileTypes: true })
  .filter(dirent => dirent.isDirectory() && !dirent.name.startsWith('.'))
  .map(dirent => dirent.name);

console.log('Found project directories:', directories);

// Find and merge package.json files from each directory
directories.forEach(dir => {
  const packagePath = path.join(rootDir, dir, 'package.json');
  
  // Check if package.json exists
  if (fs.existsSync(packagePath)) {
    try {
      const packageData = JSON.parse(fs.readFileSync(packagePath, 'utf8'));
      console.log(`Processing: ${dir}/package.json`);
      
      // Merge dependencies
      if (packageData.dependencies) {
        Object.keys(packageData.dependencies).forEach(dep => {
          if (!mergedPackage.dependencies[dep] || 
              compareVersions(packageData.dependencies[dep], mergedPackage.dependencies[dep])) {
            mergedPackage.dependencies[dep] = packageData.dependencies[dep];
          }
        });
      }
      
      // Merge devDependencies
      if (packageData.devDependencies) {
        Object.keys(packageData.devDependencies).forEach(dep => {
          if (!mergedPackage.devDependencies[dep] || 
              compareVersions(packageData.devDependencies[dep], mergedPackage.devDependencies[dep])) {
            mergedPackage.devDependencies[dep] = packageData.devDependencies[dep];
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
  // Simple comparison - if existing version exists, don't add new version
  // For more accurate comparison, use semver library
  return !existingVersion; // Use new version if existing version doesn't exist
}

// Save result to merged-package.json file
fs.writeFileSync(
  path.join(rootDir, 'package.json'), 
  JSON.stringify(mergedPackage, null, 2)
);

console.log('All dependencies have been merged. Please check the package.json file.');