/** Bind an unambiguous NEW actor's model-local id to its sealed host identity.
 * Candidate ids/names are exact source-bound data, not fuzzy name matching.
 * Existing identities, conflicting aliases and all provenance checks stay strict.
 */
import { npcActorId, npcJson, type NpcParallelCandidate } from './npc-parallel.ts';
import type { LiteraryEcologyState } from './literary-ecology.ts';

type RecordValue = Record<string, unknown>;
const record = (v: unknown): v is RecordValue => !!v && typeof v === 'object' && !Array.isArray(v);
const records = (v: unknown): RecordValue[] => Array.isArray(v) ? v.filter(record) : [];

export function bindNewNpcActorIds(raw: string, candidates: NpcParallelCandidate[], previous: LiteraryEcologyState): string {
 const data = npcJson(raw);
 if (!data) return raw;
 const actors = records(data.actors), decisions = records(data.npc_parallel_decisions);
 const reserved = new Set<string>([
  ...previous.actors.flatMap(a => [a.id, a.name]), ...previous.occurrences.map(e => e.id), ...previous.secrets.map(s => s.id),
  ...records(data.occurrences).map(e => e.id), ...records(data.secrets).map(s => s.id),
  ...candidates.flatMap(c => [c.actorId, c.name]), ...actors.map(a => a.name),
 ].filter((v): v is string => typeof v === 'string'));
 // Do not reinterpret a reference already present in the authoritative snapshot.
 for (const event of previous.occurrences) {
  for (const ref of [...event.participants, ...(event.publicSurface?.audience ?? []),
   ...(event.communication ? [event.communication.senderRef, ...event.communication.recipientRefs] : [])]) reserved.add(ref);
 }
 for (const secret of previous.secrets) for (const ref of secret.knownBy) reserved.add(ref);
 for (const actor of previous.actors) for (const knowledge of actor.knowledgeLedger ?? []) {
  reserved.add(knowledge.subjectRef); reserved.add(knowledge.sourceRef);
 }
 const bindings = new Map<string, string>();
 for (const candidate of candidates) {
  if (previous.actors.some(a => a.name === candidate.name || a.id === candidate.actorId) ||
   npcActorId(candidate.name, previous) !== candidate.actorId) continue;
  const matched = decisions.filter(d => d.candidateId === candidate.id);
  const named = actors.filter(a => a.name === candidate.name);
  if (matched.length !== 1 || named.length !== 1) continue;
  const decision = matched[0], actor = named[0], alias = actor.id;
   if (decision.verdict === 'reject' || typeof alias !== 'string' || !alias || alias !== alias.trim() || alias.length > 80 ||
   alias === candidate.actorId || decision.actorId !== alias || reserved.has(alias) || bindings.has(alias) ||
   actors.filter(a => a.id === alias).length !== 1 || actors.some(a => a.id === candidate.actorId) ||
   decisions.filter(d => d.actorId === alias).length !== 1) continue;
  bindings.set(alias, candidate.actorId);
 }
 if (!bindings.size) return raw;
 const bound = structuredClone(data);
 const ref = (v: unknown): unknown => typeof v === 'string' ? bindings.get(v) ?? v : v;
 const refs = (v: unknown): unknown => Array.isArray(v) ? v.map(ref) : v;
 for (const actor of records(bound.actors)) actor.id = ref(actor.id);
 for (const decision of records(bound.npc_parallel_decisions)) {
  const candidate = candidates.find(c => c.id === decision.candidateId);
  if (candidate && bindings.get(String(decision.actorId)) === candidate.actorId) decision.actorId = candidate.actorId;
 }
 for (const event of records(bound.occurrences)) {
  if (Array.isArray(event.participants)) event.participants = refs(event.participants);
  if (record(event.publicSurface) && Array.isArray(event.publicSurface.audience)) event.publicSurface.audience = refs(event.publicSurface.audience);
  if (record(event.communication)) {
   event.communication.senderRef = ref(event.communication.senderRef);
   if (Array.isArray(event.communication.recipientRefs)) event.communication.recipientRefs = refs(event.communication.recipientRefs);
  }
 }
 for (const secret of records(bound.secrets)) if (Array.isArray(secret.knownBy)) secret.knownBy = refs(secret.knownBy);
 // Never replace prose, evidence quotes, event ids, source ids or knowledge refs.
 return JSON.stringify(bound);
}
