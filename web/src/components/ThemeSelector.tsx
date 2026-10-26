import { useId, useSyncExternalStore } from "react";
import { getTheme, setTheme, subscribeTheme, THEME_CHOICES } from "../theme.ts";

type Toast = (level: "info" | "warning" | "error", text: string) => void;

/** Presentation only: no server request, story mutation, or configuration autosave. */
export function ThemeSelector({ toast }: { toast: Toast }) {
	const name = useId();
	const mode = useSyncExternalStore(subscribeTheme, getTheme, () => "light");
	return <fieldset className="theme-picker">
		<legend>背景选择</legend>
		<div className="theme-picker-options">
			{THEME_CHOICES.map(choice => <label key={choice.value} className={`theme-picker-choice${mode === choice.value ? " is-selected" : ""}`}>
				<input type="radio" name={name} value={choice.value} checked={mode === choice.value} onChange={() => {
					setTheme(choice.value);
					toast("info", `已切换到${choice.label}`);
				}} />
				<span className={`theme-picker-swatch theme-picker-swatch--${choice.value}`} aria-hidden="true" />
				<strong>{choice.label}</strong><span>{choice.description}</span>
			</label>)}
		</div>
		<p className="field-hint">立即生效并记在本机浏览器，不改变会话、角色卡或正文。护眼是配色名称，不代表医疗效果。</p>
	</fieldset>;
}
