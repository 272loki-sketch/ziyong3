import { dispatchGlobalActionOption, parseGlobalActionOptions } from "../../src/regex-options.ts";
import "./regex-options.css";

export interface ActionOptionsCardProps {
	text: string;
	onSelectOption?: (text: string) => void;
	enabled?: boolean;
	hidden?: boolean;
	className?: string;
}

/**
 * Cross-card, display-only action card. It never edits its source text; selections are delegated
 * to the caller's existing composer callback. Call only when no author/card-owned options UI exists.
 */
export function ActionOptionsCard({ text, onSelectOption, enabled = true, hidden = false, className = "" }: ActionOptionsCardProps) {
	const parsed = parseGlobalActionOptions(text);
	if (!enabled || hidden || parsed.status !== "valid") return null;
	return <section className={`global-options-card ${className}`.trim()} aria-label="全局行动选项">
		<header className="global-options-card__header"><span>行动选项</span><small>点击填入输入框</small></header>
		<div className="global-options-card__items">
			{parsed.options.map((option, index) => <button key={`${index}:${option}`} type="button"
				className="global-options-card__item" aria-label={`选择行动：${option}`}
				disabled={!onSelectOption} onClick={() => dispatchGlobalActionOption(option, onSelectOption)}>
				<span aria-hidden="true">{index + 1}</span><span>{option}</span>
			</button>)}
		</div>
	</section>;
}
