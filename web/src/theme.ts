/** Browser-local appearance; never changes session, card, or model configuration. */
export type ThemeMode = "light" | "eye-care" | "dark";

export const THEME_KEY = "liyuan.theme";
export const THEME_EVENT = "liyuan:theme-changed";
export const THEME_CHOICES: ReadonlyArray<{ value: ThemeMode; label: string; description: string; color: string }> = [
	{ value: "light", label: "默认背景", description: "保留现在的白瓷朱砂", color: "#f7f4f0" },
	{ value: "eye-care", label: "护眼模式", description: "柔和浅绿，降低背景亮度", color: "#e8eee2" },
	{ value: "dark", label: "夜晚模式", description: "暖墨深色，适合低光环境", color: "#141110" },
];

export function isThemeMode(value: unknown): value is ThemeMode {
	return value === "light" || value === "eye-care" || value === "dark";
}

function storedTheme(): ThemeMode {
	try {
		const value = localStorage.getItem(THEME_KEY);
		if (isThemeMode(value)) return value;
	} catch { /* A blocked storage must not prevent reading or switching appearance. */ }
	return "light";
}

export function getTheme(): ThemeMode {
	if (typeof document !== "undefined") {
		const current = document.documentElement.getAttribute("data-theme");
		if (isThemeMode(current)) return current;
	}
	return storedTheme();
}

function displayTheme(mode: ThemeMode): void {
	document.documentElement.setAttribute("data-theme", mode);
	const color = THEME_CHOICES.find(choice => choice.value === mode)!.color;
	for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
		// The user's selection takes precedence over the OS colour scheme.
		meta.removeAttribute("media");
		meta.setAttribute("content", color);
	}
	window.dispatchEvent(new Event(THEME_EVENT));
}

export function applyTheme(mode: ThemeMode): void {
	if (!isThemeMode(mode)) throw new Error("无效的背景模式");
	displayTheme(mode);
	try { localStorage.setItem(THEME_KEY, mode); }
	catch { /* The visible selection remains usable for this page. */ }
}

export const setTheme = applyTheme;

let listening = false;
/** Early initialization, including changes made in another same-origin tab. */
export function initTheme(): ThemeMode {
	const mode = storedTheme();
	displayTheme(mode);
	if (!listening) {
		listening = true;
		window.addEventListener("storage", event => {
			if (event.key === THEME_KEY || event.key === null) displayTheme(isThemeMode(event.newValue) ? event.newValue : "light");
		});
	}
	return mode;
}

export function subscribeTheme(listener: () => void): () => void {
	window.addEventListener(THEME_EVENT, listener);
	return () => window.removeEventListener(THEME_EVENT, listener);
}
