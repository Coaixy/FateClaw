# Skill content architecture

## Contract

Skill identity, immutable content, local materialization, and the Pi adapter have separate owners. Shares and subscriptions reference a stable skill ID. Each author save creates a revision and atomically selects it as current. A request selects an authorized revision once and reads that exact revision even if an author saves a newer one.

The server-only `@fateclaw/contracts/skills/content` protocol owns format validation, canonical paths, deterministic checksums, and the format version. PostgreSQL is the canonical content source. Local snapshots are disposable and never synchronize changes back into the database. Existing `version` display strings do not identify a revision or a content format.

`user_custom_skills` owns the skill's identity, author metadata, and current revision pointer. `skill_content_revisions` owns each revision's format, checksum, complete files, and content length. The composite foreign key prevents pointing at a different skill's revision, and the database rejects updates to existing revision rows. An author save inserts its revision and moves its pointer in the same transaction.

The runtime `SkillCatalog` selects authorized revision references, `SkillRevisionReader` retrieves the selected immutable content, `SkillContentCache` materializes it, and the Pi resource loader adapts the snapshot into a readable Markdown skill. Content reads do not require a revision to remain current. Ordinary API list responses select metadata and content length; detail reads supply the full file array.

Each runtime cache namespace belongs to one process on one deployment host. Active request leases prevent eviction. Inactive snapshots expire after seven days or when the runtime exceeds 64 MiB; active snapshots may temporarily exceed that budget. Cache activity reclaims exited owners' namespaces. Use host-local cache directories, because process liveness checks do not coordinate different hosts.

Admin storage summaries distinguish persisted revisions from unresolved legacy imports. List queries return file and revision counts without transferring full content. Detail queries return current files and at most 20 recent revision summaries in the same database snapshot. The UI separates storage state from enablement and visibility, and reports migration reasons without claiming that every runtime cache or regional database replica is current.

## Invariants and validation

- Store complete immutable content revisions separately from `user_custom_skills`; enforce revision ownership at the database pointer.
- Require `base_revision_id` on author updates. Lock the skill, compare the submitted base, and return HTTP 409 for stale edits without mutating metadata or creating a revision. A missing precondition returns HTTP 428. The editor retains its draft on failure.
- Keep one shared content protocol for the API writer and runtime reader. Unknown format versions fail explicitly at the adapter boundary.
- Keep catalog authorization ahead of cache access. The runtime content reader accepts a skill/revision pair and does not require the revision to remain current.
- Separate legacy import from ordinary content reads. Persist import outcomes, retry unresolved entries on startup, and skip completed imports.
- Bound local cache retention and preserve snapshots in active requests. Cache maintenance is best effort; required content reads and writes fail at their recovery boundary.

Acceptance checks use synthetic fixtures and a disposable PostgreSQL server: preserve an old revision across edits and cache loss; reject a stale concurrent save without changing either table; roll back a failed pointer update; reject cross-skill pointers and revision mutations; restore authorized snapshots on another deployment; preserve active snapshots during cache cleanup; retry legacy imports without creating duplicate revisions.

## Boundaries

The first supported format remains a UTF-8 text bundle with `SKILL.md`. Storing a script does not authorize executing it. Additional formats require a protocol implementation and a runtime adapter, without changing skill identity or the cache ownership rules. There is one PostgreSQL storage implementation; database replication remains an operator responsibility.

Completely empty databases cannot infer user ownership or skill identity from orphan local directories. Such recovery requires an explicit import mapping. Old writers must be stopped during upgrade because they cannot maintain revision pointers or enforce save preconditions.
