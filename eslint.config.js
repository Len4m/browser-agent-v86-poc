import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const tsconfigRootDir = dirname(fileURLToPath(import.meta.url));

const modernBrowserTs = [
  "src/browser/app/i18n.ts",
  "src/browser/app/lang-selector.ts",
  "src/browser/app/origin-awareness.ts",
  "src/browser/app/state.ts",
  "src/browser/app/text-utils.ts",
  "src/browser/compat/**/*.ts",
  "src/browser/chat/provider/ai-sdk/browser-agent-runner.ts",
  "src/browser/chat/provider/ai-sdk/entry.ts",
  "src/browser/chat/provider/ai-sdk/llm-browser-ai.worker.ts",
  "src/browser/chat/provider/ai-sdk/text-tool-parser.ts",
  "src/browser/chat/rendering/markdown-renderer.ts",
  "src/browser/chat/state/capabilities.ts",
  "src/browser/chat/state/chat-state.ts",
  "src/browser/console/xterm-consoles.ts",
  "src/browser/core/**/*.ts",
  "src/browser/main.ts",
  "src/browser/types/**/*.d.ts",
  "src/browser/ui/checks-panel.ts",
  "src/browser/ui/modal.ts",
  "src/browser/ui/status-controls.ts",
  "src/browser/ui/tooltips.ts",
  "src/browser/vm/background-tools-serial1.ts",
  "src/browser/vm/console-control-serial2.ts",
  "src/browser/vm/operations.ts",
  "src/browser/vm/serial-vm.ts",
  "src/browser/vm/terminal-markers.ts",
  "src/browser/vm/profile-config.ts",
  "src/browser/vm/runtime-assets.ts",
];

const noInternalWindowGlobalsTs = [
  "src/browser/app/i18n.ts",
  "src/browser/app/lang-selector.ts",
  "src/browser/app/origin-awareness.ts",
  "src/browser/app/state.ts",
  "src/browser/app/text-utils.ts",
  "src/browser/chat/provider/ai-sdk/entry.ts",
  "src/browser/chat/provider/ai-sdk/llm-browser-ai.worker.ts",
  "src/browser/chat/provider/ai-sdk/text-tool-parser.ts",
  "src/browser/chat/rendering/markdown-renderer.ts",
  "src/browser/chat/state/capabilities.ts",
  "src/browser/chat/state/chat-state.ts",
  "src/browser/console/xterm-consoles.ts",
  "src/browser/core/**/*.ts",
  "src/browser/main.ts",
  "src/browser/ui/checks-panel.ts",
  "src/browser/ui/modal.ts",
  "src/browser/ui/status-controls.ts",
  "src/browser/ui/tooltips.ts",
  "src/browser/vm/background-tools-serial1.ts",
  "src/browser/vm/console-control-serial2.ts",
  "src/browser/vm/operations.ts",
  "src/browser/vm/serial-vm.ts",
  "src/browser/vm/terminal-markers.ts",
  "src/browser/vm/profile-config.ts",
  "src/browser/vm/runtime-assets.ts",
];

const nodeJsFiles = [
  "*.mjs",
  "eslint.config.js",
  "scripts/**/*.mjs",
  "server.mjs",
];

export default tseslint.config(
  {
    ignores: [
      "build/**",
      "coverage/**",
      "node_modules/**",
      "public/**",
    ],
  },
  {
    ...js.configs.recommended,
    files: nodeJsFiles,
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      "eqeqeq": ["error", "smart"],
      "no-fallthrough": "error",
      "no-implicit-globals": "error",
      "no-var": "error",
      "prefer-const": "error",
    },
  },
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: modernBrowserTs,
    languageOptions: {
      ...config.languageOptions,
      parserOptions: {
        ...config.languageOptions?.parserOptions,
        project: "./tsconfig.eslint.json",
        tsconfigRootDir,
      },
      globals: {
        ...globals.browser,
      },
    },
  })),
  {
    files: modernBrowserTs,
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir,
      },
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      }],
      "eqeqeq": ["error", "smart"],
      "no-fallthrough": "error",
      "no-var": "error",
      "prefer-const": "error",
    },
  },
  {
    files: noInternalWindowGlobalsTs,
    rules: {
      "no-restricted-syntax": ["error", {
        selector: "MemberExpression[object.name='window'][property.name=/^BA_/]",
        message: "Internal BA_* globals are only allowed in compat facades while migration is in progress.",
      }],
    },
  },
  {
    files: ["src/browser/**/*.ts"],
    ignores: modernBrowserTs,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      "@typescript-eslint/ban-ts-comment": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "eqeqeq": "off",
      "no-implicit-globals": "off",
      "no-var": "warn",
      "prefer-const": "off",
    },
  },
  {
    files: ["tests/**/*.ts"],
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", {
        argsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      }],
      "eqeqeq": ["error", "smart"],
      "no-var": "error",
      "prefer-const": "error",
    },
  },
);
