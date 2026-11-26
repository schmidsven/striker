// Open a URL in the person's browser (main.js: Shepherdr; striker.js: PRs on the board).
import { exec, window } from "herdr";

const OPENER = { macos: ["open"], windows: ["cmd", "/c", "start", ""], linux: ["xdg-open"] };
export const openUrl = (url) => {
  const [cmd, ...args] = OPENER[window()?.platform] ?? OPENER.linux;
  return exec(cmd, [...args, url]).catch(() => {});
};
