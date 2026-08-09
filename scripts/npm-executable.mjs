import process from "node:process";

export function npmInvocation(platform = process.platform, environment = process.env) {
  if (environment.npm_execpath !== undefined) {
    return {
      executable: environment.npm_node_execpath ?? process.execPath,
      arguments: [environment.npm_execpath],
    };
  }
  return {
    executable: platform === "win32" ? "npm.cmd" : "npm",
    arguments: [],
  };
}
