#!/usr/bin/env node
/* global process */
import { promises as fs } from "fs";
import prettier from "prettier";
import semver from "semver";

const usage = () => {
  console.error("usage: node scripts/set-version.mjs <x.y.z>");
};

const [rawVersion] = process.argv.slice(2);
if (!rawVersion) {
  usage();
  process.exit(1);
}

const version = semver.parse(rawVersion);
if (!version || version.prerelease.length > 0) {
  usage();
  console.error(`invalid release version: ${rawVersion}`);
  process.exit(1);
}

const manifestVersion = `${version.major}.${version.minor}.${version.patch}`;
const packageVersion = manifestVersion;

const readJson = async (path) => JSON.parse(await fs.readFile(path, "utf8"));
const writeJson = async (path, value) => {
  const source = `${JSON.stringify(value, null, 2)}\n`;
  const formatted = await prettier.format(source, { filepath: path });
  await fs.writeFile(path, formatted);
};

const packageJson = await readJson("package.json");
packageJson.version = packageVersion;
await writeJson("package.json", packageJson);

const manifestJson = await readJson("src/manifest.json");
manifestJson.name = "LBcat";
manifestJson.version = manifestVersion;
delete manifestJson.version_name;
await writeJson("src/manifest.json", manifestJson);

console.log(`set package version to ${packageVersion}`);
console.log(`set manifest version to ${manifestVersion}`);
