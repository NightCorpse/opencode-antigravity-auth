import { execFile } from "node:child_process";

/** Apply administrative changes without restarting the shared server. */
export async function reloadOpencodeConfiguration(): Promise<void> {
  await new Promise<void>((resolve) => {
    execFile("opencode", ["reload"], { timeout: 30000 }, (error) => {
      if (error) {
        console.warn("Changes saved, but OpenCode could not reload. Run 'opencode reload' manually.");
      }
      resolve();
    });
  });
}
