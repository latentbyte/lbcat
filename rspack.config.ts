import * as path from "path";
import { rspack, NormalModule, type Configuration } from "@rspack/core";
import { ZipExecutionPlugin } from "./rspack-plugins/ZipExecutionPlugin";
import { readFileSync } from "fs";
import { v4 as uuidv4 } from "uuid";
import { resolveAgentEnabled, applyAgentManifest, firefoxRelease } from "./scripts/build-config.js";

const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

const version = pkg.version as string;
const dirname = path.resolve();
const isDev = process.env.NODE_ENV === "development";
const getManifestVersion = (pkgVersion: string) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+)(?:\.(\d+))?)?$/.exec(pkgVersion);
  if (!match) {
    throw new Error(`invalid package version: ${pkgVersion}`);
  }

  const [, major, minor, patch, prereleaseName, prereleaseIndex] = match;
  if (!prereleaseName) {
    return { manifestVersion: pkgVersion };
  }

  let betaVersion = 1000;
  switch (prereleaseName) {
    case "alpha":
      betaVersion += Number.parseInt(prereleaseIndex || "0", 10) + 1 || 1;
      break;
    case "beta":
      betaVersion += 100 * (Number.parseInt(prereleaseIndex || "0", 10) + 1 || 1);
      break;
    case "az":
      betaVersion += 900;
      break;
    default:
      throw new Error(`unknown prerelease version: ${prereleaseName}`);
  }

  return {
    manifestVersion: `${major}.${minor}.${patch}.${betaVersion}`,
    prereleaseName,
    versionName: pkgVersion,
  };
};
const versionInfo = getManifestVersion(version);
const isPrerelease = Boolean(versionInfo.prereleaseName);
const isBeta = version.includes("-");
const isReactTools = process.env.REACT_DEVTOOLS === "true";
// LBcat 保留 agent；上游正式版本屏蔽入口并移除 debugger 权限
// 可用环境变量 SC_ENABLE_AGENT 强制覆盖（如 e2e 在正式版上强制开启）。
const enableAgent = resolveAgentEnabled({
  isDev,
  isBeta,
  isFork: pkg.name === "lbcat",
  envValue: process.env.SC_ENABLE_AGENT,
});
const targetBrowser = (process.env.TARGET_BROWSER || "chrome").toLowerCase();
if (!["chrome", "firefox"].includes(targetBrowser)) {
  throw new Error(`unsupported target browser: ${targetBrowser}`);
}
const isFirefoxBuild = targetBrowser === "firefox";

type ScriptCatManifest = chrome.runtime.ManifestV3 & {
  background?: chrome.runtime.ManifestV3["background"] & { scripts?: string[] };
  browser_specific_settings?: {
    gecko?: {
      id?: string;
      strict_min_version?: string;
      update_url?: string;
      data_collection_permissions?: { required: string[] };
    };
  };
  commands?: Record<string, Record<string, never>>;
  incognito?: string;
  optional_permissions?: string[];
  permissions?: string[];
  sandbox?: { pages: string[] };
  version_name?: string;
};

const applyFirefoxManifest = (manifest: ScriptCatManifest) => {
  delete manifest.version_name;
  delete manifest.background?.service_worker;
  delete manifest.incognito;
  delete manifest.sandbox;
  manifest.permissions = manifest.permissions?.filter((val) => !["offscreen", "userScripts"].includes(val));
  manifest.optional_permissions = manifest.optional_permissions?.filter((val) => val !== "background");
  manifest.browser_specific_settings = {
    ...manifest.browser_specific_settings,
    gecko: {
      ...manifest.browser_specific_settings?.gecko,
      id: firefoxRelease.addonId,
      update_url: firefoxRelease.updateUrl,
      strict_min_version: "142.0",
      data_collection_permissions: {
        required: ["none"],
      },
    },
  };
  manifest.commands = {
    ...manifest.commands,
    _execute_action: {},
  };
};

