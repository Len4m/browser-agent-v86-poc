import { generateToolDefinitionsModule, TOOL_DEFINITIONS_MODULE } from "../lib/tool-definitions.mjs";

export function toolDefinitionsPlugin(root) {
  return {
    name: "ba-tool-definitions",
    setup(build) {
      build.onResolve({ filter: new RegExp(`^${TOOL_DEFINITIONS_MODULE}$`) }, () => ({
        path: TOOL_DEFINITIONS_MODULE,
        namespace: "ba-tool-definitions",
      }));

      build.onLoad({ filter: /.*/, namespace: "ba-tool-definitions" }, () => ({
        contents: generateToolDefinitionsModule(root),
        loader: "ts",
        resolveDir: root,
      }));
    },
  };
}
