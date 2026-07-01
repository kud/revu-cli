// Global user settings (theme + diff view), persisted to ~/.config/revu.

import { THEMES } from "./themes.ts"

const SETTINGS_PATH = `${process.env.HOME}/.config/revu/settings.json`

export interface Settings {
  themeIndex: number
  diffView: "unified" | "split"
}

export const loadSettings = (): Settings => {
  const global = (() => {
    try {
      return JSON.parse(Bun.file(SETTINGS_PATH).textSync())
    } catch {
      return {}
    }
  })()
  return {
    themeIndex:
      typeof global.themeIndex === "number"
        ? Math.min(global.themeIndex, THEMES.length - 1)
        : 0,
    diffView:
      global.diffView === "split" ? ("split" as const) : ("unified" as const),
  }
}

export const saveSettings = async (settings: Settings): Promise<void> => {
  await Bun.write(SETTINGS_PATH, JSON.stringify(settings, null, 2))
}
