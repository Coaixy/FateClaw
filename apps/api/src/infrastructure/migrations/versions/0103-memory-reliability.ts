import type { DatabaseMigration } from '#infrastructure/migrations/types';
import {
  deriveMemorySearchTerms,
  inferMemoryFactKey,
} from '#modules/memory/search-terms';
import { memoryContentHash } from '#modules/memory/domain';
import type { MemoryKind } from '@fateclaw/contracts/memory';

export const memoryReliabilityMigration: DatabaseMigration = {
  id: '0103_memory_reliability',
  description:
    'Preserve authoritative facts, persist recall tags and rotate memory workers across accounts',
  async up(client) {
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query(`
      ALTER TABLE memory_scopes ADD COLUMN last_job_claimed_at timestamptz;
      CREATE INDEX memory_scopes_scheduling ON memory_scopes(last_job_claimed_at,id)
        WHERE parent_scope_id IS NULL;
      ALTER TABLE memory_items ADD COLUMN search_terms text[] NOT NULL DEFAULT '{}';
      DROP INDEX memory_items_active_hash,memory_items_active_fact;
    `);
    let cursor = '';
    for (;;) {
      const { rows } = await client.query<{
        id: string;
        content: string;
        kind: MemoryKind;
        fact_key: string | null;
      }>(
        "SELECT id,content,kind,fact_key FROM memory_items WHERE id>$1 AND status<>'forgotten' ORDER BY id LIMIT 200",
        [cursor],
      );
      if (rows.length) {
        const values = rows.map((row) => {
          const factKey =
            row.fact_key ??
            (row.kind === 'fact'
              ? inferMemoryFactKey(row.content)
              : undefined) ??
            null;
          return {
            id: row.id,
            fact_key: factKey,
            content_hash: memoryContentHash(row.kind, row.content, factKey),
            search_terms: deriveMemorySearchTerms(row.content, factKey),
          };
        });
        await client.query(
          `UPDATE memory_items item SET fact_key=data.fact_key,content_hash=data.content_hash,search_terms=data.search_terms
           FROM jsonb_to_recordset($1::jsonb) AS data(id text,fact_key text,content_hash text,search_terms text[]) WHERE item.id=data.id`,
          [JSON.stringify(values)],
        );
      }
      if (rows.length < 200) break;
      cursor = rows.at(-1)!.id;
    }
    await client.query(`
      WITH ranked AS (
        SELECT id,row_number() OVER(PARTITION BY scope_id,subject_id,fact_key
          ORDER BY (origin IN ('manual','explicit')) DESC,observed_at DESC,source_sequence DESC,id DESC) AS position
        FROM memory_items WHERE status='active' AND fact_key IS NOT NULL
      ) UPDATE memory_items i SET status='disputed',updated_at=clock_timestamp()
        FROM ranked r WHERE i.id=r.id AND r.position>1;
      DELETE FROM memory_index_entries x WHERE x.object_kind='item'
        AND EXISTS(SELECT 1 FROM memory_items i WHERE i.id=x.object_id AND i.status<>'active');
      CREATE UNIQUE INDEX memory_items_active_hash ON memory_items(scope_id,subject_id,content_hash) WHERE status='active';
      CREATE UNIQUE INDEX memory_items_active_fact ON memory_items(scope_id,subject_id,fact_key)
        WHERE status='active' AND fact_key IS NOT NULL;
      UPDATE memory_index_entries x SET search_text=x.search_text||E'\\n'||array_to_string(i.search_terms,' ')
        FROM memory_items i WHERE x.object_kind='item' AND x.object_id=i.id
          AND x.chunk_start=0 AND cardinality(i.search_terms)>0;
    `);
  },
};
