import type { ReactNode } from "react";
import "./TurnDossier.css";

export function DossierHeader({ title, domain, meta, digest }: { title: string; domain: string; meta: ReactNode; digest?: string }) {
	return <summary className="turn-dossier-header">
		<span className="turn-dossier-heading"><span className="turn-dossier-domain">{domain}</span><strong>{title}</strong></span>
		<span className="turn-dossier-meta">{meta}</span>
		<span className="turn-dossier-chevron" aria-hidden="true" />
		{digest && <span className="turn-dossier-digest">{digest}</span>}
	</summary>;
}
