import { app, BrowserWindow, dialog, ipcMain } from "electron";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { OptimizationMode } from "../shared/types";
import { scanProject, diffFileMaps } from "./scanner";
import { loadFileMap, saveFileMap, loadProjectMemory, appendHistory } from "./memory";
import { getRecentlyChangedFiles } from "./git";
import { buildContext } from "./contextSelector";

let mainWindow: BrowserWindow | null = null;

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

ipcMain.handle("select-folder", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
});

ipcMain.handle("scan-project", async (_event, root: string) => {
  const previous = loadFileMap(root);
  const fileMap = await scanProject(root, (scanned, total) => {
    mainWindow?.webContents.send("scan-progress", { scanned, total });
  });
  const changedSincePrevious = diffFileMaps(previous, fileMap);
  saveFileMap(root, fileMap);
  const memory = loadProjectMemory(root);
  return { fileMap, changedSincePrevious, history: memory.history };
});

ipcMain.handle(
  "run-task",
  async (_event, args: { root: string; task: string; mode: OptimizationMode }) => {
    const { root, task, mode } = args;
    const fileMap = loadFileMap(root);
    if (!fileMap) throw new Error("Primero escanea el proyecto.");
    const recentlyChanged = await getRecentlyChangedFiles(root);
    const result = buildContext(root, fileMap, task, mode, recentlyChanged);

    appendHistory(root, {
      id: randomUUID(),
      task,
      mode,
      tokensSelected: result.tokensSelected,
      tokensSaved: result.tokensSaved,
      savingsPercent: result.savingsPercent,
      createdAt: result.createdAt,
      filesIncluded: result.files.filter((f) => f.included).map((f) => f.path),
    });

    return result;
  }
);

ipcMain.handle("get-history", async (_event, root: string) => {
  return loadProjectMemory(root).history;
});