const applyChromeManifest = (manifest: ScriptCatManifest) => {
  delete manifest.background?.scripts;
  manifest.optional_permissions = manifest.optional_permissions?.filter((val) => val !== "userScripts");
};

// Target browsers, see: https://github.com/browserslist/browserslist
// 依照 https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/API/userScripts#browser_compatibility
const targets = ["chrome >= 120", "edge >= 120", "firefox >= 142"];

const src = path.join(dirname, "src");
const dist = path.join(dirname, "dist");
const assets = path.join(src, "assets");

// 排除这些文件，不进行分离
const chunkExcludeSet = new Set([
  "editor.worker",
  "ts.worker",
  "linter.worker",
  "service_worker",
  "content",
  "inject",
  "scripting",
  "common",
]);

export default {
  ...(isDev
    ? {
        watch: true,
        mode: "development",
        devtool: process.env.NO_MAP === "true" ? false : "inline-source-map",
      }
    : {
        mode: "production",
        devtool: false,
      }),
  node: {
    __filename: false, // This disables the warning and the mocking
    __dirname: false,
  },
  context: dirname,
  entry: {
    service_worker: `${src}/service_worker.ts`,
    offscreen: `${src}/offscreen.ts`,
    sandbox: `${src}/sandbox.ts`,
    content: `${src}/content.ts`,
    scripting: `${src}/scripting.ts`,
    inject: `${src}/inject.ts`,
    common: `${src}/pages/common.ts`,
    popup: `${src}/pages/popup/main.tsx`,
    install: `${src}/pages/install/main.tsx`,
    batchupdate: `${src}/pages/batchupdate/main.tsx`,
    confirm: `${src}/pages/confirm/main.tsx`,
    import: `${src}/pages/import/main.tsx`,
    options: `${src}/pages/options/main.tsx`,
    "editor.worker": "monaco-editor/esm/vs/editor/editor.worker.js",
    "ts.worker": "monaco-editor/esm/vs/language/typescript/ts.worker.js",
    "linter.worker": `${src}/linter.worker.ts`,
  },
  output: {
    path: `${dist}/ext/src`,
    filename: "[name].js",
    clean: true,
  },
  resolve: {
    extensions: ["...", ".ts", ".tsx", ".jsx"],
    alias: {
      "@App": path.resolve(dirname, "src/"),
      "@Packages": path.resolve(dirname, "packages/"),
      // 改写eslint-plugin-userscripts以适配脚本猫，打包时重定义模块路径
      "../data/compat-grant": path.resolve(dirname, "packages/eslint/compat-grant"),
      "../data/compat-headers": path.resolve(dirname, "packages/eslint/compat-headers"),
    },
    fallback: {
      child_process: false,
    },
  },
  module: {
    rules: [
      {
        test: /\.css$/i,
        type: "css/auto",
        use: ["postcss-loader"],
      },
      {
        test: /\.(svg|png)$/,
        type: "asset",
      },
      {
        test: /\.(jsx?|tsx?)$/,
        use: [
          {
            loader: "builtin:swc-loader",
            options: {
              jsc: {
                externalHelpers: true,
                parser: {
                  syntax: "typescript",
                  tsx: true,
                  decorators: true,
                },
                transform: {
                  react: {
                    runtime: "automatic",
                    development: isDev,
                  },
                },
              },
              env: { targets },
            },
          },
        ],
      },
      {
        type: "asset/source",
        test: /\.tpl$/,
        exclude: /node_modules/,
      },
    ],
  },
  plugins: [
    new rspack.DefinePlugin({
      "process.env.VI_TESTING": "'false'",
      "process.env.SC_RANDOM_KEY": `'${uuidv4()}'`,
      "process.env.SC_ENABLE_AGENT": `'${enableAgent}'`,
    }),
    new rspack.CopyRspackPlugin({
      patterns: [
        {
          from: `${src}/manifest.json`,
          to: `${dist}/ext`,
          // 将manifest.json内版本号替换为package.json中版本号
          transform(content: Buffer) {
            const manifest = applyAgentManifest(
              JSON.parse(content.toString()) as ScriptCatManifest,
              enableAgent,
              targetBrowser
            );
            manifest.version = versionInfo.manifestVersion;
            if (versionInfo.versionName) {
              manifest.version_name = versionInfo.versionName;
            } else {
              delete manifest.version_name;
            }
            if (versionInfo.prereleaseName === "az") {
              manifest.name = "__MSG_scriptcat_az__";
            } else if (isDev || isPrerelease) {
              manifest.name = "__MSG_scriptcat_beta__";
            }
            if (isReactTools) {
              manifest.content_security_policy = {
                extension_pages: "script-src 'self' http://localhost:8097; object-src 'self'",
              };
            }
            if (isFirefoxBuild) {
              applyFirefoxManifest(manifest);
            } else {
              applyChromeManifest(manifest);
            }
            return JSON.stringify(manifest);
          },
        },
        {
          from: `${assets}/logo${isDev || isPrerelease ? "-beta" : ""}.png`,
          to: `${dist}/ext/assets/logo.png`,
        },
        {
          from: `${assets}/logo${isDev || isPrerelease ? "-beta" : ""}-32.png`,
          to: `${dist}/ext/assets/logo-32.png`,
        },
        { from: `${assets}/logo-gray.png`, to: `${dist}/ext/assets/logo-gray.png` },
        { from: `${assets}/logo-gray-32.png`, to: `${dist}/ext/assets/logo-gray-32.png` },
        { from: `${assets}/logo`, to: `${dist}/ext/assets/logo` },
        {
          from: `${assets}/_locales`,
          to: `${dist}/ext/_locales`,
        },
      ],
    }),
    new rspack.HtmlRspackPlugin({
      filename: `${dist}/ext/src/install.html`,
      template: `${src}/pages/template.html`,
      inject: "head",
      title: "Install - LBcat",
      minify: true,
      chunks: ["install"],
    }),
    new rspack.HtmlRspackPlugin({
      filename: `${dist}/ext/src/batchupdate.html`,
      template: `${src}/pages/template.html`,
      inject: "head",
      title: "BatchUpdate - LBcat",
      minify: true,
      chunks: ["batchupdate"],
    }),
    new rspack.HtmlRspackPlugin({
      filename: `${dist}/ext/src/confirm.html`,
      template: `${src}/pages/template.html`,
      inject: "head",
      title: "Confirm - LBcat",
      minify: true,
      chunks: ["confirm"],
    }),
    new rspack.HtmlRspackPlugin({
      filename: `${dist}/ext/src/import.html`,
      template: `${src}/pages/template.html`,
      inject: "head",
      title: "Import - LBcat",
      minify: true,
      chunks: ["import"],
    }),
    new rspack.HtmlRspackPlugin({
      templateParameters: {
        isReactTools: isReactTools ? "true" : "false",
      },
      filename: `${dist}/ext/src/options.html`,
      template: `${src}/pages/options.html`,
      inject: "head",
      title: "Home - LBcat",
      minify: true,
      chunks: ["options"],
    }),
    new rspack.HtmlRspackPlugin({
      filename: `${dist}/ext/src/agent-window.html`,
      template: `${src}/pages/agent-window.html`,
      inject: false,
      minify: true,
      chunks: [],
    }),
    new rspack.HtmlRspackPlugin({
      filename: `${dist}/ext/src/popup.html`,
      template: `${src}/pages/popup.html`,
      inject: "head",
      title: "Home - LBcat",
      minify: true,
      chunks: ["popup"],
    }),
    new rspack.HtmlRspackPlugin({
      filename: `${dist}/ext/src/offscreen.html`,
      template: `${src}/pages/offscreen.html`,
      inject: "head",
      minify: true,
      chunks: ["offscreen"],
    }),
    new rspack.HtmlRspackPlugin({
      filename: `${dist}/ext/src/sandbox.html`,
      template: `${src}/pages/sandbox.html`,
      inject: "head",
      minify: true,
      chunks: ["sandbox"],
    }),
    new ZipExecutionPlugin(),
  ].filter(Boolean),
  experiments: {
    css: true,
    parallelLoader: true,
  },
  optimization: {
    minimizer: [
      new rspack.SwcJsMinimizerRspackPlugin({
        minimizerOptions: {
          minify: !isDev,
          mangle: {
            keep_classnames: false,
            keep_fnames: false,
            keep_private_props: false,
            ie8: false,
            toplevel: true,
          },
          module: true,
          compress: {
            passes: 2,
            drop_console: false,
            drop_debugger: !isDev,
            ecma: 2022,
            arrows: true,
            dead_code: true,
            ie8: false,
            keep_classnames: false,
            keep_fargs: false,
            keep_fnames: false,
            toplevel: true,
            sequences: true,
            hoist_props: false,
            hoist_vars: false,
            reduce_funcs: true,
            reduce_vars: true,
            pure_getters: "strict",
          },
          format: {
            comments: false,
            beautify: false,
            ecma: 2022,
          },
        },
      }),
      new rspack.LightningCssMinimizerRspackPlugin({
        minimizerOptions: { targets },
      }),
    ],
    removeAvailableModules: true,
    removeEmptyChunks: true,
    realContentHash: true,
    sideEffects: true,
    providedExports: true,
    concatenateModules: true,
    avoidEntryIife: true,
    mergeDuplicateChunks: true,
    splitChunks: {
      minChunks: 1,
      maxAsyncRequests: 30,
      maxInitialRequests: 30,
      minSize: {
        javascript: 40 * 1024, // 40 kB
        css: 10 * 1024, // 10 kB
      },
      maxSize: {
        javascript: 2 * 1024 * 1024, // 2 MB
        css: 2 * 1024 * 1024, // 2 MB
      },
      chunks: (chunk) => !chunkExcludeSet.has(chunk.name || ""),
      hidePathInfo: false,
      name: (module, _ctx) => {
        if (module instanceof NormalModule) {
          const p = `/${module.rawRequest}|/${module.resource}`.toLowerCase().replace(/[\\@/]+/g, "/");
          if (p.startsWith("/packages/message/")) return "lib_message";
          if (module.type === "json" && p.includes("translation.json")) return "translation_json";
          let tag = "";
          const idx = p.indexOf("/node_modules/");
          if (idx >= 0) {
            let q = p.replace(/\.pnpm\/?/g, "");
            q = q.substring(idx);
            q = q.replace(/\..*/, "");
            tag = q.split("/")[2] || "";
          }
          if (module.type !== "css" && tag === "monaco-editor") return "lib_monaco";
          switch (tag) {
            case "react-icons":
              if (p.includes("/react-icons/tb")) return undefined;
            // eslint-disable-next-line no-fallthrough
            case "react-dropzone":
            case "react-dom":
            case "react-i18next":
            case "react-router-dom":
            case "react-joyride":
            case "react":
              return `lib_${tag}`;
          }
          if (tag.startsWith("dnd-kit")) return "lib_dnd-kit";
          if (tag.startsWith("popper")) return "lib_react-joyride";
          if (tag.startsWith("react-")) return "lib_react";
          if (tag.startsWith("eslint")) return "lib_eslint";
          if (tag.startsWith("i18n")) return "lib_i18n";
          if (
            tag.startsWith("arco-design") ||
            tag === "resize-observer-polyfill" ||
            tag === "b-validate" ||
            tag === "lodash" ||
            tag === "focus-lock"
          ) {
            return "lib_arco_design";
          }
          if (tag) {
            // cron, dayjs, yaml, jszip, prettier, ...
            if (tag === "luxon") return "lib_cron";
            return `lib_${tag}`;
          }
          return "chunk";
        }
      },
    },
  },
} satisfies Configuration;
