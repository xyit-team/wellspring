/*
 * 主题偏好：cookie 决定服务端渲染的 data-theme，避免首屏闪烁。
 * system 时不写属性，交给 CSS 的 prefers-color-scheme / light-dark()。
 */

export const THEME_COOKIE = "wellspring_theme"

export type ThemeName = "system" | "light" | "dark"

export function parseTheme(value: string | undefined): ThemeName {
    return value === "light" || value === "dark" ? value : "system"
}
